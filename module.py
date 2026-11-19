import re
import time
import core
import channels.webui.api as webui

MAX_LAYERS = 60
MAX_BAR_LENGTH = 32
MIN_TEMPO = 20
MAX_TEMPO = 300

DRUM_VOICES = ["kick", "snare", "clap", "hihat_closed", "hihat_open", "tom", "rim", "cowbell"]
INSTRUMENTS = ["piano", "bass", "pad", "lead", "pluck", "bells", "sine", "square", "triangle", "saw", "organ", "strings", "synbrass", "flute", "musicbox", "fm"]
BUILTIN_NAMES = set(DRUM_VOICES) | set(INSTRUMENTS)

OSC_TYPES = ["sine", "square", "sawtooth", "triangle"]
WT_TABLES = ["harmonics", "even", "sparse"]
EFFECTS = ["flash", "bloom", "spark", "tick", "laser", "ripple", "wave", "plasma", "aurora", "prism", "strobe"]
DEFAULT_VISUALS = {"kick": "flash", "snare": "ripple"}
FILTER_TYPES = ["lowpass", "highpass", "bandpass"]
SOUND_NAME_RE = re.compile(r"^[a-z][a-z0-9_\-]{0,31}$")

PITCH_RE = re.compile(r"^([A-Ga-g])([#b]?)(-?\d{1,2})$")
NOTE_NAMES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
# lowercase [#b] prefix keeps altered degrees ('b7') distinct from note names ('Bb3').
DEGREE_RE = re.compile(r"^([#b]?)(-?\d{1,2})$")
KEY_RE = re.compile(r"^([A-Ga-g])([#b]?)(\d{1,2})?\s+(.+)$")
METER_RE = re.compile(r"^(\d{1,2})\s*/\s*(\d{1,2})$")
NAME_RE = re.compile(r"^[\w][\w \-]{0,39}$")
SUBDIVISIONS = {
    "4ths": 4,
    "8ths": 8,
    "16ths": 16,
    "32nds": 32,
    "6/8": 6,
    "triplets": 12,
    "shuffle": 12,
    "12/8": 12,
    "triplet-16ths": 24,
    "double-shuffle": 24,
}
SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

SCALES = {
    "major": [0, 2, 4, 5, 7, 9, 11],
    "minor": [0, 2, 3, 5, 7, 8, 10],
    "harmonic minor": [0, 2, 3, 5, 7, 8, 11],
    "melodic minor": [0, 2, 3, 5, 7, 9, 11],
    "harmonic major": [0, 2, 4, 5, 7, 8, 11],
    "major pentatonic": [0, 2, 4, 7, 9],
    "minor pentatonic": [0, 3, 5, 7, 10],
    "blues": [0, 3, 5, 6, 7, 10],
    "whole tone": [0, 2, 4, 6, 8, 10],
    "hirajoshi": [0, 2, 3, 7, 8],
    "octatonic": [0, 2, 3, 5, 6, 8, 9, 11],
}
# Named modes derived from the parent scales by rotation (phrygian dominant,
# lydian dominant, altered, ...). Rotations identical to the parent (whole tone)
# register nothing extra.
MODE_NAMES = {
    "major": ["dorian", "phrygian", "lydian", "mixolydian", "aeolian", "locrian"],
    "harmonic minor": ["locrian natural 6", "ionian augmented", "ukrainian dorian",
                       "phrygian dominant", "lydian sharp 2", "altered dominant"],
    "melodic minor": ["dorian b2", "lydian augmented", "lydian dominant",
                      "mixolydian b6", "locrian sharp 2", "altered"],
}
for _base, _mode_names in MODE_NAMES.items():
    _parent = SCALES[_base]
    for _k, _mode_name in enumerate(_mode_names, start=1):
        _rotated = _parent[_k:] + [x + 12 for x in _parent[:_k]]
        _rotated = [x - _rotated[0] for x in _rotated]
        if _rotated != _parent:
            SCALES[_mode_name] = _rotated
SCALE_ALIASES = {
    "ionian": "major",
    "natural minor": "minor",
    "blues scale": "blues",
    "jazz minor": "melodic minor",
    "super locrian": "altered",
    "ultralocrian": "altered dominant",
    "hijaz": "phrygian dominant",
    "dorian sharp 4": "ukrainian dorian",
    "locrian sharp 9": "locrian sharp 2",
    "ionian sharp 5": "ionian augmented",
}


def _midi_value(pitch):
    if isinstance(pitch, bool):
        return None
    if isinstance(pitch, (int, float)):
        return int(pitch)
    m = PITCH_RE.match(str(pitch).strip())
    if not m:
        return None
    accidental = 1 if m.group(2) == "#" else (-1 if m.group(2) == "b" else 0)
    return (int(m.group(3)) + 1) * 12 + NOTE_NAMES[m.group(1).upper()] + accidental


def _num(value, default, lo, hi):
    try:
        v = float(value)
    except (TypeError, ValueError):
        v = default
    return max(lo, min(hi, v))


def _clean_fm(fm):
    if not isinstance(fm, dict):
        return None, "spec.fm must be a dict."
    ops = fm.get("operators")
    if not isinstance(ops, list) or not ops or len(ops) > 6:
        return None, "spec.fm.operators must be a list of 1 to 6 operator dicts."
    clean_ops = []
    for i, op in enumerate(ops):
        if not isinstance(op, dict):
            return None, f"spec.fm.operators[{i}] must be a dict."
        clean_ops.append({
            "ratio": _num(op.get("ratio"), 1.0, 0.25, 32.0),
            "level": _num(op.get("level"), 0.0, 0.0, 1.0),
            "feedback": _num(op.get("feedback"), 0.0, 0.0, 0.9),
            "attack": _num(op.get("attack"), 0.002, 0.001, 2.0),
            "decay": _num(op.get("decay"), 0.3, 0.005, 4.0),
            "sustain": _num(op.get("sustain"), 0.0, 0.0, 1.0),
            "release": _num(op.get("release"), 0.15, 0.005, 4.0),
        })
    alg = fm.get("algorithm")
    if not isinstance(alg, dict):
        return None, "spec.fm.algorithm must be a dict of operator_index -> list of modulated operator indexes."
    clean_alg = {}
    for k, v in alg.items():
        try:
            src = int(k)
        except (TypeError, ValueError):
            return None, f"spec.fm.algorithm key {k!r} must be an operator index."
        if src < 0 or src >= len(ops):
            return None, f"spec.fm.algorithm references operator {src} out of range."
        if not isinstance(v, list):
            v = [v]
        clean_v = []
        for t in v:
            try:
                dst = int(t)
            except (TypeError, ValueError):
                return None, f"spec.fm.algorithm[{k}] target {t!r} must be an operator index."
            if dst < 0 or dst >= len(ops) or dst == src:
                return None, f"spec.fm.algorithm[{k}] target must be a valid operator index (not {src} itself)."
            clean_v.append(dst)
        clean_alg[src] = clean_v
    out = fm.get("output")
    if not isinstance(out, list) or not out:
        return None, "spec.fm.output must be a non-empty list of carrier operator indexes."
    clean_out = []
    for t in out:
        try:
            dst = int(t)
        except (TypeError, ValueError):
            return None, f"spec.fm.output target {t!r} must be an operator index."
        if dst < 0 or dst >= len(ops):
            return None, f"spec.fm.output references operator {dst} out of range."
        clean_out.append(dst)
    return {"operators": clean_ops, "algorithm": clean_alg, "output": clean_out}, None


def _clean_sound_spec(spec):
    if not isinstance(spec, dict):
        return None, "spec must be a dict."
    fm = None
    if spec.get("fm") is not None:
        fm, err = _clean_fm(spec["fm"])
        if err:
            return None, err
    engine_keys = ("fm", "pd", "ring", "wt", "chip", "grain")
    osc = spec.get("osc")
    has_engine = any(spec.get(e) is not None for e in engine_keys)
    if osc is None and has_engine:
        osc = []
    if not isinstance(osc, list) or len(osc) > 4 or (not osc and not has_engine):
        return None, "spec.osc must be a list of 1 to 4 oscillator layers (empty only when an engine key is set: fm, pd, ring, wt, chip or grain)."
    clean_osc = []
    for i, layer in enumerate(osc):
        if not isinstance(layer, dict):
            return None, f"spec.osc[{i}] must be a dict."
        otype = str(layer.get("type", "")).strip().lower()
        if otype not in OSC_TYPES:
            return None, f"spec.osc[{i}].type must be one of: {', '.join(OSC_TYPES)}."
        clean_osc.append({
            "type": otype,
            "level": _num(layer.get("level"), 1.0, 0.0, 1.0),
            "octave": int(_num(layer.get("octave"), 0, -3, 3)),
            "detune": _num(layer.get("detune"), 0.0, -100.0, 100.0),
        })
    clean = {"osc": clean_osc, "base_note": int(_num(spec.get("base_note"), 36, 12, 127))}
    if fm is not None:
        clean["fm"] = fm

    if spec.get("noise") is not None:
        n = spec["noise"]
        if not isinstance(n, dict):
            return None, "spec.noise must be a dict."
        ntype = str(n.get("filter", "lowpass")).strip().lower()
        if ntype not in FILTER_TYPES:
            return None, f"spec.noise.filter must be one of: {', '.join(FILTER_TYPES)}."
        clean["noise"] = {
            "level": _num(n.get("level"), 0.5, 0.0, 1.0),
            "filter": ntype,
            "freq": _num(n.get("freq"), 2000.0, 20.0, 20000.0),
        }

    if spec.get("filter") is not None:
        f = spec["filter"]
        if not isinstance(f, dict):
            return None, "spec.filter must be a dict."
        ftype = str(f.get("type", "lowpass")).strip().lower()
        if ftype not in FILTER_TYPES:
            return None, f"spec.filter.type must be one of: {', '.join(FILTER_TYPES)}."
        clean["filter"] = {
            "type": ftype,
            "cutoff": _num(f.get("cutoff"), 8000.0, 20.0, 20000.0),
            "q": _num(f.get("q"), 1.0, 0.0001, 30.0),
            "env": _num(f.get("env"), 0.0, -48.0, 48.0),
            "env_time": _num(f.get("env_time"), 0.2, 0.01, 2.0),
        }

    if spec.get("env") is not None:
        e = spec["env"]
        if not isinstance(e, dict):
            return None, "spec.env must be a dict."
        clean["env"] = {
            "attack": _num(e.get("attack"), 0.005, 0.001, 2.0),
            "decay": _num(e.get("decay"), 0.3, 0.005, 4.0),
            "sustain": _num(e.get("sustain"), 0.0, 0.0, 1.0),
            "release": _num(e.get("release"), 0.15, 0.005, 4.0),
        }

    if spec.get("pitch") is not None:
        p = spec["pitch"]
        if not isinstance(p, dict):
            return None, "spec.pitch must be a dict."
        clean["pitch"] = {
            "glide": _num(p.get("glide"), 0.0, -36.0, 36.0),
            "glide_time": _num(p.get("glide_time"), 0.12, 0.005, 1.0),
        }

    if spec.get("pd") is not None:
        p = spec["pd"]
        if not isinstance(p, dict):
            return None, "spec.pd must be a dict."
        clean["pd"] = {
            "shape": _num(p.get("shape"), 0.12, 0.02, 0.98),
            "shape_end": _num(p.get("shape_end"), 0.5, 0.02, 0.98),
            "decay": _num(p.get("decay"), 0.25, 0.01, 4.0),
        }

    if spec.get("ring") is not None:
        r = spec["ring"]
        if not isinstance(r, dict):
            return None, "spec.ring must be a dict."
        clean["ring"] = {
            "ratio": _num(r.get("ratio"), 1.5, 0.05, 32.0),
            "freq": _num(r.get("freq"), 0.0, 0.0, 20000.0),
        }

    if spec.get("wt") is not None:
        w = spec["wt"]
        if not isinstance(w, dict):
            return None, "spec.wt must be a dict."
        table = str(w.get("table", "harmonics")).strip().lower()
        if table not in WT_TABLES:
            return None, f"spec.wt.table must be one of: {', '.join(WT_TABLES)}."
        clean["wt"] = {
            "table": table,
            "pos_start": _num(w.get("pos_start"), 0.05, 0.0, 1.0),
            "pos_end": _num(w.get("pos_end"), 0.9, 0.0, 1.0),
            "steps": int(_num(w.get("steps"), 8, 1, 24)),
            "pos_time": _num(w.get("pos_time"), 0.4, 0.01, 4.0),
        }

    if spec.get("chip") is not None:
        c = spec["chip"]
        if not isinstance(c, dict):
            return None, "spec.chip must be a dict."
        arp = c.get("arp")
        if arp is None:
            arp = []
        if not isinstance(arp, list) or len(arp) > 8:
            return None, "spec.chip.arp must be a list of up to 8 semitone offsets."
        chip = {
            "duty": _num(c.get("duty"), 0.5, 0.03, 0.5),
            "arp": [_num(x, 0.0, -48.0, 48.0) for x in arp],
            "arp_rate": _num(c.get("arp_rate"), 25.0, 1.0, 100.0),
        }
        if c.get("duty_end") is not None:
            chip["duty_end"] = _num(c.get("duty_end"), chip["duty"], 0.03, 0.5)
        clean["chip"] = chip

    if spec.get("grain") is not None:
        g = spec["grain"]
        if not isinstance(g, dict):
            return None, "spec.grain must be a dict."
        src = str(g.get("src", "sine")).strip().lower()
        if src not in ("sine", "noise"):
            return None, "spec.grain.src must be sine or noise."
        clean["grain"] = {
            "size": _num(g.get("size"), 0.08, 0.01, 1.0),
            "rate": _num(g.get("rate"), 14.0, 1.0, 80.0),
            "scatter": _num(g.get("scatter"), 0.015, 0.0, 0.2),
            "src": src,
        }
    return clean, None


def _velocity(value, default):
    try:
        v = float(value)
    except (TypeError, ValueError):
        v = default
    if v > 1.0:
        v = v / 127.0
    return max(0.0, min(1.0, v))


def _step_velocity(ch):
    """Velocity of one drum bar-string character; None when invalid."""
    if ch in (".", "-", "_", "0", " "):
        return 0.0
    if ch in ("x", "X"):
        return 1.0
    if "1" <= ch <= "9":
        return int(ch) / 9.0
    return None

def _norm_name(name):
    """Normalized loop key: lowercase with collapsed whitespace; '' when invalid."""
    cleaned = re.sub(r"\s+", " ", str(name or "")).strip().lower()
    if not cleaned or len(cleaned) > 40 or not NAME_RE.match(cleaned):
        return ""
    return cleaned



def _parse_meter(signature):
    """Parse 'N/M' into (steps_per_bar, normalized, error) on the 16th-note grid."""
    m = METER_RE.match(str(signature or "").strip())
    if not m:
        return None, "", "signature must look like '3/4', '6/8' or '7/16'."
    num, den = int(m.group(1)), int(m.group(2))
    if den not in (1, 2, 4, 8, 16):
        return None, "", "Denominator must be 1, 2, 4, 8 or 16."
    if num < 1 or num > 32:
        return None, "", "Numerator must be between 1 and 32."
    return num * (16 // den), f"{num}/{den}", None

def _parse_key(key):
    """Parse 'root + scale' (e.g. 'A minor', 'F#3 dorian') into (root_midi, scale, scale_name, error)."""
    raw = str(key or "").strip()
    if not raw:
        raw = "C major"
    m = KEY_RE.match(raw)
    if not m:
        return None, None, "", "key must be a root note plus a scale name, e.g. 'A minor', 'F# dorian', 'C3 major pentatonic'."
    name = re.sub(r"[\s_-]+", " ", m.group(4).strip().lower())
    name = SCALE_ALIASES.get(name, name)
    scale = SCALES.get(name)
    if scale is None:
        return None, None, "", f"Unknown scale '{m.group(4)}'. Options: {', '.join(sorted(SCALES))}."
    octave = int(m.group(3)) if m.group(3) else 4
    if octave < 0 or octave > 8:
        return None, None, "", "Root octave in key must be between 0 and 8."
    accidental = 1 if m.group(2) == "#" else (-1 if m.group(2) == "b" else 0)
    root = (octave + 1) * 12 + NOTE_NAMES[m.group(1).upper()] + accidental
    return root, scale, name, None


def _resolve_pitch(value, root_midi, scale):
    """Scale degree (int, or '#4'/'b7' string) or absolute note name to a MIDI number; None when invalid."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        octave, idx = divmod(value - 1, len(scale))
        return root_midi + octave * 12 + scale[idx]
    m = DEGREE_RE.match(str(value).strip())
    if m:
        octave, idx = divmod(int(m.group(2)) - 1, len(scale))
        alteration = 1 if m.group(1) == "#" else (-1 if m.group(1) == "b" else 0)
        return root_midi + octave * 12 + scale[idx] + alteration
    return _midi_value(value)

class MusicSequencerModule(core.module.Module):
    """
    Provides the AI with a full-blown music sequencer, letting your AI create loops that you can start/stop, create custom synthesizers, and arrange the loops you've created into a song. Does not need a seperate AI model. Comes with GLSL shader-based visual effects for a lightshow, right in your browser!
    """

    category = "Music"

    settings = {
        "default_tempo": {
            "type": "number",
            "description": "Tempo in BPM that a browser's shared transport starts at.",
            "default": 120,
        },
        "master_volume": {
            "type": "percentage",
            "description": "Master volume for all loop layers.",
            "default": 80,
        },
    }

    async def on_ready(self):
        self.data = core.storage.StorageDict("music_sequencer", type="json")
        if "loops" not in self.data:
            self.data["loops"] = {}
        if "tempo" not in self.data:
            self.data["tempo"] = {}
        if "meter" not in self.data:
            self.data["meter"] = {}
        if "songs" not in self.data:
            self.data["songs"] = {}
        if "sounds" not in self.data:
            self.data["sounds"] = {}
        if "visuals" not in self.data:
            self.data["visuals"] = {}
        self.data.save()

    def _chat_id(self):
        try:
            cid = self.channel.context.chat.get("id")
            return str(cid) if cid else None
        except Exception:
            return None

    def _loops(self, chat_id):
        return self.data.get("loops", {}).get(str(chat_id), {})

    def _store_loops(self, chat_id, loops):
        all_loops = dict(self.data.get("loops", {}))
        all_loops[str(chat_id)] = loops
        self.data["loops"] = all_loops
        self.data.save()

    def _sounds(self, chat_id):
        return self.data.get("sounds", {}).get(str(chat_id), {})

    def _store_sounds(self, chat_id, sounds):
        all_sounds = dict(self.data.get("sounds", {}))
        all_sounds[str(chat_id)] = sounds
        self.data["sounds"] = all_sounds
        self.data.save()

    def _visuals(self, chat_id):
        return self.data.get("visuals", {}).get(str(chat_id), {})

    def _store_visuals(self, chat_id, visuals):
        all_visuals = dict(self.data.get("visuals", {}))
        all_visuals[str(chat_id)] = visuals
        self.data["visuals"] = all_visuals
        self.data.save()

    def _tempo(self, chat_id):
        try:
            bpm = float(self.data.get("tempo", {}).get(str(chat_id), self.config.get("default_tempo", 120)))
        except (TypeError, ValueError):
            bpm = 120
        return max(MIN_TEMPO, min(MAX_TEMPO, bpm))

    def _meter(self, chat_id):
        steps, _, _ = _parse_meter(self.data.get("meter", {}).get(str(chat_id), "4/4"))
        return steps if steps else 16

    def _meter_name(self, chat_id):
        return self.data.get("meter", {}).get(str(chat_id), "4/4")

    async def _push(self, chat_id, frame):
        ws = getattr(getattr(self, "channel", None), "websocket_manager", None)
        if not ws or not chat_id:
            return
        frame["chat"] = str(chat_id)
        try:
            await ws.broadcast(frame)
        except Exception:
            pass

    def _playing_count(self, chat_id):
        return sum(1 for d in self._loops(chat_id).values() if d.get("playing"))

    def _resolve_subdivision(self, subdivision, chat_id):
        sub = str(subdivision or "").strip().lower().replace(" ", "-")
        if not sub:
            return self._meter(chat_id), None
        steps = SUBDIVISIONS.get(sub)
        if steps is None:
            return None, f"Unknown subdivision '{subdivision}'. Presets: {', '.join(sorted(SUBDIVISIONS))}, or '' for the meter grid."
        return steps, None

    def _song(self, chat_id):
        return self.data.get("songs", {}).get(str(chat_id))

    def _store_song(self, chat_id, song):
        all_songs = dict(self.data.get("songs", {}))
        if song is None:
            all_songs.pop(str(chat_id), None)
        else:
            all_songs[str(chat_id)] = song
        self.data["songs"] = all_songs
        self.data.save()

    def _song_busy(self, chat_id):
        song = self._song(chat_id)
        return bool(song and song.get("playing"))

    def _song_position_bars(self, song):
        anchor = song.get("anchor") or {}
        try:
            bpm = float(anchor.get("bpm", 120))
            msteps = int(anchor.get("meter_steps", 16))
            epoch = float(anchor.get("epoch_ms", 0))
        except (TypeError, ValueError):
            return 0.0
        bar_ms = msteps * (60000.0 / bpm / 4.0)
        if bar_ms <= 0:
            return 0.0
        return max(0.0, (time.time() * 1000.0 - epoch) / bar_ms)

    # -------------------------
    #   AI TOOLS
    # -------------------------

    @core.module.tool
    async def play_drum_pattern(self, name: str, steps: list, bar_length: int = 1, subdivision: str = "", voice: str = "kick", volume: float = 1.0):
        """
        Launches a named drum loop on the shared transport, joining at the next
        restart of the longest playing loop so it lands aligned with the other
        layers rather than mid-phrase. Patterns use compact bar
        strings: one character per grid cell (see subdivision; 16 per bar on
        the default 4/4 grid). All loops share one tempo and bar grid, so any
        bar lengths stay in sync: a 2-bar loop cycles twice while a 4-bar
        loop plays once.

        Args:
            name: Unique name for this loop (letters, digits, spaces, '-' or '_', max 40 chars), e.g. 'kick groove'. Used by song arrangement and the loop control tools; duplicates are rejected.
            steps: Bar string(s): digits 1-9 set the hit velocity (9 = full), x = 1.0, '.'/'-'/'_'/'0' = rest. Don't stress about exact length: spaces and '|' are stripped, so group cells in readable chunks of 4 (e.g. "x...|x...|x...|x..5"). Whatever remains is tiled (repeated, then cut at the bar boundary) to exactly fill bar_length bars - a short pattern repeats, a long one truncates, and the result says so. E.g. ["x...x...x...x...", "x...x...x...5..x"] for 2 bars, or "x..5x...x..5x..." for one, or even "x..." for a kick on each quarter.
            bar_length: Length of the loop in bars (1-32). The pattern repeats every bar_length bars.
            subdivision: Cells per bar: '' = the chat meter's 16th grid (16 in 4/4); presets: 4ths, 8ths, 16ths, 32nds, 6/8, triplets (=12, shuffle feel), 12/8, triplet-16ths (=24), double-shuffle. Bars are always meter-long in real time; subdivision only picks how finely each bar is cut.
            voice: Drum voice: kick, snare, clap, hihat_closed, hihat_open, tom, rim, cowbell, or any custom sound name from define_sound.
            volume: Layer volume 0.0-1.0.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        if self._song_busy(chat_id):
            return self.result("A song is playing - call stop_song first to use free loop mode.", success=False)
        loop_id = _norm_name(name)
        if not loop_id:
            return self.result("name is required: 1-40 chars of letters, digits, spaces, '-' or '_'.", success=False)
        if loop_id in self._loops(chat_id):
            return self.result(f"A loop named '{loop_id}' already exists. remove_loop it first, or pick another name.", success=False)
        voice = str(voice).strip().lower()
        if voice not in DRUM_VOICES and voice not in self._sounds(chat_id):
            custom = ", ".join(sorted(self._sounds(chat_id))) or "none defined"
            return self.result(f"Unknown drum voice '{voice}'. Built-in: {', '.join(DRUM_VOICES)}. Custom: {custom}.", success=False)
        try:
            bars = int(bar_length)
        except (TypeError, ValueError):
            return self.result("bar_length must be an integer.", success=False)
        if bars < 1 or bars > MAX_BAR_LENGTH:
            return self.result(f"bar_length must be between 1 and {MAX_BAR_LENGTH}.", success=False)
        if isinstance(steps, str):
            steps = [steps]
        if not isinstance(steps, list) or not steps:
            return self.result("steps must be a bar string, or a list of bar strings.", success=False)
        if self._playing_count(chat_id) >= MAX_LAYERS:
            return self.result(f"Cannot start: {MAX_LAYERS} layers are already playing. Stop one first.", success=False)

        spb, sub_err = self._resolve_subdivision(subdivision, chat_id)
        if sub_err:
            return self.result(sub_err, success=False)
        # forgiving intake: join every given string, drop grouping chars, tile
        # (repeat + truncate) to exactly bar_length * cells-per-bar.
        raw = re.sub(r"[ |]", "", "".join(str(s) for s in steps))
        if not raw:
            return self.result("steps is empty after stripping grouping characters.", success=False)
        pattern = []
        for ch in raw:
            v = _step_velocity(ch)
            if v is None:
                return self.result(f"Invalid character {ch!r} in steps; use 1-9, x, '.', '-', '_' or '0'.", success=False)
            pattern.append(v)
        target = bars * spb
        tiled = len(pattern) != target
        pattern = (pattern * (target // len(pattern) + 1))[:target]

        definition = {
            "kind": "drum",
            "voice": voice,
            "bar_length": bars,
            "steps_per_bar": spb,
            "steps": pattern,
            "volume": _velocity(volume, 1.0),
            "playing": True,
        }
        loops = dict(self._loops(chat_id))
        loops[loop_id] = definition
        self._store_loops(chat_id, loops)
        await self._push(chat_id, {"type": "music_sequencer:play", "loop": dict(definition, id=loop_id)})
        note = f" Pattern was {len(raw)} cells; tiled/repeat-truncated to {target}." if tiled else ""
        return self.result(
            f"Started {voice} drum loop '{loop_id}' ({bars} bar{'s' if bars > 1 else ''}, "
            f"{self._playing_count(chat_id)}/{MAX_LAYERS} layers live).{note}",
            success=True,
        )

    @core.module.tool
    async def play_note_pattern(self, name: str, notes: list, bar_length: int = 1, subdivision: str = "", instrument: str = "piano", volume: float = 1.0, key: str = "C major"):
        """
        Launches a named piano-roll melody loop on the shared transport,
        joining at the next restart of the longest playing loop so its
        phrasing stays aligned with the other layers.
        All loops share one tempo and bar grid, so any bar lengths stay in
        sync. Timing counts grid cells (see subdivision): on the default 4/4
        grid a bar holds 16 cells, so a 4-bar loop spans steps 0-63.

        Args:
            name: Unique name for this loop (letters, digits, spaces, '-' or '_', max 40 chars), e.g. 'main melody'. Used by song arrangement and the loop control tools; duplicates are rejected.
            notes: List of notes as short lists: [pitch, start, length?, velocity?]. Write pitches as SCALE DEGREES (the default way to compose here): 1 = tonic of the key, 2-7 the following degrees, 8 = tonic an octave up, 0 = one octave down, wrapping over any scale length (degree 6 in a pentatonic = octave tonic); '#4'/'b7' alter a degree chromatically. Always use degrees unless a deliberately off-scale riff is wanted - absolute note names ('C4', 'F#5', 'Bb2') are accepted for those (note: a lowercase '#'/'b' prefix makes it a degree, so 'b7' = flat seventh degree while 'Bb3' = a note). start/length are grid-step counts (length defaults to 4); a start outside the loop wraps around (start mod loop length), and lengths are clamped - no exact counting needed. velocity 0.0-1.0 (default 0.8). Visual cues are bound per instrument with set_visual, not per note. E.g. over key="A minor": [["1", 0, 8], ["3", 8], ["5", 12, 4, 0.7]] plays A C E.
            bar_length: Length of the loop in bars (1-32). The roll repeats every bar_length bars.
            subdivision: Cells per bar: '' = the chat meter's 16th grid (16 in 4/4); presets: 4ths, 8ths, 16ths, 32nds, 6/8, triplets (=12, shuffle feel), 12/8, triplet-16ths (=24), double-shuffle. Bars are always meter-long in real time; subdivision only picks how finely each bar is cut. On 'triplets' a bar is 12 cells, so a beat spans 3 cells.
            instrument: Timbre: piano, bass, pad, lead, pluck, bells, sine, square, triangle, saw, organ, strings, synbrass, flute, musicbox, or any custom sound name from define_sound.
            volume: Layer volume 0.0-1.0.
            key: Scale of the loop as root note + scale name; the root may carry an octave (default 4). E.g. "A minor", "F# dorian", "C3 major pentatonic". Common: major, minor, harmonic/melodic minor, harmonic major, dorian, phrygian, lydian, mixolydian, locrian, whole tone, hirajoshi, octatonic, major/minor pentatonic, blues - plus every derived mode (phrygian dominant, lydian dominant, altered, ukrainian dorian, ...). An invalid name returns the full list of options.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        if self._song_busy(chat_id):
            return self.result("A song is playing - call stop_song first to use free loop mode.", success=False)
        loop_id = _norm_name(name)
        if not loop_id:
            return self.result("name is required: 1-40 chars of letters, digits, spaces, '-' or '_'.", success=False)
        if loop_id in self._loops(chat_id):
            return self.result(f"A loop named '{loop_id}' already exists. remove_loop it first, or pick another name.", success=False)
        instrument = str(instrument).strip().lower()
        if instrument not in INSTRUMENTS and instrument not in self._sounds(chat_id):
            custom = ", ".join(sorted(self._sounds(chat_id))) or "none defined"
            return self.result(f"Unknown instrument '{instrument}'. Built-in: {', '.join(INSTRUMENTS)}. Custom: {custom}.", success=False)
        try:
            bars = int(bar_length)
        except (TypeError, ValueError):
            return self.result("bar_length must be an integer.", success=False)
        if bars < 1 or bars > MAX_BAR_LENGTH:
            return self.result(f"bar_length must be between 1 and {MAX_BAR_LENGTH}.", success=False)
        if not isinstance(notes, list) or not notes:
            return self.result("notes must be a non-empty list of [pitch, start, length?, velocity?] lists.", success=False)
        if len(notes) > 512:
            return self.result("Too many notes (max 512 per loop).", success=False)
        if self._playing_count(chat_id) >= MAX_LAYERS:
            return self.result(f"Cannot start: {MAX_LAYERS} layers are already playing. Stop one first.", success=False)
        root_midi, scale, scale_name, key_err = _parse_key(key)
        if key_err:
            return self.result(key_err, success=False)

        spb, sub_err = self._resolve_subdivision(subdivision, chat_id)
        if sub_err:
            return self.result(sub_err, success=False)
        grid = bars * spb
        clean_notes = []
        wrapped = 0
        for i, n in enumerate(notes):
            if not isinstance(n, list) or len(n) < 2 or len(n) > 4:
                return self.result(f"Note {i} must be a list: [pitch, start, length?, velocity?].", success=False)
            midi = _resolve_pitch(n[0], root_midi, scale)
            if midi is None or midi < 12 or midi > 127:
                return self.result(f"Note {i} has an invalid pitch ({n[0]!r}). Use a scale degree (1, 3, '#4', 'b7') or a note name like C4.", success=False)
            try:
                start = int(n[1])
                length = int(n[2]) if len(n) > 2 else 4
            except (TypeError, ValueError):
                return self.result(f"Note {i} has non-integer start/length.", success=False)
            # forgiving intake: starts outside the loop wrap into it (a step
            # past the end lands at the same phase next cycle), lengths clamp.
            if start < 0 or start >= grid:
                wrapped += 1
                start = start % grid
            length = max(1, length)
            clean_notes.append({
                "pitch": midi,
                "start": start,
                "length": min(length, grid - start),
                "velocity": _velocity(n[3], 0.8) if len(n) > 3 else 0.8,
            })

        definition = {
            "kind": "note",
            "instrument": instrument,
            "bar_length": bars,
            "steps_per_bar": spb,
            "key": f"{SHARP_NAMES[root_midi % 12]}{root_midi // 12 - 1} {scale_name}",
            "notes": clean_notes,
            "volume": _velocity(volume, 1.0),
            "playing": True,
        }
        loops = dict(self._loops(chat_id))
        loops[loop_id] = definition
        self._store_loops(chat_id, loops)
        await self._push(chat_id, {"type": "music_sequencer:play", "loop": dict(definition, id=loop_id)})
        note = f" {wrapped} note(s) started outside the loop and wrapped to step start mod {grid}." if wrapped else ""
        return self.result(
            f"Started {instrument} melody loop '{loop_id}' ({len(clean_notes)} notes, {bars} bar{'s' if bars > 1 else ''}, "
            f"{self._playing_count(chat_id)}/{MAX_LAYERS} layers live).{note}",
            success=True,
        )

    @core.module.tool
    async def stop_loop(self, name: str):
        """
        Stops a running loop by its name (the pattern stays known and can be
        restarted with start_loop). Silences nothing else.

        Args:
            name: The loop's name, as given to play_drum_pattern/play_note_pattern.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        if self._song_busy(chat_id):
            return self.result("A song is playing - call stop_song first to use free loop mode.", success=False)
        loop_id = _norm_name(name)
        loops = self._loops(chat_id)
        definition = loops.get(loop_id)
        if not definition:
            return self.result(f"No loop named '{name}' in this chat.", success=False)
        if not definition.get("playing"):
            return self.result(f"Loop '{loop_id}' is already stopped.", success=False)
        loops = dict(loops)
        loops[loop_id] = dict(definition, playing=False)
        self._store_loops(chat_id, loops)
        await self._push(chat_id, {"type": "music_sequencer:stop", "id": loop_id})
        return self.result(f"Stopped loop '{name}'.", success=True)

    @core.module.tool
    async def start_loop(self, name: str):
        """
        (Re)starts a loop by its name. It joins the shared transport at the
        next restart of the longest playing loop, in sync with everything
        else already playing. Works on loops stopped earlier with stop_loop;
        restarting a live loop has no effect.

        Args:
            name: The loop's name, as given to play_drum_pattern/play_note_pattern.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        if self._song_busy(chat_id):
            return self.result("A song is playing - call stop_song first to use free loop mode.", success=False)
        loop_id = _norm_name(name)
        loops = self._loops(chat_id)
        definition = loops.get(loop_id)
        if not definition:
            return self.result(f"No loop named '{name}' in this chat.", success=False)
        if definition.get("playing"):
            return self.result(f"Loop '{loop_id}' is already playing.", success=False)
        if self._playing_count(chat_id) >= MAX_LAYERS:
            return self.result(f"Cannot start: {MAX_LAYERS} layers are already playing. Stop one first.", success=False)
        loops = dict(loops)
        loops[loop_id] = dict(definition, playing=True)
        self._store_loops(chat_id, loops)
        await self._push(chat_id, {"type": "music_sequencer:play", "loop": dict(definition, id=loop_id)})
        return self.result(f"Restarted loop '{name}', joining at the next cycle boundary.", success=True)

    @core.module.tool
    async def remove_loop(self, name: str):
        """
        Deletes a loop entirely (stops it if playing, forgets the pattern).

        Args:
            name: The loop's name, as given to play_drum_pattern/play_note_pattern.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        loop_id = _norm_name(name)
        loops = self._loops(chat_id)
        if loop_id not in loops:
            return self.result(f"No loop named '{name}' in this chat.", success=False)
        song = self._song(chat_id)
        if song and song.get("playing"):
            for s in song.get("sections", []):
                if any(l.get("name") == loop_id for l in s.get("layers", [])):
                    return self.result(f"Loop '{loop_id}' is used by the playing song '{song.get('title')}' - stop_song first.", success=False)
        was_playing = bool(loops[loop_id].get("playing"))
        loops = dict(loops)
        loops.pop(loop_id)
        self._store_loops(chat_id, loops)
        if was_playing:
            await self._push(chat_id, {"type": "music_sequencer:stop", "id": loop_id})
        return self.result(f"Removed loop '{loop_id}'.", success=True)

    @core.module.tool
    async def set_tempo(self, bpm: float):
        """
        Sets the tempo of the chat's shared transport. Every playing loop stays
        in sync through the change (they all ride one grid).

        Args:
            bpm: New tempo in beats per minute (20-300).
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        try:
            tempo = float(bpm)
        except (TypeError, ValueError):
            return self.result("bpm must be a number.", success=False)
        if tempo < MIN_TEMPO or tempo > MAX_TEMPO:
            return self.result(f"bpm must be between {MIN_TEMPO} and {MAX_TEMPO}.", success=False)
        all_tempos = dict(self.data.get("tempo", {}))
        all_tempos[str(chat_id)] = tempo
        self.data["tempo"] = all_tempos
        self.data.save()
        song = self._song(chat_id)
        if song and song.get("playing"):
            pos = self._song_position_bars(song)
            anchor = dict(song.get("anchor") or {})
            anchor["bpm"] = tempo
            anchor["epoch_ms"] = time.time() * 1000.0 - pos * (int(anchor.get("meter_steps", 16)) * (60000.0 / tempo / 4.0))
            self._store_song(chat_id, dict(song, anchor=anchor))
        await self._push(chat_id, {"type": "music_sequencer:tempo", "bpm": tempo})
        return self.result(f"Tempo set to {tempo:g} BPM.", success=True)

    @core.module.tool
    async def set_time_signature(self, signature: str):
        """
        Sets the chat's meter. New loops author their patterns to it (each loop
        remembers its own bar length, so playing loops keep feeling unchanged
        and mixed-meter layers can even coexist on one grid).

        Args:
            signature: Time signature like '3/4', '6/8', '5/4' or '7/16'. Numerator 1-32; denominator 1, 2, 4, 8 or 16. 4/4 = 16 sixteenth-note steps per bar.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        steps, norm, err = _parse_meter(signature)
        if err:
            return self.result(err, success=False)
        all_meters = dict(self.data.get("meter", {}))
        all_meters[str(chat_id)] = norm
        self.data["meter"] = all_meters
        self.data.save()
        await self._push(chat_id, {"type": "music_sequencer:meter", "signature": norm, "steps": steps})
        return self.result(f"Meter set to {norm} ({steps} sixteenth-note steps per bar) for new loops.", success=True)


    @core.module.tool
    async def list_loops(self):
        """
        Lists this chat's loop layers: IDs, kind, voice/instrument, bar length,
        volume, and whether each one is currently playing.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        loops = self._loops(chat_id)
        summary = []
        for loop_id, d in loops.items():
            entry = {
                "id": loop_id,
                "kind": d.get("kind"),
                "voice_or_instrument": d.get("voice") or d.get("instrument"),
                "bar_length": d.get("bar_length"),
                "steps_per_bar": d.get("steps_per_bar", 16),
                "volume": d.get("volume"),
                "playing": bool(d.get("playing")),
            }
            if d.get("kind") == "note":
                entry["note_count"] = len(d.get("notes", []))
                entry["key"] = d.get("key")
            summary.append(entry)
        return self.result({
            "tempo": self._tempo(chat_id),
            "meter": self._meter_name(chat_id),
            "layers_playing": self._playing_count(chat_id),
            "max_layers": MAX_LAYERS,
            "loops": summary,
        }, success=True)

    @core.module.tool
    async def stop_all_loops(self):
        """
        Silences every playing loop layer in this chat at once. Patterns stay
        known and can be restarted individually with start_loop.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        if self._song_busy(chat_id):
            return self.result("A song is playing - call stop_song instead to end it.", success=False)
        if not self._playing_count(chat_id):
            return self.result("Nothing is playing.", success=False)
        loops = {lid: dict(d, playing=False) for lid, d in self._loops(chat_id).items()}
        self._store_loops(chat_id, loops)
        await self._push(chat_id, {"type": "music_sequencer:stop_all"})
        return self.result("Stopped all loops.", success=True)

    @core.module.tool
    async def start_song(self, title: str, sections: list, loop: bool = False):
        """
        Arranges the chat's named loops into a full song and plays it. Stops
        all free-running loops first; while a song plays, the loop tools are
        rejected (stop_song to return to free mode). The arrangement then
        plays unattended: each section switches its layers on/off exactly at
        bar boundaries, with optional per-layer volume. Loops must already be
        defined with the pattern tools.

        Args:
            title: Song name for display.
            sections: Ordered arrangement; each {name?, bars, layers}. bars: 1-64 meter bars. layers: loops active in that section - each entry a loop name, or {"loop": name, "volume": 0.0-1.0}; an empty list is a break. Max 512 bars total. E.g. [{"name": "intro", "bars": 4, "layers": ["pad"]}, {"name": "verse", "bars": 8, "layers": ["pad", "kick groove", {"loop": "bassline", "volume": 0.7}]}, {"name": "chorus", "bars": 8, "layers": ["pad", "kick groove", "bassline", "lead melody"]}]
            loop: Repeat the arrangement forever instead of ending after the final section.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        if not isinstance(sections, list) or not sections:
            return self.result("sections must be a non-empty list of {name?, bars, layers}.", success=False)
        loops = self._loops(chat_id)
        clean_sections = []
        total = 0
        for i, s in enumerate(sections):
            if not isinstance(s, dict):
                return self.result(f"Section {i} must be a dict: {{name?, bars, layers}}.", success=False)
            try:
                bars = int(s.get("bars"))
            except (TypeError, ValueError):
                return self.result(f"Section {i} needs an integer 'bars'.", success=False)
            if bars < 1 or bars > 64:
                return self.result(f"Section {i}: bars must be between 1 and 64.", success=False)
            total += bars
            if total > 512:
                return self.result("Song too long: max 512 bars total.", success=False)
            raw_layers = s.get("layers") or []
            if isinstance(raw_layers, str):
                raw_layers = [raw_layers]
            clean_layers = []
            for l in raw_layers:
                lname = _norm_name(l.get("loop") if isinstance(l, dict) else l)
                if not lname:
                    return self.result(f"Section {i} has an invalid layer name.", success=False)
                if lname not in loops:
                    avail = ", ".join(sorted(loops)) or "none defined"
                    return self.result(f"Section {i} references unknown loop '{lname}'. Available: {avail}.", success=False)
                clean_layers.append({"name": lname, "volume": _velocity(l.get("volume", 1.0), 1.0) if isinstance(l, dict) else 1.0})
            clean_sections.append({"name": str(s.get("name") or "").strip() or f"Part {i + 1}", "bars": bars, "layers": clean_layers})
        self._store_loops(chat_id, {lid: dict(d, playing=False) for lid, d in loops.items()})
        await self._push(chat_id, {"type": "music_sequencer:stop_all"})
        # stop_all is a hard cut frontend-side: anything scheduled and not yet
        # sounded is dropped, so start the song on a fresh bar (gateSong waits
        # for the next boundary anyway).
        song = {
            "title": str(title or "").strip()[:60] or "Untitled",
            "loop": bool(loop),
            "playing": True,
            "total_bars": total,
            "sections": clean_sections,
            "anchor": {"epoch_ms": time.time() * 1000.0, "bpm": self._tempo(chat_id), "meter_steps": self._meter(chat_id)},
        }
        self._store_song(chat_id, song)
        await self._push(chat_id, {"type": "music_sequencer:song", "song": dict(song)})
        bar_sec = self._meter(chat_id) * (60.0 / self._tempo(chat_id) / 4.0)
        plan = " / ".join(f"{s['name']} ({s['bars']})" for s in clean_sections)
        return self.result(f"Song '{song['title']}' started: {total} bars ~{total * bar_sec:.0f}s at {self._tempo(chat_id):g} BPM {self._meter_name(chat_id)} - {plan}.", success=True)

    @core.module.tool
    async def stop_song(self):
        """
        Stops the playing song (all its layers fall silent) and returns the
        chat to free loop mode. The arrangement stays defined; start_song
        again to replay it from the top.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        song = self._song(chat_id)
        if not song:
            return self.result("No song defined for this chat.", success=False)
        if not song.get("playing"):
            return self.result("The song is not playing.", success=False)
        self._store_song(chat_id, dict(song, playing=False))
        self._store_loops(chat_id, {lid: dict(d, playing=False) for lid, d in self._loops(chat_id).items()})
        await self._push(chat_id, {"type": "music_sequencer:stop_song"})
        return self.result(f"Song '{song.get('title')}' stopped. Free loop mode is available again.", success=True)

    @core.module.tool
    async def song_status(self):
        """
        Shows the current song: title, the section map, where the song is
        right now (section, bar within song), remaining time and loop flag.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        song = self._song(chat_id)
        if not song:
            return self.result("No song defined for this chat. Create loops first, then start_song.", success=False)
        total = int(song.get("total_bars", 0))
        pos = self._song_position_bars(song)
        finished = bool(song.get("playing")) and not song.get("loop") and pos >= total
        cur = (pos % total) if (song.get("loop") and total) else min(pos, total)
        acc = 0
        current = None
        map_lines = []
        for s in song.get("sections", []):
            note = ""
            if song.get("playing") and not finished and acc <= cur < acc + s["bars"]:
                current = f"{s['name']} (bar {int(cur - acc) + 1}/{s['bars']} of section, {int(cur) + 1}/{total} of song)"
                note = "  <- now"
            map_lines.append(f"{s['name']} ({s['bars']} bars): {', '.join(l['name'] for l in s.get('layers', [])) or '- silence -'}{note}")
            acc += s["bars"]
        anchor = song.get("anchor") or {}
        try:
            bar_sec = int(anchor.get("meter_steps", 16)) * 60.0 / float(anchor.get("bpm", 120)) / 4.0
        except (TypeError, ValueError):
            bar_sec = 2.0
        out = {
            "title": song.get("title"),
            "state": "finished" if finished else ("playing" if song.get("playing") else "stopped"),
            "loop": bool(song.get("loop")),
            "total_bars": total,
            "map": map_lines,
        }
        if current:
            out["now"] = current
        if not song.get("loop"):
            out["remaining_seconds"] = max(0, round((total - pos) * bar_sec))
        return self.result(out, success=True)


    @core.module.tool
    async def set_visual(self, sound: str, effect: str = "flash"):
        """
        Attaches a chat-window visual cue to a drum voice or instrument: every
        hit of that sound pulses the effect (a whole chord's simultaneous notes
        merge into one pulse). This is the only visual binding - loops play
        whatever cue their voice/instrument currently has. Defaults:
        kick->flash, snare->ripple.

        Args:
            sound: Voice or instrument name (built-in or custom).
            effect: flash | bloom | spark | tick | laser | ripple | wave | plasma | aurora | prism | strobe (GLSL visuals: ripple/wave/plasma/aurora/prism/strobe; spark/tick/laser suit fast short notes; strobe is intentionally flashy), or 'off' to clear.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        snd = str(sound).strip().lower()
        fx = str(effect).strip().lower()
        if fx not in EFFECTS and fx != "off":
            return self.result(f"Unknown effect '{effect}'. Options: {', '.join(EFFECTS)}, off.", success=False)
        visuals = dict(self._visuals(chat_id))
        if fx == "off":
            visuals.pop(snd, None)
        else:
            visuals[snd] = fx
        self._store_visuals(chat_id, visuals)
        await self._push(chat_id, {"type": "music_sequencer:visual", "sound": snd, "effect": None if fx == "off" else fx})
        return self.result(f"{'Cleared' if fx == 'off' else f'{snd} now pulses {fx}'} visual cue.", success=True)

    @core.module.tool
    async def list_visual_effects(self):
        """
        Lists all beat-synced visual effect names, the current per-sound cues,
        and the built-in defaults.
        """
        chat_id = self._chat_id()
        return self.result({
            "effects": EFFECTS,
            "defaults": DEFAULT_VISUALS,
            "active_cues": self._visuals(chat_id) if chat_id else {},
        }, success=True)

    @core.module.tool
    async def define_sound(self, name: str, spec: dict):
        """
        Designs a custom synth sound from a recipe; it then works anywhere a
        built-in does: voice= in play_drum_pattern (played as a one-shot at the
        spec's base_note) and instrument= in play_note_pattern (played at each
        note's pitch; set env.sustain above 0 for held notes). Re-defining a
        name updates it live: playing loops pick up the new recipe from their
        next hit.

        Args:
            name: Lowercase id, e.g. 'pew' or 'wobble'. Cannot shadow a built-in name.
            spec: Recipe dict. Keys (only osc is required, unless an engine key - fm, pd, ring, wt, chip or grain - is set): osc: list of 1-4 layers [{type: sine|square|sawtooth|triangle, level?: 0-1, octave?: -3..3, detune?: cents -100..100}]; fm?: full FM synth patch {operators: 1-6 dicts [{ratio?: 0.25-32 freq ratio to the played note, level?: 0-1 (mod depth for modulators, amp for carriers), feedback?: 0-0.9 self-modulation, attack?, decay?, sustain?: 0-1, release?}], algorithm: {modulator_index: carrier_index or list}, output: [carrier indexes]} - modulation depth scales with pitch like real FM; can coexist with osc layers; pd?: phase distortion, Casio CZ flavour {shape?: 0.02-0.98 warp (0.05 saw-bright, 0.5 hollow), shape_end?: settle target, decay?: settle seconds}; ring?: ring modulator over the whole voice {ratio?: mod freq relative to note (default 1.5) or freq?: absolute Hz} - stacks with any other engine, alone gets a sine carrier; wt?: wavetable sweep {table?: harmonics|even|sparse, pos_start?: 0-1, pos_end?: 0-1, steps?: 1-24, pos_time?: seconds}; chip?: NES pulse voice {duty?: 0.03-0.5, duty_end?: sweep target, arp?: up to 8 semitone offsets cycled as chip arpeggio, arp_rate?: 1-100 steps/s}; grain?: granular cloud of the note {size?: grain s (default 0.08), rate?: grains/s (default 14), scatter?: pitch jitter 0-0.2, src?: sine|noise}; noise?: {level?: 0-1, filter?: lowpass|highpass|bandpass, freq?: 20-20000} blended noise layer; filter?: {type?: lowpass|highpass|bandpass, cutoff?: 20-20000, q?: 0-30, env?: sweep start offset in semitones above the cutoff, positive = falling sweep (-48..48), env_time?: seconds} - env around 24-36 gives classic plucks; env?: {attack?, decay?, sustain? 0-1, release?} in seconds (sustain only heard on held notes; a ping is attack 0.002 decay 0.4 sustain 0, a pad attack 0.3 decay 0.2 sustain 0.8 release 0.5); pitch?: {glide?: start offset in semitones above the note, positive = falling sweep (-36..36), glide_time?: seconds}; base_note?: MIDI number used as a drum voice (default 36). E.g. laser: {"osc": [{"type": "sawtooth"}], "pitch": {"glide": 24}, "filter": {"cutoff": 6000, "env": 36}, "env": {"attack": 0.002, "decay": 0.25}, "base_note": 72}
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        nm = str(name).strip().lower()
        if not SOUND_NAME_RE.match(nm):
            return self.result("Sound names must be lowercase, start with a letter, and only contain letters, digits, '_' or '-' (max 32 chars).", success=False)
        if nm in BUILTIN_NAMES:
            return self.result(f"'{nm}' shadows a built-in sound; pick another name.", success=False)
        clean, err = _clean_sound_spec(spec)
        if err:
            return self.result(err, success=False)
        sounds = dict(self._sounds(chat_id))
        existed = nm in sounds
        sounds[nm] = clean
        self._store_sounds(chat_id, sounds)
        await self._push(chat_id, {"type": "music_sequencer:sound", "name": nm, "spec": clean})
        return self.result(f"{'Updated' if existed else 'Created'} custom sound '{nm}'. Use it as voice= or instrument= in the pattern tools.", success=True)

    @core.module.tool
    async def remove_sound(self, name: str):
        """
        Deletes a custom sound. Refused while any loop still references it
        (remove or re-tool those loops first).

        Args:
            name: The custom sound's name.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        nm = str(name).strip().lower()
        sounds = self._sounds(chat_id)
        if nm not in sounds:
            return self.result(f"No custom sound '{nm}' in this chat.", success=False)
        used_by = [lid for lid, d in self._loops(chat_id).items()
                   if (d.get("voice") or d.get("instrument")) == nm]
        if used_by:
            return self.result(f"Sound '{nm}' is used by {', '.join(used_by)}; remove or change those loops first.", success=False)
        sounds = dict(sounds)
        sounds.pop(nm)
        self._store_sounds(chat_id, sounds)
        return self.result(f"Removed custom sound '{nm}'.", success=True)

    @core.module.tool
    async def list_sounds(self):
        """
        Lists all sounds: the built-in drum voices and instruments, plus this
        chat's custom sounds with their full recipes.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        return self.result({
            "builtin_drum_voices": DRUM_VOICES,
            "builtin_instruments": INSTRUMENTS,
            "custom_sounds": self._sounds(chat_id),
        }, success=True)

    # -------------------------
    #   WEBUI ROUTES + PROMPTS
    # -------------------------

    @webui.route("state")
    async def _route_state(self, body=None, query=None):
        chat_id = (query or {}).get("chat")
        if not chat_id:
            return {"loops": {}, "sounds": {}, "tempo": self._tempo(chat_id), "meter": self._meter(chat_id), "master_volume": self.config.get("master_volume", 80)}
        loops = {}
        for loop_id, d in self._loops(chat_id).items():
            loops[loop_id] = dict(d, id=loop_id)
        return {
            "loops": loops,
            "sounds": self._sounds(chat_id),
            "visuals": self._visuals(chat_id),
            "tempo": self._tempo(chat_id),
            "meter": self._meter(chat_id),
            "song": self._song(chat_id),
            "master_volume": self.config.get("master_volume", 80),
        }

    async def on_chat_clear(self):
        chat_id = self._chat_id()
        if not chat_id:
            return
        loops = self._loops(chat_id)
        had_playing = any(d.get("playing") for d in loops.values())
        all_loops = dict(self.data.get("loops", {}))
        all_loops.pop(str(chat_id), None)
        self.data["loops"] = all_loops
        all_sounds = dict(self.data.get("sounds", {}))
        all_sounds.pop(str(chat_id), None)
        self.data["sounds"] = all_sounds
        all_visuals = dict(self.data.get("visuals", {}))
        all_visuals.pop(str(chat_id), None)
        self.data["visuals"] = all_visuals
        all_songs = dict(self.data.get("songs", {}))
        all_songs.pop(str(chat_id), None)
        self.data["songs"] = all_songs
        self.data.save()
        if had_playing:
            await self._push(chat_id, {"type": "music_sequencer:stop_all"})

    async def on_message_inject(self):
        chat_id = self._chat_id()
        if not chat_id:
            return None
        loops = self._loops(chat_id)
        if not loops:
            return None
        lines = []
        for loop_id, d in loops.items():
            name = d.get("voice") or d.get("instrument")
            key = f", {d['key']}" if d.get("key") else ""
            spb = d.get("steps_per_bar", 16)
            state = "playing" if d.get("playing") else "stopped"
            lines.append(f"- {loop_id}: {d.get('kind')} ({name}{key}, {d.get('bar_length')} bars @ {spb} steps, vol {d.get('volume')}) - {state}")
        block = (
            f"Active music_sequencer layers (tempo {self._tempo(chat_id):g} BPM, new-loop meter {self._meter_name(chat_id)}):\n"
            + "\n".join(lines)
        )
        song = self._song(chat_id)
        if song:
            state = "playing" if song.get("playing") else "stopped"
            block += (f"\nSong '{song.get('title')}' ({state}, {song.get('total_bars')} bars, "
                      f"loop {'on' if song.get('loop') else 'off'}) - use song_status for the live position.")
        custom = sorted(self._sounds(chat_id))
        if custom:
            block += f"\nCustom sounds in this chat: {', '.join(custom)}"
        cues = self._visuals(chat_id)
        if cues:
            block += "\nVisual cues: " + ", ".join(f"{k}->{v}" for k, v in cues.items())
        return block

    @core.module.command("music", help={
        "": "Shows the current loop layers",
        "stop": "Stops the song (if any) and every playing loop",
    })
    async def music_command(self, args: list):
        chat_id = self._chat_id()
        if not chat_id:
            return "No active chat."
        if args and args[0] == "stop":
            await self.stop_song()
            await self.stop_all_loops()
            return "Stopped song and all loops."
        loops = self._loops(chat_id)
        if not loops:
            return "No loop layers in this chat. Ask the AI to start one!"
        lines = [f"Tempo: {self._tempo(chat_id):g} BPM | Meter (new loops): {self._meter_name(chat_id)} | {self._playing_count(chat_id)}/{MAX_LAYERS} layers playing"]
        song = self._song(chat_id)
        if song:
            lines.append(f"Song: '{song.get('title')}' ({'playing' if song.get('playing') else 'stopped'}, {song.get('total_bars')} bars, loop {'on' if song.get('loop') else 'off'})")
        for loop_id, d in loops.items():
            name = d.get("voice") or d.get("instrument")
            state = "playing" if d.get("playing") else "stopped"
            lines.append(f"{loop_id}: {d.get('kind')} ({name}, {d.get('bar_length')} bars @ {d.get('steps_per_bar', 16)} steps) - {state}")
        return "\n".join(lines)

import re
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
EFFECTS = ["flash", "ring", "bloom", "spark", "tick", "laser"]
FILTER_TYPES = ["lowpass", "highpass", "bandpass"]
SOUND_NAME_RE = re.compile(r"^[a-z][a-z0-9_\-]{0,31}$")

PITCH_RE = re.compile(r"^([A-Ga-g])([#b]?)(-?\d{1,2})$")
NOTE_NAMES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


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


class MusicSequencerModule(core.module.Module):
    """
    Runs a synced multi-layer loop engine in the user's browser (Web Audio).
    Launch drum step-sequencer patterns and piano-roll patterns as loop layers
    (up to 60 at once) on one shared transport grid: every loop quantizes its
    launch to the next bar and repeats over its own bar length, so 2-bar loops
    cycle exactly twice per 4-bar loop. Loops keep playing while you chat;
    control them later by their loop IDs (stop/start), or retune the shared
    tempo for everything at once. define_sound designs brand-new synth voices
    from oscillator/noise/filter/envelope recipes, usable as any other.
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
        if "next_id" not in self.data:
            self.data["next_id"] = 1
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

    def _next_loop_id(self):
        lid = f"loop_{self.data.get('next_id', 1)}"
        self.data["next_id"] = self.data.get("next_id", 1) + 1
        self.data.save()
        return lid

    # -------------------------
    #   AI TOOLS
    # -------------------------

    @core.module.tool
    async def play_drum_pattern(self, steps: list, bar_length: int = 1, voice: str = "kick", volume: float = 1.0):
        """
        Launches a drum loop layer on the shared transport, joining at the next
        restart of the longest playing loop (the "song cycle"), so it lands
        aligned with the song rather than mid-phrase. Each step is one 16th
        note (4 per beat, 16 per bar).
        All loops share one grid and tempo, so any bar lengths stay in sync:
        a 2-bar loop cycles twice while a 4-bar loop plays once.
        Steps are velocities 0.0-1.0 (0 = silent). Pass either 16 steps (repeats
        every bar) or bar_length*16 steps (one pattern spanning the whole loop).

        Args:
            steps: Velocity per 16th-note step, e.g. [1,0,0,0, 0.6,0,0,0, 1,0,0,0, 0.6,0,0,0]
            bar_length: Length of the loop in bars (1-32). The pattern repeats every bar_length bars.
            voice: Drum voice: kick, snare, clap, hihat_closed, hihat_open, tom, rim, cowbell, or any custom sound name from define_sound.
            volume: Layer volume 0.0-1.0.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
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
        if not isinstance(steps, list) or not steps:
            return self.result("steps must be a non-empty list of velocities.", success=False)
        if len(steps) not in (16, bars * 16):
            return self.result(f"steps must have 16 entries (one bar) or {bars * 16} entries (the full loop).", success=False)
        if self._playing_count(chat_id) >= MAX_LAYERS:
            return self.result(f"Cannot start: {MAX_LAYERS} layers are already playing. Stop one first.", success=False)

        pattern = [_velocity(s, 0.0) for s in steps]
        if len(pattern) == 16 and bars > 1:
            pattern = pattern * bars

        loop_id = self._next_loop_id()
        definition = {
            "kind": "drum",
            "voice": voice,
            "bar_length": bars,
            "steps": pattern,
            "volume": _velocity(volume, 1.0),
            "playing": True,
        }
        loops = dict(self._loops(chat_id))
        loops[loop_id] = definition
        self._store_loops(chat_id, loops)
        await self._push(chat_id, {"type": "music_sequencer:play", "loop": dict(definition, id=loop_id)})
        return self.result(
            f"Started {voice} drum loop '{loop_id}' ({bars} bar{'s' if bars > 1 else ''}, "
            f"{self._playing_count(chat_id)}/{MAX_LAYERS} layers live).",
            success=True,
        )

    @core.module.tool
    async def play_note_pattern(self, notes: list, bar_length: int = 1, instrument: str = "piano", volume: float = 1.0):
        """
        Launches a piano-roll style melody loop layer on the shared transport,
        joining at the next restart of the longest playing loop (the "song
        cycle"), so its phrasing stays aligned with the rest of the song.
        All loops share one grid and tempo,
        so any bar lengths stay in sync. Pitches are MIDI note numbers (60 =
        middle C) or note names ("C4", "F#5", "Bb2"). Timing is in 16th-note
        steps: 16 steps per bar, so a 4-bar loop has steps 0-63.

        Args:
            notes: List of note dicts, each {pitch, start, length, velocity?, visual?}. visual is a one-off chat-window effect for that note (flash|ring|bloom|spark|tick|laser). E.g. [{"pitch": "C4", "start": 0, "length": 8}, {"pitch": 67, "start": 8, "length": 4, "velocity": 0.7, "visual": "bloom"}]
            bar_length: Length of the loop in bars (1-32). The roll repeats every bar_length bars.
            instrument: Timbre: piano, bass, pad, lead, pluck, bells, sine, square, triangle, saw, organ, strings, synbrass, flute, musicbox, or any custom sound name from define_sound.
            volume: Layer volume 0.0-1.0.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
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
            return self.result("notes must be a non-empty list of note dicts.", success=False)
        if len(notes) > 512:
            return self.result("Too many notes (max 512 per loop).", success=False)
        if self._playing_count(chat_id) >= MAX_LAYERS:
            return self.result(f"Cannot start: {MAX_LAYERS} layers are already playing. Stop one first.", success=False)

        grid = bars * 16
        clean_notes = []
        for i, n in enumerate(notes):
            if not isinstance(n, dict):
                return self.result(f"Note {i} is not a dict with pitch/start/length.", success=False)
            pitch = n.get("pitch")
            midi = _midi_value(pitch)
            if midi is None or midi < 12 or midi > 127:
                return self.result(f"Note {i} has an invalid pitch ({pitch!r}). Use MIDI numbers or names like C4.", success=False)
            try:
                start = int(n.get("start", 0))
                length = int(n.get("length", 4))
            except (TypeError, ValueError):
                return self.result(f"Note {i} has non-integer start/length.", success=False)
            if start < 0 or start >= grid:
                return self.result(f"Note {i} starts outside the loop (start must be 0-{grid - 1}).", success=False)
            if length < 1:
                return self.result(f"Note {i} has length < 1.", success=False)
            note = {
                "pitch": midi,
                "start": start,
                "length": min(length, grid - start),
                "velocity": _velocity(n.get("velocity"), 0.8),
            }
            vis = str(n.get("visual", "")).strip().lower()
            if vis and vis not in EFFECTS:
                return self.result(f"Note {i} visual must be one of: {', '.join(EFFECTS)}.", success=False)
            if vis:
                note["visual"] = vis
            clean_notes.append(note)

        loop_id = self._next_loop_id()
        definition = {
            "kind": "note",
            "instrument": instrument,
            "bar_length": bars,
            "notes": clean_notes,
            "volume": _velocity(volume, 1.0),
            "playing": True,
        }
        loops = dict(self._loops(chat_id))
        loops[loop_id] = definition
        self._store_loops(chat_id, loops)
        await self._push(chat_id, {"type": "music_sequencer:play", "loop": dict(definition, id=loop_id)})
        return self.result(
            f"Started {instrument} melody loop '{loop_id}' ({len(clean_notes)} notes, {bars} bar{'s' if bars > 1 else ''}, "
            f"{self._playing_count(chat_id)}/{MAX_LAYERS} layers live).",
            success=True,
        )

    @core.module.tool
    async def stop_loop(self, loop_id: str):
        """
        Stops a running loop layer by its ID (the pattern stays known and can be
        restarted with start_loop). Silences nothing else.

        Args:
            loop_id: The ID returned when the loop was started, e.g. 'loop_3'.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        loops = self._loops(chat_id)
        definition = loops.get(str(loop_id))
        if not definition:
            return self.result(f"No loop with ID '{loop_id}' in this chat.", success=False)
        if not definition.get("playing"):
            return self.result(f"Loop '{loop_id}' is already stopped.", success=False)
        loops = dict(loops)
        loops[str(loop_id)] = dict(definition, playing=False)
        self._store_loops(chat_id, loops)
        await self._push(chat_id, {"type": "music_sequencer:stop", "id": str(loop_id)})
        return self.result(f"Stopped loop '{loop_id}'.", success=True)

    @core.module.tool
    async def start_loop(self, loop_id: str):
        """
        (Re)starts a loop layer by its ID. It joins the shared transport at the
        next restart of the longest playing loop (the "song cycle"), in sync
        with everything else already playing. Works on loops stopped earlier
        with stop_loop; restarting a live loop has no effect.

        Args:
            loop_id: The ID returned when the loop was started, e.g. 'loop_3'.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        loops = self._loops(chat_id)
        definition = loops.get(str(loop_id))
        if not definition:
            return self.result(f"No loop with ID '{loop_id}' in this chat.", success=False)
        if definition.get("playing"):
            return self.result(f"Loop '{loop_id}' is already playing.", success=False)
        if self._playing_count(chat_id) >= MAX_LAYERS:
            return self.result(f"Cannot start: {MAX_LAYERS} layers are already playing. Stop one first.", success=False)
        loops = dict(loops)
        loops[str(loop_id)] = dict(definition, playing=True)
        self._store_loops(chat_id, loops)
        await self._push(chat_id, {"type": "music_sequencer:play", "loop": dict(definition, id=str(loop_id))})
        return self.result(f"Restarted loop '{loop_id}', joining the next song cycle.", success=True)

    @core.module.tool
    async def remove_loop(self, loop_id: str):
        """
        Deletes a loop layer entirely (stops it if playing, forgets the pattern).

        Args:
            loop_id: The ID returned when the loop was started, e.g. 'loop_3'.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        loops = self._loops(chat_id)
        if str(loop_id) not in loops:
            return self.result(f"No loop with ID '{loop_id}' in this chat.", success=False)
        was_playing = bool(loops[str(loop_id)].get("playing"))
        loops = dict(loops)
        loops.pop(str(loop_id))
        self._store_loops(chat_id, loops)
        if was_playing:
            await self._push(chat_id, {"type": "music_sequencer:stop", "id": str(loop_id)})
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
        await self._push(chat_id, {"type": "music_sequencer:tempo", "bpm": tempo})
        return self.result(f"Tempo set to {tempo:g} BPM.", success=True)

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
                "volume": d.get("volume"),
                "playing": bool(d.get("playing")),
            }
            if d.get("kind") == "note":
                entry["note_count"] = len(d.get("notes", []))
            summary.append(entry)
        return self.result({
            "tempo": self._tempo(chat_id),
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
        if not self._playing_count(chat_id):
            return self.result("Nothing is playing.", success=False)
        loops = {lid: dict(d, playing=False) for lid, d in self._loops(chat_id).items()}
        self._store_loops(chat_id, loops)
        await self._push(chat_id, {"type": "music_sequencer:stop_all"})
        return self.result("Stopped all loops.", success=True)

    @core.module.tool
    async def set_visual(self, sound: str, effect: str = "flash"):
        """
        Attaches a chat-window visual cue to a drum voice or instrument: every
        hit of that sound pulses the effect (a whole chord's simultaneous notes
        merge into one pulse). Defaults: kick->flash, snare->ring. Notes can
        also carry a per-note 'visual' key in play_note_pattern for accents.

        Args:
            sound: Voice or instrument name (built-in or custom).
            effect: flash | ring | bloom | spark | tick | laser (spark/tick/laser suit fast short notes; laser fires a beam from the note's grid cell), or 'off' to clear.
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
            return {"loops": {}, "sounds": {}, "tempo": self._tempo(chat_id), "master_volume": self.config.get("master_volume", 80)}
        loops = {}
        for loop_id, d in self._loops(chat_id).items():
            loops[loop_id] = dict(d, id=loop_id)
        return {
            "loops": loops,
            "sounds": self._sounds(chat_id),
            "visuals": self._visuals(chat_id),
            "tempo": self._tempo(chat_id),
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
        self.data.save()
        if had_playing:
            await self._push(chat_id, {"type": "music_sequencer:stop_all"})

    async def on_end_prompt(self):
        chat_id = self._chat_id()
        if not chat_id:
            return None
        loops = self._loops(chat_id)
        if not loops:
            return None
        lines = []
        for loop_id, d in loops.items():
            name = d.get("voice") or d.get("instrument")
            state = "playing" if d.get("playing") else "stopped"
            lines.append(f"- {loop_id}: {d.get('kind')} ({name}, {d.get('bar_length')} bars, vol {d.get('volume')}) - {state}")
        block = (
            f"Active music_sequencer layers (tempo {self._tempo(chat_id):g} BPM):\n"
            + "\n".join(lines)
        )
        custom = sorted(self._sounds(chat_id))
        if custom:
            block += f"\nCustom sounds in this chat: {', '.join(custom)}"
        cues = self._visuals(chat_id)
        if cues:
            block += "\nVisual cues: " + ", ".join(f"{k}->{v}" for k, v in cues.items())
        return block

    @core.module.command("music", help={
        "": "Shows the current loop layers",
        "stop": "Stops every playing loop",
    })
    async def music_command(self, args: list):
        chat_id = self._chat_id()
        if not chat_id:
            return "No active chat."
        if args and args[0] == "stop":
            await self.stop_all_loops()
            return "Stopped all loops."
        loops = self._loops(chat_id)
        if not loops:
            return "No loop layers in this chat. Ask the AI to start one!"
        lines = [f"Tempo: {self._tempo(chat_id):g} BPM | {self._playing_count(chat_id)}/{MAX_LAYERS} layers playing"]
        for loop_id, d in loops.items():
            name = d.get("voice") or d.get("instrument")
            state = "playing" if d.get("playing") else "stopped"
            lines.append(f"{loop_id}: {d.get('kind')} ({name}, {d.get('bar_length')} bars) - {state}")
        return "\n".join(lines)

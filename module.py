import os
import random
import re
import time
import urllib.parse
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
WT_TABLES = ["basic", "saw", "even", "odd", "quad", "sparse", "bell", "vocal", "organ", "harmonics"]
EFFECTS = [
    "flash", "bloom", "spark", "drip", "laser", "ripple", "wave", "plasma", "aurora",
    "prism", "strobe", "pulse", "wheel", "motes", "vortex", "soundwave",
]
AMBIENT_EFFECTS = ["wheel", "motes", "vortex", "soundwave"]
DEFAULT_VISUALS = {"kick": "flash", "snare": "ripple"}
FILTER_TYPES = ["lowpass", "highpass", "bandpass"]
LFO_SYNC_RATES = ["bar", "1/1", "1/2", "1/4", "1/8", "1/16", "1/32", "1/4t", "1/8t", "1/16t"]
DELAY_SYNC_TIMES = ["bar", "1/1", "1/2", "1/4", "1/4d", "1/8", "1/8d", "1/8t", "1/16", "1/16d", "1/16t"]
FX_TYPES = ["dist", "chorus", "delay", "verb"]
SIDECHAIN_RATES = ("4th", "8th", "16th")
SOUND_NAME_RE = re.compile(r"^[a-z][a-z0-9_\-]{0,31}$")

# user-dropped audio files served from webui/assets/samples/ via the
# /ext-assets/ route; the filename stem (lowercased) becomes the sample name
SAMPLE_EXTS = {".wav", ".mp3", ".ogg", ".oga", ".flac", ".m4a", ".aac", ".opus", ".webm", ".aif", ".aiff"}
SAMPLES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "webui", "assets", "samples")

NOTE_NAMES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
# altered degrees carry a #/b prefix: 'b7', '#4'. Pitches are degrees only;
# absolute note names remain valid just for a key's root (e.g. "F# dorian").
DEGREE_RE = re.compile(r"^([#b]?)(\d{1,2})$")
KEY_RE = re.compile(r"^([A-Ga-g])([#b]?)(\d{1,2})?\s+(.+)$")
METER_RE = re.compile(r"^(\d{1,2})\s*/\s*(\d{1,2})$")
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
# steps_per_beat (grid resolution): steps held by one beat. Legacy
# subdivision names are accepted as aliases for these numbers.
STEPS_PER_BEAT_ALIASES = {
    "4ths": 1, "8ths": 2, "16ths": 4, "32nds": 8,
    "triplets": 3, "shuffle": 3, "12/8": 3,
    "triplet-16ths": 6, "double-shuffle": 6, "6/8": 2,
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


def _num(value, default, lo, hi):
    try:
        v = float(value)
    except (TypeError, ValueError):
        v = default
    return max(lo, min(hi, v))


def _is_number(value):
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False


SIDECHAIN_ALIASES = {
    "kick": "4th", "quarter": "4th", "4n": "4th",
    "eighth": "8th", "8n": "8th",
    "sixteenth": "16th", "16n": "16th",
}


def _clean_sidechain(value):
    """Sidechain pump spec -> dict | None. Accepts "rate:depth:attack:release"
    (only rate required) or a dict {rate, depth?, attack?, release?}."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None, None
    if isinstance(value, str):
        parts = [p.strip() for p in value.split(":") if p.strip()]
        if not parts:
            return None, "sidechain is empty after splitting on ':'. Use e.g. '16th', '8th:0.5' or '16th:0.7:0.005:0.12'."
        value = {"rate": parts[0]}
        for key, item in zip(("depth", "attack", "release"), parts[1:]):
            value[key] = item
    if not isinstance(value, dict):
        return None, "sidechain must be a string like '16th:0.7:0.005:0.12' or a dict {rate, depth?, attack?, release?}."
    rname = str(value.get("rate", "")).strip().lower()
    rname = SIDECHAIN_ALIASES.get(rname, rname)
    if rname not in SIDECHAIN_RATES:
        return None, f"sidechain rate must be one of: {', '.join(SIDECHAIN_RATES)} (aliases: kick/quarter, eighth, sixteenth)."
    return {
        "rate": rname,
        "depth": _num(value.get("depth"), 0.65, 0.0, 0.95),
        "attack": _num(value.get("attack"), 0.006, 0.001, 0.2),
        "release": _num(value.get("release"), 0.22, 0.02, 2.0),
    }, None


def _clean_fx(value):
    """Per-loop FX chain spec -> list of cleaned stage dicts | None."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None, None
    if isinstance(value, dict):
        value = [value]
    if not isinstance(value, list) or not value or len(value) > 4:
        return None, "fx must be a list of 1 to 4 stage dicts, each with a 'type' key."
    clean = []
    for i, stage in enumerate(value):
        if not isinstance(stage, dict):
            return None, f"fx[{i}] must be a dict with a 'type' key."
        t = str(stage.get("type", "")).strip().lower()
        if t not in FX_TYPES:
            return None, f"fx[{i}].type must be one of: {', '.join(FX_TYPES)}."
        s = {"type": t}
        if t == "dist":
            curve = str(stage.get("curve", "tanh")).strip().lower()
            if curve not in ("tanh", "fold", "crush", "hard"):
                return None, f"fx[{i}].curve must be one of: tanh, fold, crush, hard."
            s["curve"] = curve
            s["drive"] = _num(stage.get("drive"), 0.5, 0.0, 1.0)
            s["mix"] = _num(stage.get("mix"), 1.0, 0.0, 1.0)
            s["bits"] = int(_num(stage.get("bits"), 5, 1, 8))
        elif t == "chorus":
            s["rate"] = _num(stage.get("rate"), 0.6, 0.05, 4.0)
            s["depth"] = _num(stage.get("depth"), 0.5, 0.0, 1.0)
            s["mix"] = _num(stage.get("mix"), 0.4, 0.0, 1.0)
        elif t == "delay":
            sync = str(stage.get("sync", "1/4")).strip()
            if sync not in DELAY_SYNC_TIMES:
                return None, f"fx[{i}].sync must be one of: {', '.join(DELAY_SYNC_TIMES)} (or set time in seconds)."
            s["sync"] = sync
            s["time"] = _num(stage.get("time"), 0.0, 0.0, 2.0)
            s["feedback"] = _num(stage.get("feedback"), 0.35, 0.0, 0.92)
            s["mix"] = _num(stage.get("mix"), 0.3, 0.0, 1.0)
            s["damp"] = _num(stage.get("damp"), 4500.0, 200.0, 16000.0)
            s["pingpong"] = bool(stage.get("pingpong", False))
        elif t == "verb":
            s["mix"] = _num(stage.get("mix"), 0.3, 0.0, 1.0)
        clean.append(s)
    return clean, None


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
    engine_keys = ("fm", "pd", "ring", "wt", "chip", "grain", "sweep")
    osc = spec.get("osc")
    has_engine = any(spec.get(e) is not None for e in engine_keys)
    if osc is None and has_engine:
        osc = []
    if not isinstance(osc, list) or len(osc) > 4 or (not osc and not has_engine):
        return None, "spec.osc must be a list of 1 to 4 oscillator layers (empty only when an engine key is set: fm, pd, ring, wt, chip, grain or sweep)."
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
        filt = {
            "type": ftype,
            "cutoff": _num(f.get("cutoff"), 8000.0, 20.0, 20000.0),
            "q": _num(f.get("q"), 1.0, 0.0001, 30.0),
            "poles": int(_num(f.get("poles"), 1, 1, 2)),
            "keytrack": _num(f.get("keytrack"), 0.0, 0.0, 1.0),
        }
        fenv = f.get("env", 0.0)
        if isinstance(fenv, dict):
            # full filter envelope in semitones relative to cutoff: start at
            # 'from', optional attack hold, then travel to 'to' across decay.
            filt["env"] = {
                "from": _num(fenv.get("from"), 24.0, -60.0, 60.0),
                "to": _num(fenv.get("to"), 0.0, -60.0, 60.0),
                "attack": _num(fenv.get("attack"), 0.0, 0.0, 8.0),
                "decay": _num(fenv.get("decay"), 0.3, 0.01, 8.0),
            }
        else:
            # legacy one-shot: start 'env' semitones above cutoff, fall to it.
            filt["env"] = _num(fenv, 0.0, -48.0, 48.0)
            filt["env_time"] = _num(f.get("env_time"), 0.2, 0.01, 8.0)
        clean["filter"] = filt

    if spec.get("env") is not None:
        e = spec["env"]
        if not isinstance(e, dict):
            return None, "spec.env must be a dict."
        clean["env"] = {
            # long attack/decay headroom for risers and swelling pads
            "attack": _num(e.get("attack"), 0.005, 0.001, 10.0),
            "decay": _num(e.get("decay"), 0.3, 0.005, 12.0),
            "sustain": _num(e.get("sustain"), 0.0, 0.0, 1.0),
            "release": _num(e.get("release"), 0.15, 0.005, 8.0),
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
        wtabs = w.get("table", "basic")
        if isinstance(wtabs, list):
            # custom table: per-harmonic amplitudes, index 0 = fundamental;
            # negative values flip that partial's phase.
            if not wtabs or len(wtabs) > 64:
                return None, "spec.wt.table as a custom table must be 1 to 64 harmonic amplitudes (index 0 = fundamental)."
            amps = [_num(x, 0.0, -1.0, 1.0) for x in wtabs]
            while len(amps) > 1 and abs(amps[-1]) < 0.0005:
                amps.pop()
            wtable = amps
        else:
            tname = str(wtabs).strip().lower()
            if tname not in WT_TABLES:
                return None, f"spec.wt.table must be one of: {', '.join(WT_TABLES)} (or a list of harmonic amplitudes)."
            wtable = tname
        clean["wt"] = {
            "table": wtable,
            "pos_start": _num(w.get("pos_start"), 0.05, 0.0, 1.0),
            "pos_end": _num(w.get("pos_end"), 0.9, 0.0, 1.0),
            "steps": int(_num(w.get("steps"), 16, 1, 64)),
            "pos_time": _num(w.get("pos_time"), 0.4, 0.01, 8.0),
            "curve": _num(w.get("curve"), 1.0, 0.2, 5.0),
            "unison": int(_num(w.get("unison"), 0, 0, 8)),
            "detune": _num(w.get("detune"), 0.12, 0.0, 1.0),
            "spread": _num(w.get("spread"), 0.5, 0.0, 1.0),
        }
        if w.get("lfo") is not None:
            l = w["lfo"]
            if not isinstance(l, dict):
                return None, "spec.wt.lfo must be a dict."
            ltarget = str(l.get("target", "pos")).strip().lower()
            if ltarget not in ("pos", "pitch"):
                return None, "spec.wt.lfo.target must be 'pos' (table wobble) or 'pitch' (vibrato)."
            lwave = str(l.get("wave", "sine")).strip().lower()
            if lwave not in ("sine", "triangle", "square"):
                return None, "spec.wt.lfo.wave must be one of: sine, triangle, square."
            clean["wt"]["lfo"] = {
                "rate": _num(l.get("rate"), 5.0, 0.05, 40.0),
                "depth": _num(l.get("depth"), 0.5, 0.0, 1.0),
                "target": ltarget,
                "wave": lwave,
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

    if spec.get("lfo") is not None:
        lfos = spec["lfo"] if isinstance(spec["lfo"], list) else [spec["lfo"]]
        if not lfos or len(lfos) > 4:
            return None, "spec.lfo must be one LFO dict or a list of up to 4."
        clean_lfos = []
        for i, l in enumerate(lfos):
            if not isinstance(l, dict):
                return None, f"spec.lfo[{i}] must be a dict."
            tgt = str(l.get("target", "pitch")).strip().lower()
            if tgt not in ("pitch", "cutoff", "amp"):
                return None, "spec.lfo.target must be 'pitch' (vibrato), 'cutoff' (filter wobble/squelch) or 'amp' (tremolo/rhythmic gating)."
            wave = str(l.get("wave", "sine")).strip().lower()
            if wave not in ("sine", "triangle", "square", "sawtooth"):
                return None, "spec.lfo.wave must be one of: sine, triangle, square, sawtooth."
            rate = l.get("rate", "1/8")
            if isinstance(rate, str) and not _is_number(rate):
                rname = rate.strip().lower()
                if rname not in LFO_SYNC_RATES:
                    return None, f"spec.lfo.rate {rate!r} is neither a Hz number nor a tempo-sync name: {', '.join(LFO_SYNC_RATES)}."
                rate = rname
            else:
                rate = _num(rate, 5.0, 0.05, 40.0)
            clean_lfos.append({
                "target": tgt,
                "wave": wave,
                "rate": rate,
                "depth": _num(l.get("depth"), 0.5, 0.0, 1.0),
                "delay": _num(l.get("delay"), 0.0, 0.0, 8.0),
            })
        clean["lfo"] = clean_lfos

    if spec.get("unison") is not None:
        u = spec["unison"]
        if not isinstance(u, dict):
            return None, "spec.unison must be a dict."
        clean["unison"] = {
            "voices": int(_num(u.get("voices"), 3, 1, 8)),
            "detune": _num(u.get("detune"), 0.5, 0.0, 1.0),
            "spread": _num(u.get("spread"), 0.7, 0.0, 1.0),
        }

    if spec.get("sweep") is not None:
        s = spec["sweep"]
        if not isinstance(s, dict):
            return None, "spec.sweep must be a dict."
        ssrc = str(s.get("src", "noise")).strip().lower()
        if ssrc not in ("noise", "sine", "square", "sawtooth", "triangle"):
            return None, "spec.sweep.src must be noise, sine, square, sawtooth or triangle."
        sweep = {
            "src": ssrc,
            "from": _num(s.get("from"), 0.0, 0.0, 20000.0),
            "to": _num(s.get("to"), 0.0, 0.0, 20000.0),
            "curve": _num(s.get("curve"), 1.0, 0.2, 5.0),
            "level": _num(s.get("level"), 0.4, 0.0, 1.0),
        }
        if ssrc == "noise":
            sfilter = str(s.get("filter", "lowpass")).strip().lower()
            if sfilter not in FILTER_TYPES:
                return None, f"spec.sweep.filter must be one of: {', '.join(FILTER_TYPES)}."
            sweep["filter"] = sfilter
            sweep["q"] = _num(s.get("q"), 1.2, 0.0001, 12.0)
        clean["sweep"] = sweep
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
    """Normalized loop key: lowercase with collapsed whitespace; '' when empty."""
    cleaned = re.sub(r"\s+", " ", str(name or "")).strip().lower()
    if not cleaned or len(cleaned) > 120:
        return ""
    return cleaned


def _sample_file_name(stem):
    """Sample filename stem -> usable sample name ('' when unusable)."""
    cleaned = re.sub(r"-{2,}", "-", re.sub(r"[^a-z0-9_\-]+", "-", str(stem or "").strip().lower())).strip("-")
    if not cleaned or not SOUND_NAME_RE.match(cleaned):
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

def _parse_key(key, octave=None):
    """Parse 'root + scale' (e.g. 'A minor') into (root_midi, scale, scale_name, error).
    octave sets where degree 1 sits (default 4; overrides any octave baked into the key)."""
    raw = str(key or "").strip()
    if not raw:
        raw = "C major"
    m = KEY_RE.match(raw)
    if not m:
        return None, None, "", "key must be a root note plus a scale name, e.g. 'A minor', 'F# dorian', 'C major pentatonic'."
    name = re.sub(r"[\s_-]+", " ", m.group(4).strip().lower())
    name = SCALE_ALIASES.get(name, name)
    scale = SCALES.get(name)
    if scale is None:
        return None, None, "", f"Unknown scale '{m.group(4)}'. Options: {', '.join(sorted(SCALES))}."
    if octave is None:
        octave = int(m.group(3)) if m.group(3) else 4
    if octave < 0 or octave > 8:
        return None, None, "", "octave must be between 0 and 8."
    accidental = 1 if m.group(2) == "#" else (-1 if m.group(2) == "b" else 0)
    root = (octave + 1) * 12 + NOTE_NAMES[m.group(1).upper()] + accidental
    return root, scale, name, None


def _resolve_pitch(value, root_midi, scale):
    """Scale degree (int >= 1, or '#4'/'b7' string) to a MIDI number; None when invalid.
    Degrees are 1-indexed: 1 = tonic. 0 and negatives are rejected, not wrapped down."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        if value < 1:
            return None
        octave, idx = divmod(value - 1, len(scale))
        return root_midi + octave * 12 + scale[idx]
    m = DEGREE_RE.match(str(value).strip())
    if m and int(m.group(2)) >= 1:
        octave, idx = divmod(int(m.group(2)) - 1, len(scale))
        alteration = 1 if m.group(1) == "#" else (-1 if m.group(1) == "b" else 0)
        return root_midi + octave * 12 + scale[idx] + alteration
    return None


def _midi_to_degree(midi, root_midi, scale):
    """MIDI number back into a scale-degree string for the loop's own key."""
    octv, semis = divmod(int(midi) - root_midi, 12)
    if semis in scale:
        return str(octv * len(scale) + scale.index(semis) + 1)
    for i, s in enumerate(scale):
        if s - semis == 1:
            return f"b{i + 1}"
        if semis - s == 1:
            return f"#{i + 1}"
    return str(midi)

CHORD_QUALITIES = {
    "": [0, 4, 7], "maj": [0, 4, 7], "M": [0, 4, 7], "maj7": [0, 4, 7, 11], "M7": [0, 4, 7, 11],
    "m": [0, 3, 7], "min": [0, 3, 7], "-": [0, 3, 7], "m7": [0, 3, 7, 10], "min7": [0, 3, 7, 10],
    "maj9": [0, 4, 7, 11, 14], "m9": [0, 3, 7, 10, 14], "9": [0, 4, 7, 10, 14], "dom9": [0, 4, 7, 10, 14],
    "6": [0, 4, 7, 9], "m6": [0, 3, 7, 9],
    "aug": [0, 4, 8], "+": [0, 4, 8], "aug7": [0, 4, 8, 10], "dim": [0, 3, 6], "o": [0, 3, 6], "deg": [0, 3, 6],
    "dim7": [0, 3, 6, 9], "o7": [0, 3, 6, 9],
    "m7b5": [0, 3, 6, 10], "halfdim": [0, 3, 6, 10], "ø7": [0, 3, 6, 10],
    "sus2": [0, 2, 7], "sus4": [0, 5, 7], "sus": [0, 5, 7],
    "7": [0, 4, 7, 10], "dom7": [0, 4, 7, 10], "7sus4": [0, 5, 7, 10],
    "maj11": [0, 4, 7, 11, 14, 17], "11": [0, 4, 7, 10, 14, 17],
    "add9": [0, 4, 7, 14], "madd9": [0, 3, 7, 14],
}
CHORD_RE = re.compile(r"^([A-Ga-g])([#b]?)([-+øoOMm]?[a-zA-Z0-9#b]{0,6})(?:/\s*([A-Ga-g])([#b]?))?$")


def _parse_chord(token):
    """Chord symbol like 'Am', 'F#m7', 'C/E' into (root_pc, intervals, bass_pc, error)."""
    m = CHORD_RE.match(token)
    if not m:
        return None, None, None, f"can't read chord {token!r}"
    quality = m.group(3)
    intervals = CHORD_QUALITIES.get(quality)
    if intervals is None:
        lowered = quality.lower()
        intervals = CHORD_QUALITIES.get(lowered)
    if intervals is None:
        return None, None, None, f"unknown chord quality {quality!r} in {token!r}"
    root_pc = NOTE_NAMES[m.group(1).upper()] + (1 if m.group(2) == "#" else (-1 if m.group(2) == "b" else 0))
    bass_pc = None
    if m.group(4):
        bass_pc = NOTE_NAMES[m.group(4).upper()] + (1 if m.group(5) == "#" else (-1 if m.group(5) == "b" else 0))
    return root_pc, intervals, bass_pc, None


def _chord_degrees(root_pc, intervals, root_midi, scale):
    """Chord root pitch-class + intervals -> scale-degree strings via the key's scale."""
    degrees = []
    for iv in intervals:
        midi = root_midi + iv + ((root_pc - root_midi) % 12)
        # keep chord tones near the root octave: pull down anything over an octave up
        while midi - root_midi >= 24:
            midi -= 12
        degrees.append(_midi_to_degree(midi, root_midi, scale))
    return degrees

# mood -> proven progressions as plain chord symbols, written on a C (major)
# or A (minor) tonic; suggest_chords transposes them into the user's key.
MOOD_PROGRESSIONS = {
    "happy": {
        "major": ["C G Am F", "C Am F G", "F G C Am", "C Em F G", "F C Dm G", "C F C G"],
    },
    "uplifting": {
        "major": ["F G C Am", "C G Am F", "Am F C G", "C Em F Em"],
        "minor": ["Am F C G", "Fm Db Ab Eb", "Am F Dm E"],
    },
    "hopeful": {
        "minor": ["Am F C G", "Am Em F C", "Dm G C Am", "Am C F G"],
        "major": ["C Em F G", "Am F C G", "F C G Am"],
    },
    "melancholic": {
        "minor": ["Am Em F C", "Am F C G", "Am G F E", "F C Dm Am", "Am Dm Am E"],
        "major": ["C Am F G", "F C Dm Am", "C Em Am G"],
    },
    "sad": {
        "minor": ["Am G F E", "Am Em Dm E", "Am F E Am", "Dm Am G C"],
        "major": ["C Em Am G", "Am Em F C"],
    },
    "dark": {
        "minor": ["Am G F E", "Am Bm Am E", "Am Fm Am E", "Am Em Am G"],
    },
    "tense": {
        "minor": ["Am Gm Am E", "Am Fm Em Am", "Am Bm Caug Am"],
    },
    "epic": {
        "minor": ["Am F G Am", "F G Am Em", "Am G F G", "Dm Am F G"],
        "major": ["C Bb F G", "F G Am F"],
    },
    "dreamy": {
        "major": ["C Emaj7 Am7 Fmaj7", "Cmaj7 Em7 Fmaj7 G6", "C G/B Am7 Fmaj7"],
        "minor": ["Am7 Fmaj7 Cmaj7 Em7", "Am9 Fmaj7 G6 Am7"],
    },
    "nostalgic": {
        "major": ["C E7 Am F", "C G/B Am7 Fmaj7", "F G Em Am", "Dm7 G7 Cmaj7 Am7"],
        "minor": ["Am7 Dm7 Fmaj7 E7", "Am Em Fmaj7 E7"],
    },
    "romantic": {
        "major": ["Cmaj7 Fmaj7 Dm7 G7", "C Em Am7 G7", "Fmaj7 G7 Em7 Am7"],
        "minor": ["Am7 Dm7 G C", "Am Em Fmaj7 E7"],
    },
    "aggressive": {
        "minor": ["Am G Am G", "A5 G5 F5 E5", "Am Am F G", "Em Dm Em Am"],
    },
    "spooky": {
        "minor": ["Am Bbm Am G", "Am Fm Am G", "Am G#dim Am E"],
    },
    "chill": {
        "major": ["Cmaj7 Am7 Fmaj7 G6", "Dm7 G7 Cmaj7 Em7", "C Em7 Fmaj7 G6"],
        "minor": ["Am7 Dm7 Am7 E7", "Am7 G6 Fmaj7 E7", "Am7 Fmaj7 Dm7 E7"],
    },
}
# power-chord qualities so the aggressive table can spell 5-chords
CHORD_QUALITIES["5"] = [0, 7]


def _transpose_chord(symbol, semis):
    """Shift a chord symbol's root (and bass) by semitones; quality untouched."""
    root_pc, intervals, bass_pc, err = _parse_chord(symbol)
    if err:
        return symbol
    token = SHARP_NAMES[(root_pc + semis) % 12]
    m = CHORD_RE.match(symbol)
    if m and m.group(4):
        token += "/" + SHARP_NAMES[(bass_pc + semis) % 12]
    elif m:
        token += m.group(3) if m.group(3) not in ("o", "o7") else m.group(3)
    return token


MOOD_SCALES = {
    "lydian": "dreamy, wonder, floaty, magical, nostalgic-optimistic",
    "dorian": "bittersweet, sad-but-hopeful, cool melancholy, medieval-funk",
    "phrygian": "exotic, dark Spanish, edgy tension without menace",
    "phrygian dominant": "sinister, middle-eastern menace, boss-fight, desert evil",
    "mixolydian": "classic rock, jam, bluesy-but-happy, adventurous",
    "locrian": "unstable, shattered, dissonant tension",
    "harmonic minor": "classical dark, vamps, neoclassical metal, brooding drama",
    "melodic minor": "cinematic, sophisticated jazz, bittersweet rising lines",
    "whole tone": "spacy, dreamlike, underwater, drifting, unsure",
    "hirajoshi": "japanese, zen, pentatonic melancholy, garden at dusk",
    "octatonic": "villain, spy thriller, mechanical menace, circus-dark",
    "altered": "jazz tension, resolution-hungry, chaotic chromaticism",
    "blues": "gritty, soulful, bar-room, feel-good pain",
    "minor pentatonic": "rock riffs, moody but safe, everything fits",
    "major pentatonic": "folky, open-air happy, pentatonic sparkle",
}

GENRE_RECIPES = {
    "house": {
        "bpm": "124-128",
        "kick": "x...x...x...x...",
        "clap_or_snare": "....x.......x...",
        "hat_offbeat": "..x...x...x...x.",
        "hat_closed": None, "openhat": "..o...o...o...o.",
        "bass": "offbeat 8th stabs or a rolling 16th bass on degree 1, brief octave pops",
        "sidechain": "4th on bass, pads and chords - the whole genre lives on this pump",
        "extra": "swap elements in/out every 8 or 16 bars instead of writing new bars",
    },
    "techno": {
        "bpm": "130-140",
        "kick": "x...x...x...x...",
        "clap_or_snare": None,
        "hat_offbeat": "..x...x...x...x.",
        "hat_closed": "..5.x.5.x.5.x.5.",
        "openhat": None,
        "bass": "relentless 16th drone on the root; occasional 2-cell note gaps for groove",
        "sidechain": "16th:0.5 on hats, 4th on the bass",
        "extra": "long loops (8-16 bars), one element mutating at a time; rumble = degree 1 bass pad an octave or two down (low octave arg)",
    },
    "trance": {
        "bpm": "138-145",
        "kick": "x...x...x...x...",
        "clap_or_snare": "....x.......x...",
        "hat_offbeat": "..x...x...x...x.",
        "hat_closed": None, "openhat": "..o...o...o...o.",
        "bass": "offbeat 8ths on the root: .1.1.1.1.1.1.1.1 (the classic rolling bass)",
        "sidechain": "4th on everything except kick and offbeat bass",
        "extra": "driving 16th arps/saw leads in minor, long risers into the drop, huge reverb pads",
    },
    "edm": {
        "bpm": "128-150",
        "kick": "x...x...x...x...",
        "clap_or_snare": "....x.......x...",
        "hat_offbeat": "..x...x...x...x.",
        "hat_closed": None, "openhat": None,
        "bass": "root octaves on every kick in the drop; sparse sub under the verses",
        "sidechain": "4th on chords and pads",
        "extra": "build = hats doubling faster every bar, drop = kick + bass + lead together",
    },
    "future bass": {
        "bpm": "140-160",
        "kick": "x.......x.......",
        "clap_or_snare": "....x.......x...",
        "hat_offbeat": "..x.x.x.x.x.x.x.",
        "hat_closed": None, "openhat": None,
        "bass": "follow the chord roots, pitched down 1-2 octaves, short gate",
        "sidechain": "heavy 4th (depth ~0.8) on the supersaw chords",
        "extra": "supersaw chords (unison 6-8) with hard LFO gating: on -> 0.3 -> off every 8th",
    },
    "drum and bass": {
        "bpm": "170-176",
        "kick": "x......x..x.....",
        "clap_or_snare": "....x.......x...",
        "hat_closed": "5.5.5.5.5.5.5x",
        "hat_offbeat": None, "openhat": None,
        "bass": "long reese sub notes following the roots, glide between them",
        "sidechain": "4th on the bass against the kick",
        "extra": "the kick-snare pattern above is the classic two-step; half-time feel over fast hats",
    },
    "dubstep": {
        "bpm": "140",
        "kick": "x.......x.......",
        "clap_or_snare": "....x.......x...",
        "hat_offbeat": "..x...x...x...x.",
        "hat_closed": None, "openhat": None,
        "bass": "wobble: a filter LFO on the root, rate doubling 1/2 -> 1/4 -> 1/8 each cycle",
        "sidechain": "4th on the wobble bass",
        "extra": "half-time drums, space between the drops; growl = distortion + pitch dips",
    },
    "trap": {
        "bpm": "140 (half-time feel)",
        "kick": "x.....x...x.....",
        "clap_or_snare": "........x.......",
        "hat_closed": "xxxxxxxxxxxxxxxx",
        "hat_offbeat": None, "openhat": None,
        "bass": "808 glides from note to note, long decay, follows chord roots",
        "sidechain": "light 4th on the melodic layers only",
        "extra": "roll the closed hat in bursts: xxx.x..x then straight 16ths, triplet fills before the bar end",
    },
    "synthwave": {
        "bpm": "100-118",
        "kick": "x...x...x...x...",
        "clap_or_snare": "....x.......x...",
        "hat_closed": "..x...x...x...x.",
        "hat_offbeat": None, "openhat": None,
        "bass": "driving 8ths on the root: 1.1.1.1.1.1.1.1, chorus + octave up",
        "sidechain": "gentle 4th on pads",
        "extra": "minor keys, gated reverb snare, arpeggios and a wide saw lead",
    },
    "lo-fi hip hop": {
        "bpm": "70-90",
        "kick": "x......x.x......",
        "clap_or_snare": "....x.......x...",
        "hat_closed": "x.5.x.5.x.5.x.5.",
        "hat_offbeat": None, "openhat": None,
        "bass": "simple root notes on the kicks, muted tone",
        "sidechain": "barely - a soft 4th at depth ~0.3 if anything",
        "extra": "swing (subdivision shuffle), jazzy 7ths/9ths, vinyl hiss; keep velocities uneven (use digits, not x)",
    },
    "hip hop": {
        "bpm": "85-100",
        "kick": "x.....x...x.x...",
        "clap_or_snare": "....x.......x...",
        "hat_closed": "x.x.x.x.x.x.x.x.",
        "hat_offbeat": None, "openhat": None,
        "bass": "short punches answering the kick",
        "sidechain": "light 4th on the sample/chords",
        "extra": "swing feel; lay the melody in loops and chop with starts on odd cells",
    },
    "eurobeat": {
        "bpm": "150-170",
        "kick": "x...x...x...x...",
        "clap_or_snare": "....x.......x...",
        "hat_offbeat": "..x...x...x...x.",
        "hat_closed": None, "openhat": None,
        "bass": "rolling 16ths on the root with octave jumps",
        "sidechain": "4th on pads and chords",
        "extra": "minor key, fast lead melody on top of 16th arps, big risers before each chorus",
    },
}




def _step_char(v):
    """One bar-string character for a stored step velocity."""
    v = float(v)
    if v <= 0:
        return "."
    if v >= 1.0:
        return "x"
    return str(max(1, min(9, round(v * 9))))


def _bars_from_steps(steps, spb):
    """Stored velocity list -> list of bar strings, cells grouped in 4s."""
    spb = max(1, int(spb))
    bars = []
    for b in range(0, max(len(steps), spb), spb):
        seg = "".join(_step_char(v) for v in steps[b:b + spb]).ljust(spb, ".")
        bars.append(" ".join(seg[i:i + 4] for i in range(0, len(seg), 4)))
    return bars


# Deep reference docs, delivered by the get_help tool instead of bloating the
# tool schemas that ride along in every request.
HELP_TOPICS = {
    "workflow": (
        "1) set_tempo. 2) Define patterns (nothing sounds yet): create_drum_pattern (rhythm), "
        "create_note_pattern (melody/bass/pads). User audio samples can serve "
        "as drum voices (samples/fx/), pitched melody instruments (samples/note/) or song events (samples/song/) - see list_samples, get_help('samples'). "
        "Every pattern shares "
        "one transport: one tempo, one bar grid, patterns of any bar length stay in sync. "
        "3) Start them by name only: play_drum_pattern(name) / play_note_pattern(name). "
        "stop_loop/start_loop/remove_loop "
        "control them, stop_all_loops silences the chat. get_drum_pattern/get_note_pattern "
        "read an existing pattern back (notes included, ready to copy); edit_loop "
        "re-instruments or re-routes a pattern without retyping its notes; chord_progression "
        "turns chord symbols ('Am Em F C') into scale degrees to paste straight into "
        "create_note_pattern. 4) start_song "
        "arranges the named patterns into sections; while a song plays, the free play tools "
        "are rejected until stop_song. New layers join at the next restart of the longest "
        "playing loop, so phrasing lands aligned with what already plays."
    ),
    "drums": (
        "Drum patterns are painted beat strings - ONE STRING PER BEAT, one "
        "character per step. Default grid: steps_per_beat=4, so 4 chars per "
        "beat, 4 beats per 4/4 bar. x = full hit, digits 1-9 = hit scaled by "
        "velocity (9 = full), '.' = rest. Four-on-the-floor: "
        "beats=['x...', 'x...', 'x...', 'x...']. steps_per_beat sets the grid "
        "(2 = 8ths, 3 = triplets/shuffle, 6 = triplet-16ths, 8 = 32nds) and "
        "every string then holds exactly that many chars. Give a whole number "
        "of bars - the loop length is derived from the beat count; bar_length "
        "only repeats a short groove over more bars (tiling). On drum rows a "
        "dash is notation, not sound: hits ring out on their own. Built-in "
        "voices: kick, snare, clap, hihat_closed, hihat_open, tom, rim, "
        "cowbell; custom sounds from define_sound work as voices too, as do "
        "fx samples from the samples/fx/ folder (list_samples)."
    ),
    "melody": (
        "Melody notes are ['start-end', degree, velocity?] lists over a key "
        "like 'A minor'. Positions are INCLUSIVE step numbers counting over "
        "the grid: default steps_per_beat=4 (16 steps/bar), so a quarter "
        "spans 4 steps ('1-4', '5-8', '9-12', '13-16' = beats 1-4), an eighth "
        "spans 2, a whole bar is '1-16'. Steps number continuously across "
        "bars (bar 2 starts at 17 on the default grid). steps_per_beat shrinks "
        "or grows the bar: 3 gives a triplet grid (12 steps/bar, quarters "
        "1-3 / 4-6 / 7-9 / 10-12), 2 gives 8ths. The result of every create "
        "names the ruler - copy it, don't guess. Write notes in chronological "
        "order; chords = entries sharing a range. degree is a SCALE DEGREE, "
        "1-INDEXED (there is no "
        "degree 0): 1 = tonic, 2-7 the following scale steps, 8 = tonic an "
        "octave up, wrapping over any scale length; '#4' / 'b7' alter a "
        "degree. Reach lower by lowering the octave arg. velocity 0.0-1.0, "
        "default 0.8. The loop is as long as the latest note needs - leave "
        "bar_length at 0. key = root note + scale name ('A minor', "
        "'F# dorian'); the octave arg (default 4) sets which octave degree 1 "
        "starts in. Scales: major, minor, harmonic/melodic minor, harmonic "
        "major, dorian, phrygian, lydian, mixolydian, locrian, whole tone, "
        "hirajoshi, octatonic, major/minor pentatonic, blues, plus every "
        "derived mode (phrygian dominant, lydian dominant, altered, ukrainian "
        "dorian, ...). A bad scale name returns the full list. Note samples "
        "from samples/note/ work as instruments too - each note re-fires the "
        "file pitched to it, C4 reference (list_samples, get_help('samples'))."
    ),
    "fx": (
        "Per-loop FX chain (fx param): list of up to 4 stage dicts, applied in order "
        "before pan and sidechain ducking. dist {curve: tanh|fold|crush|hard, drive "
        "0-1, mix 0-1, bits 1-8 (crush only)}; chorus {rate 0.05-4 Hz, depth 0-1, mix "
        "0-1}; delay {sync: bar|1/1|1/2|1/4|1/4d|1/8|1/8d|1/8t|1/16|1/16d|1/16t "
        "tempo-synced OR time 0-2 s (0 = use sync), feedback 0-0.92, mix 0-1, damp "
        "200-16000 Hz, pingpong true/false}; verb {mix 0-1}. Example: "
        "[{\"type\": \"delay\", \"sync\": \"1/8\", \"feedback\": 0.4, \"mix\": 0.25}, "
        "{\"type\": \"verb\", \"mix\": 0.3}]."
    ),
    "sidechain": (
        "Sidechain pump (sidechain param) ducks the loop on a fixed grid - the EDM "
        "pumping feel. Format 'rate:depth:attack:release', only rate required: '4th', "
        "'8th:0.8', '16th:0.7:0.005:0.12'. rate: 4th (= kick/quarter), 8th, 16th "
        "(aliases kick/quarter/eighth/sixteenth). depth 0-0.95 (default 0.65); "
        "attack/release in seconds (defaults 0.006 / 0.22). Put '4th' on pads and "
        "basslines so the kick punches through. Empty = no ducking; "
        "edit_loop(sidechain='off') removes an existing pump."
    ),
    "sounds": (
        "define_sound(name, spec) designs a custom synth; it works anywhere a built-in "
        "does: voice= in create_drum_pattern (one-shot at spec's base_note, default 36), "
        "instrument= in create_note_pattern (at each note's pitch; set env.sustain > 0 "
        "for held notes). Re-defining a name updates playing loops live. spec keys "
        "(only osc required unless an engine key is set): osc = 1-4 layers "
        "[{type: sine|square|sawtooth|triangle, level 0-1, octave -3..3, detune cents}]; "
        "fm = FM patch {operators: 1-6 dicts [{ratio 0.25-32, level, feedback 0-0.9, "
        "attack/decay/sustain/release}], algorithm: {modulator_index: carrier_index or "
        "list}, output: [carrier indexes]}; pd = phase distortion {shape 0.02-0.98, "
        "shape_end, decay}; ring = ring mod {ratio (default 1.5) or freq Hz}; wt = "
        "wavetable {table: basic|saw|even|odd|quad|sparse|bell|vocal|organ|harmonics or "
        "a custom list of 1-64 per-harmonic amplitudes -1..1, pos_start/pos_end 0-1, "
        "pos_time s, curve 0.2-5, unison 0-8, detune, spread, lfo {rate, depth, "
        "target: pos|pitch, wave}} (lfo target=pos = dubstep wobble); chip = NES pulse "
        "{duty 0.03-0.5, duty_end, arp: up to 8 semitone offsets, arp_rate 1-100}; "
        "grain = granular cloud {size s, grains/s rate, scatter, src: sine|noise}; "
        "sweep = riser {src: noise|sine|square|sawtooth|triangle, from/to Hz (0 = "
        "auto), curve 0.2-5, level}; noise = {level, filter: lowpass|highpass|bandpass, "
        "freq}; filter = {type, cutoff 20-20000, q 0-30, poles 1|2, keytrack 0-1, env: "
        "semitones above cutoff falling to cutoff (-48..48, env_time s) or {from, to, "
        "attack, decay}} (env 24-36 = classic pluck); env = {attack <=10 s, decay <=12 "
        "s, sustain 0-1, release <=8 s} (ping: 0.002/0.4/0; pad: 0.3/0.2/0.8/0.5; "
        "riser: attack 4, sustain 1); pitch = {glide: semitones above note, falling "
        "(-36..36), glide_time}; lfo = up to 4 voice LFOs {target: pitch (depth 1 = a "
        "semitone)|cutoff (needs a filter)|amp, wave, rate Hz 0.05-40 or tempo sync "
        "(bar, 1/1...1/16t), depth 0-1, delay s}; unison = stack the whole engine "
        "{voices 1-8, detune 0-1, spread 0-1} (supersaw trick; grain/sweep stay "
        "single). Example laser: {\"osc\": [{\"type\": \"sawtooth\"}], \"pitch\": "
        "{\"glide\": 24}, \"filter\": {\"cutoff\": 6000, \"env\": 36}, \"env\": "
        "{\"attack\": 0.002, \"decay\": 0.25}, \"base_note\": 72}"
    ),
    "visuals": (
        "Visual cues bind to a SOUND (a drum voice or instrument), so every hit of it "
        "pulses the effect (a chord's simultaneous notes merge into one pulse). Set "
        "them with edit_loop(visual=...) - binds the cue to that loop's sound. "
        "One-shot effects pulse on each hit: flash, bloom, spark, drip, laser, ripple, "
        "wave, plasma, aurora, prism, strobe, pulse. Persistent effects run while "
        "attached and react continuously: wheel (segmented circle lighting the pitch "
        "class of each note, spinning one segment per kick), motes, vortex, soundwave "
        "(follows the instrument's spectrum). Persistent cues are strictly opt-in and "
        "never self-start - clear with visual='off' when the vibe ends. Built-in "
        "defaults: kick->flash, snare->ripple."
    ),
    "song": (
        "start_song(title, sections, loop) arranges existing patterns. sections = list "
        "of {name?, bars (1-64), layers}, max 512 bars total. layers = pattern names or "
        "{\"loop\": name, \"volume\": 0.0-1.0, \"pan\": -1..1}; a section pan overrides "
        "the loop's own pan and can move a layer mid-song. An empty layers list is a "
        "break. Sections switch their layers exactly at bar boundaries. While a song "
        "plays, the free play tools are rejected; stop_song returns to free mode; "
        "song_status shows the live position. Example: [{\"name\": \"intro\", "
        "\"bars\": 4, \"layers\": [\"pad\"]}, {\"name\": \"drop\", \"bars\": 8, "
        "\"layers\": [\"pad\", \"kick groove\", {\"loop\": \"bassline\", "
        "\"volume\": 0.7}]}] Samples from samples/song/ can be fired at fixed "
        "timeline points with events=[{\"sample\": name, \"at\": bar, "
        "\"volume\"?, \"pan\"?}] - at = bars from song start, fractions ok; "
        "get_help('samples')."
    ),
    "samples": (
        "The user drops audio files into the module's samples folders "
        "(music_sequencer/webui/assets/samples/), three kinds by subfolder: "
        "samples/fx/ one-shots are drum pattern voices (voice= in "
        "create_drum_pattern, and in edit_loop for drum loops - each hit plays "
        "the whole file, velocity scales its gain); samples/note/ one-shots "
        "are melody instruments (instrument= in create_note_pattern, and in "
        "edit_loop for note loops - every note re-fires the file pitched to "
        "it via playback rate, C4/middle-C reference, so a sample recorded at "
        "C4 plays in tune; the file rings its natural length regardless of "
        "note duration, chords stack copies); samples/song/ one-shots are "
        "arrangement material fired by start_song's events param at fixed bar "
        "offsets (events=[{\"sample\": \"riser\", \"at\": 7.5}] fires halfway "
        "into bar 8; volume/pan optional, re-fired every loop pass). The "
        "filename (lowercased, punctuation to dashes, max 32 chars) is the "
        "sample name; names clashing with built-ins are ignored. Samples are "
        "shared across all chats. After the user adds files, call "
        "list_samples once - it shows what arrived and refreshes every open "
        "browser's copy. A sample's very first hit may land a moment late "
        "while the browser decodes it."
    ),
}


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
        "advanced_mode": {
            "type": "boolean",
            "description": "Expose the advanced tools (define_sound, remove_sound, list_sounds, set_time_signature). Keep OFF for small models: everything else stays fully usable and get_help still explains it all.",
            "default": False,
        },
        "theory_assist": {
            "type": "boolean",
            "description": "Expose the music-theory helper tools (suggest_chords, suggest_scale, genre_pattern). Handy for models without music theory knowledge, but they also lean on canned progressions/grooves - keep OFF to push the model to write its own.",
            "default": False,
        },
    }

    # tools only registered when the advanced_mode setting is on; the module
    # reloads (and re-registers) whenever its settings change
    ADVANCED_TOOLS = ["define_sound", "remove_sound", "list_sounds", "set_time_signature"]

    # theory crutches, only registered when theory_assist is on
    THEORY_TOOLS = ["suggest_chords", "suggest_scale", "genre_pattern"]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if not self.config.get("advanced_mode"):
            self.disabled_tools.extend(t for t in self.ADVANCED_TOOLS if t not in self.disabled_tools)
        if not self.config.get("theory_assist"):
            self.disabled_tools.extend(t for t in self.THEORY_TOOLS if t not in self.disabled_tools)

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

    def _samples(self, kind=None):
        """User audio files under webui/assets/samples/{fx,song}/ ->
        {name: {file, url, bytes, kind}}. fx samples are drum-voice one-shots;
        song samples are arrangement events. The filename stem = sample name;
        built-in clashes and duplicates are skipped."""
        out = {}
        for k in (("fx", "note", "song") if kind is None else (str(kind),)):
            root = os.path.join(SAMPLES_DIR, k)
            try:
                entries = sorted(os.listdir(root))
            except OSError:
                continue
            for fn in entries:
                stem, ext = os.path.splitext(fn)
                if ext.lower() not in SAMPLE_EXTS:
                    continue
                name = _sample_file_name(stem)
                if not name or name in BUILTIN_NAMES or name in out:
                    continue
                try:
                    size = os.path.getsize(os.path.join(root, fn))
                except OSError:
                    continue
                out[name] = {
                    "file": fn,
                    "url": "/ext-assets/music_sequencer/samples/" + urllib.parse.quote(f"{k}/{fn}"),
                    "bytes": size,
                    "kind": k,
                }
        return out

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

    def _beats_per_bar(self, chat_id):
        m = METER_RE.match(self._meter_name(chat_id))
        return int(m.group(1)) if m else 4

    def _steps_per_beat(self, value, subdivision, chat_id):
        """Grid resolution -> (steps_per_beat, beats_per_bar, error). Accepts an
        int or a legacy subdivision name; default = the chat meter's grid."""
        bpq = self._beats_per_bar(chat_id)
        raw = value if (value is not None and str(value).strip()) else subdivision
        if raw is None or not str(raw).strip():
            return max(1, self._meter(chat_id) // bpq), bpq, None
        if isinstance(raw, str):
            s = raw.strip().lower()
            s = STEPS_PER_BEAT_ALIASES.get(s, s)
            if not s.lstrip("+-").isdigit():
                return None, bpq, (f"steps_per_beat {value!r} must be a whole number of steps per beat "
                                   "(4 = 16ths, 2 = 8ths, 3 = triplets, 8 = 32nds) or a name like 'triplets'.")
            raw = s
        try:
            spb = int(float(raw))
        except (TypeError, ValueError):
            return None, bpq, f"steps_per_beat {value!r} must be a whole number between 1 and 16."
        if spb < 1 or spb > 16:
            return None, bpq, "steps_per_beat must be between 1 and 16."
        return spb, bpq, None

    def _ruler(self, spb, bpq):
        marks = ", ".join(str(b * spb + 1) for b in range(bpq))
        return f"grid: {spb} steps/beat x {bpq} beats = {spb * bpq}/bar - beats start on {marks}"

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
    async def get_help(self, topic: str = "workflow"):
        """
        Full reference docs for the sequencer

        Args:
            topic: One of: workflow, drums, melody, fx, sidechain, sounds, samples, visuals, song - or 'all'.
        """
        t = str(topic or "").strip().lower()
        if t == "all":
            return self.result(dict(HELP_TOPICS), success=True)
        if t not in HELP_TOPICS:
            return self.result(f"Unknown topic '{topic}'. Topics: {', '.join(HELP_TOPICS)}, all.", success=False)
        return self.result(HELP_TOPICS[t], success=True)

    @core.module.tool
    async def create_drum_pattern(self, name: str, voice: str, beats: list = None, steps_per_beat: str = "", bar_length: int = 0, volume: float = 1.0, pan: float = 0.0, sidechain: str = "", fx: list = None, steps: list = None, subdivision: str = ""):
        """
        Define a drum pattern and store it (it does NOT play yet - start it
        with play_drum_pattern(name)). Pattern = painted beat strings, ONE
        STRING PER BEAT, one character per step (default grid: 4 steps per
        beat = 16ths): x = hit, 1-9 = hit by velocity, '.' = rest.

        Example: create_drum_pattern(name="kick groove", voice="kick",
          beats=["x...", "x...", "x...", "x..."])

        Args:
            name: Unique pattern name, e.g. 'kick groove' (duplicates rejected).
            beats: One string per beat, each exactly steps_per_beat chars. Give a whole number of bars (4 beats/bar in 4/4) - the loop length derives from the beat count. Triplet grid: steps_per_beat=3 with 3-char strings like 'x.x'. Details in get_help('drums').
            steps_per_beat: Grid resolution = steps held by one beat (default 4 = 16ths; 2 = 8ths, 3 = triplets/shuffle, 8 = 32nds; 1-16. Legacy names 'triplets', 'shuffle', 'double-shuffle'... accepted).
            bar_length: Only to repeat a short groove over more bars (tiling); leave 0 to derive the loop from the beat count.
            voice: kick, snare, clap, hihat_closed, hihat_open, tom, rim, cowbell, a custom sound, or an fx sample name (list_samples).
            volume: 0.0-1.0.
            pan: -1 (left) .. 1 (right).
            sidechain: Volume pump on a grid, e.g. "4th" or "16th:0.8" (get_help('sidechain')).
            fx: FX chain, e.g. [{"type": "verb", "mix": 0.3}] (get_help('fx')).
            steps: (legacy flat bar strings - use beats.)
            subdivision: (legacy - use steps_per_beat.)
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        loop_id = _norm_name(name)
        if not loop_id:
            return self.result("name is required.", success=False)
        if loop_id in self._loops(chat_id):
            return self.result(f"A pattern named '{loop_id}' already exists. remove_loop it first, or pick another name.", success=False)
        voice = str(voice).strip().lower()
        samples = self._samples("fx")
        if voice not in DRUM_VOICES and voice not in self._sounds(chat_id) and voice not in samples:
            custom = ", ".join(sorted(self._sounds(chat_id))) or "none defined"
            smps = ", ".join(sorted(samples)) or "none in samples/fx/"
            return self.result(f"Unknown drum voice '{voice}'. Built-in: {', '.join(DRUM_VOICES)}. Custom: {custom}. Fx samples: {smps}.", success=False)
        try:
            bars = int(bar_length)
        except (TypeError, ValueError):
            return self.result("bar_length must be an integer (0 = derive from the beats).", success=False)
        if bars < 0 or bars > MAX_BAR_LENGTH:
            return self.result(f"bar_length must be between 0 and {MAX_BAR_LENGTH}.", success=False)
        spb, bpq, gerr = self._steps_per_beat(steps_per_beat, subdivision, chat_id)
        if gerr:
            return self.result(gerr, success=False)
        grid = spb * bpq
        tiled = ""
        if beats:
            if isinstance(beats, str):
                beats = [beats]
            if not isinstance(beats, list) or not beats:
                return self.result("beats must be a list of beat strings, one per beat.", success=False)
            beat_cells = []
            for i, b in enumerate(beats):
                s = re.sub(r"[ |]", "", str(b))
                if not s:
                    return self.result(f"beat {i + 1} is empty.", success=False)
                if len(s) != spb:
                    return self.result(f"beat {i + 1} ('{b}') has {len(s)} steps - expected {spb} (steps_per_beat={spb}). One string per beat: 'x...' = a hit on the beat.", success=False)
                cells = []
                for ch in s:
                    v = _step_velocity(ch)
                    if v is None:
                        return self.result(f"Invalid character {ch!r} in beat {i + 1}; use 1-9, x, '.' or '-'.", success=False)
                    cells.append(v)
                beat_cells.append(cells)
            if len(beat_cells) > 1024:
                return self.result("Too many beats (max 1024 per pattern).", success=False)
            if bars == 0:
                if len(beat_cells) % bpq:
                    return self.result(f"{len(beat_cells)} beats is not a whole number of bars ({bpq} beats/bar in {self._meter_name(chat_id)}). Give {len(beat_cells) - len(beat_cells) % bpq} beats, or set bar_length.", success=False)
                bars = max(1, len(beat_cells) // bpq)
            if bars > MAX_BAR_LENGTH:
                return self.result(f"the beats given would make a {bars}-bar loop - max is {MAX_BAR_LENGTH}.", success=False)
            canvas = bars * bpq
            if len(beat_cells) != canvas:
                tiled = f" Pattern was {len(beat_cells)} beats; repeated/truncated to {canvas} ({bars} bar{'s' if bars > 1 else ''})."
                beat_cells = (beat_cells * (canvas // len(beat_cells) + 1))[:canvas]
            pattern = [v for cells in beat_cells for v in cells]
        elif steps:
            # legacy intake: flat bar strings tiled to the grid
            if isinstance(steps, str):
                steps = [steps]
            if not isinstance(steps, list) or not steps:
                return self.result("beats must be a list of beat strings, one per beat.", success=False)
            raw = re.sub(r"[ |]", "", "".join(str(s) for s in steps))
            if not raw:
                return self.result("steps is empty after stripping grouping characters.", success=False)
            pattern = []
            for ch in raw:
                v = _step_velocity(ch)
                if v is None:
                    return self.result(f"Invalid character {ch!r} in steps; use 1-9, x, '.', '-' or '_'.", success=False)
                pattern.append(v)
            if bars == 0:
                bars = max(1, -(-len(pattern) // grid))
            if bars > MAX_BAR_LENGTH:
                return self.result(f"the pattern would make a {bars}-bar loop - max is {MAX_BAR_LENGTH}.", success=False)
            target = bars * grid
            if len(pattern) != target:
                tiled = f" Pattern was {len(raw)} cells; tiled/repeat-truncated to {target}."
                pattern = (pattern * (target // len(pattern) + 1))[:target]
        else:
            return self.result("beats is required: one string per beat, e.g. beats=['x...', 'x...', 'x...', 'x...'].", success=False)
        sc, sc_err = _clean_sidechain(sidechain)
        if sc_err:
            return self.result(sc_err, success=False)
        fxs, fx_err = _clean_fx(fx)
        if fx_err:
            return self.result(fx_err, success=False)
        definition = {
            "kind": "drum",
            "voice": voice,
            "bar_length": bars,
            "steps_per_bar": grid,
            "steps_per_beat": spb,
            "beats_per_bar": bpq,
            "steps": pattern,
            "volume": _velocity(volume, 1.0),
            "playing": False,
        }
        panv = _num(pan, 0.0, -1.0, 1.0)
        if panv:
            definition["pan"] = panv
        if sc:
            definition["sidechain"] = sc
        if fxs:
            definition["fx"] = fxs
        loops = dict(self._loops(chat_id))
        loops[loop_id] = definition
        self._store_loops(chat_id, loops)
        await self._push(chat_id, {"type": "music_sequencer:define", "loop": dict(definition, id=loop_id)})
        return self.result(
            f"Stored {voice} drum pattern '{loop_id}' ({bars} bar{'s' if bars > 1 else ''}, {bars * bpq} beats). "
            f"{self._ruler(spb, bpq)}.{tiled} "
            f"Start it with play_drum_pattern(name='{loop_id}').",
            success=True,
        )

    @core.module.tool
    async def play_drum_pattern(self, name: str):
        """
        Starts a stored drum pattern by name (define it first with
        create_drum_pattern). Joins the shared transport at the next restart
        of the longest playing loop, in sync with everything already playing.

        Args:
            name: Exact pattern name (see list_loops).
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
            return self.result(f"No pattern named '{name}' in this chat. Define it with create_drum_pattern first.", success=False)
        if definition.get("kind") != "drum":
            return self.result(f"'{loop_id}' is a {definition.get('kind')} pattern - start it with play_note_pattern.", success=False)
        if definition.get("playing"):
            return self.result(f"Pattern '{loop_id}' is already playing.", success=False)
        if self._playing_count(chat_id) >= MAX_LAYERS:
            return self.result(f"Cannot start: {MAX_LAYERS} layers are already playing. Stop one first.", success=False)
        loops = dict(loops)
        loops[loop_id] = dict(definition, playing=True)
        self._store_loops(chat_id, loops)
        await self._push(chat_id, {"type": "music_sequencer:play", "loop": dict(definition, id=loop_id)})
        return self.result(f"Started drum pattern '{loop_id}' ({self._playing_count(chat_id)}/{MAX_LAYERS} layers live), joining at the next cycle boundary.", success=True)

    @core.module.tool
    async def create_note_pattern(self, name: str, notes: list, steps_per_beat: str = "", bar_length: int = 0, instrument: str = "piano", volume: float = 1.0, key: str = "C major", octave: int = 4, pan: float = 0.0, sidechain: str = "", fx: list = None, subdivision: str = ""):
        """
        Define a melody and store it (it does NOT play yet - start it with
        play_note_pattern(name)). Each note is ["start-end", degree, velocity?]
        with INCLUSIVE step positions counting over the loop's grid (step 1 =
        first step; at the default grid a quarter note spans 4 steps: '1-4',
        '5-8'...), and degrees 1-INDEXED over the key (1 = tonic, 8 = tonic an
        octave up, '#4'/'b7' altered). The loop is as long as the latest note
        needs.

        Example: create_note_pattern(name="bassline", key="A minor",
          notes=[["1-4", "1"], ["5-8", "1"], ["9-12", "3"], ["13-16", "5", 0.7]])

        Args:
            name: Unique pattern name (duplicates rejected).
            notes: List of ["start-end", degree, velocity?] lists. Positions are inclusive step numbers over the grid (default 4 steps/beat, 16/bar): '1-4' = a quarter on beat 1, '5-6' = an eighth on beat 2. Write notes in chronological order and give chords as entries sharing a range. velocity 0.0-1.0 (default 0.8). More in get_help('melody').
            steps_per_beat: Grid resolution = steps held by one beat (default 4 = 16ths, steps run 1-4; 3 = triplet grid with steps 1-3; 1-16. Legacy names 'triplets', 'shuffle'... accepted).
            bar_length: Leave 0 - the loop derives from the notes. Set only to add silent bars at the end.
            instrument: piano, bass, pad, lead, pluck, bells, sine, square, triangle, saw, organ, strings, synbrass, flute, musicbox, a custom sound, or a note sample name (list_samples; pitched to each note, C4 reference).
            volume: 0.0-1.0.
            key: Root note + scale name, e.g. "A minor", "F# dorian", "C major pentatonic". A bad scale name returns the full list.
            octave: Which octave degree 1 starts in (0-8, default 4); higher degrees reach up from there.
            pan: -1 (left) .. 1 (right).
            sidechain: Volume pump on a grid, e.g. "4th" or "16th:0.8" (get_help('sidechain')).
            fx: FX chain, e.g. [{"type": "verb", "mix": 0.3}] (get_help('fx')).
            subdivision: (legacy - use steps_per_beat.)
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        loop_id = _norm_name(name)
        if not loop_id:
            return self.result("name is required.", success=False)
        if loop_id in self._loops(chat_id):
            return self.result(f"A pattern named '{loop_id}' already exists. remove_loop it first, or pick another name.", success=False)
        instrument = str(instrument).strip().lower()
        samples = self._samples("note")
        if instrument not in INSTRUMENTS and instrument not in self._sounds(chat_id) and instrument not in samples:
            custom = ", ".join(sorted(self._sounds(chat_id))) or "none defined"
            smps = ", ".join(sorted(samples)) or "none in samples/note/"
            return self.result(f"Unknown instrument '{instrument}'. Built-in: {', '.join(INSTRUMENTS)}. Custom: {custom}. Note samples: {smps}.", success=False)
        try:
            bars = int(bar_length)
        except (TypeError, ValueError):
            return self.result("bar_length must be an integer (0 = derive from the notes).", success=False)
        if bars < 0 or bars > MAX_BAR_LENGTH:
            return self.result(f"bar_length must be between 0 and {MAX_BAR_LENGTH}.", success=False)
        spb, bpq, gerr = self._steps_per_beat(steps_per_beat, subdivision, chat_id)
        if gerr:
            return self.result(gerr, success=False)
        grid = spb * bpq
        if not isinstance(notes, list) or not notes:
            return self.result("notes must be a non-empty list of ['start-end', degree, velocity?] lists.", success=False)
        if len(notes) > 512:
            return self.result("Too many notes (max 512 per pattern).", success=False)
        try:
            octv = int(octave)
        except (TypeError, ValueError):
            return self.result("octave must be an integer between 0 and 8.", success=False)
        root_midi, scale, scale_name, key_err = _parse_key(key, octv)
        if key_err:
            return self.result(key_err, success=False)
        degree_err = ("note {} has an invalid degree ({!r}). Degrees are 1-indexed scale steps: 1 = tonic, 8 = octave up, '#4'/'b7' altered. There is no degree 0 - reach lower by lowering the octave arg instead.")
        segs = []
        out_of_order = False
        prev_start = 0
        for i, n in enumerate(notes):
            if not isinstance(n, list) or len(n) < 2:
                return self.result(f"note {i} must be ['start-end', degree] or ['start-end', degree, velocity].", success=False)
            rng = n[0]
            if isinstance(rng, str) and "-" in rng:
                if len(n) > 3:
                    return self.result(f"note {i} has too many fields: ['start-end', degree, velocity?].", success=False)
                ends = rng.split("-")
                if len(ends) != 2:
                    return self.result(f"note {i} range {rng!r} must be 'start-end', e.g. '1:1-2:4'.", success=False)
                cells = []
                for what, token in zip(("start", "end"), ends):
                    s = str(token).strip()
                    if not s.isdigit():
                        return self.result(f"note {i} {what} {token!r} must be a step number - '1-4' spans the loop's first four steps.", success=False)
                    step = int(s)
                    if step < 1:
                        return self.result(f"note {i}: steps are numbered from 1 - '1' is the loop's first step.", success=False)
                    cells.append(step)
                if cells[1] < cells[0]:
                    return self.result(f"note {i} range {rng!r} is reversed - the end must not come before the start.", success=False)
                midi = _resolve_pitch(n[1], root_midi, scale)
                if midi is None or midi < 12 or midi > 127:
                    return self.result(degree_err.format(i, n[1]), success=False)
                start0, length = cells[0] - 1, cells[1] - cells[0] + 1
                vel = _velocity(n[2], 0.8) if len(n) > 2 else 0.8
                label = rng
            else:
                # legacy intake: [pitch, start, length?, velocity?] in grid cells
                if len(n) > 4:
                    return self.result(f"note {i} must be ['start-end', degree, velocity?].", success=False)
                midi = _resolve_pitch(rng, root_midi, scale)
                if midi is None or midi < 12 or midi > 127:
                    return self.result(degree_err.format(i, rng), success=False)
                try:
                    start0 = int(n[1])
                    length = int(n[2]) if len(n) > 2 else 4
                except (TypeError, ValueError):
                    return self.result(f"note {i} has non-integer start/length.", success=False)
                if start0 < 0:
                    return self.result(f"note {i} starts before the loop (step {start0}).", success=False)
                length = max(1, length)
                vel = _velocity(n[3], 0.8) if len(n) > 3 else 0.8
                label = f"note {i}"
            if start0 < prev_start:
                out_of_order = True
            prev_start = start0
            segs.append({"pitch": midi, "start": start0, "length": length, "velocity": vel, "label": label})
        max_end = max(s["start"] + s["length"] for s in segs)
        if bars == 0:
            bars = max(1, -(-max_end // grid))
        if bars > MAX_BAR_LENGTH:
            return self.result(f"the notes reach beyond {MAX_BAR_LENGTH} bars ({bars} needed) - shorten the pattern.", success=False)
        canvas = bars * grid
        if max_end > canvas:
            return self.result(f"notes reach step {max_end} but {bars} bars hold {canvas} steps on this grid ({grid} steps/bar). Leave bar_length at 0 to size the loop automatically.", success=False)
        by_pitch = {}
        for s in segs:
            by_pitch.setdefault(s["pitch"], []).append(s)
        for group in by_pitch.values():
            group.sort(key=lambda s: s["start"])
            for a, b in zip(group, group[1:]):
                if b["start"] < a["start"] + a["length"]:
                    return self.result(f"notes '{a['label']}' and '{b['label']}' overlap on the same pitch - shorten one of them.", success=False)
        clean_notes = [{"pitch": s["pitch"], "start": s["start"], "length": s["length"], "velocity": s["velocity"]} for s in segs]
        sc, sc_err = _clean_sidechain(sidechain)
        if sc_err:
            return self.result(sc_err, success=False)
        fxs, fx_err = _clean_fx(fx)
        if fx_err:
            return self.result(fx_err, success=False)
        definition = {
            "kind": "note",
            "instrument": instrument,
            "bar_length": bars,
            "steps_per_bar": grid,
            "steps_per_beat": spb,
            "beats_per_bar": bpq,
            "key": f"{SHARP_NAMES[root_midi % 12]}{root_midi // 12 - 1} {scale_name}",
            "notes": clean_notes,
            "volume": _velocity(volume, 1.0),
            "playing": False,
        }
        panv = _num(pan, 0.0, -1.0, 1.0)
        if panv:
            definition["pan"] = panv
        if sc:
            definition["sidechain"] = sc
        if fxs:
            definition["fx"] = fxs
        loops = dict(self._loops(chat_id))
        loops[loop_id] = definition
        self._store_loops(chat_id, loops)
        await self._push(chat_id, {"type": "music_sequencer:define", "loop": dict(definition, id=loop_id)})
        order_note = " Note: entries are not in chronological order - list each note where it starts (chords sharing a range are fine)." if out_of_order else ""
        return self.result(
            f"Stored {instrument} melody pattern '{loop_id}' ({len(clean_notes)} notes, {bars} bar{'s' if bars > 1 else ''}, key {definition['key']}). "
            f"{self._ruler(spb, bpq)}.{order_note} "
            f"Start it with play_note_pattern(name='{loop_id}').",
            success=True,
        )

    @core.module.tool
    async def play_note_pattern(self, name: str):
        """
        Starts a stored melody or arp pattern by name (define it first with
        create_note_pattern). Joins the shared transport at the
        next restart of the longest playing loop, in sync with everything
        already playing.

        Args:
            name: Exact pattern name (see list_loops).
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
            return self.result(f"No pattern named '{name}' in this chat. Define it with create_note_pattern first.", success=False)
        if definition.get("kind") not in ("note", "arp"):
            return self.result(f"'{loop_id}' is a {definition.get('kind')} pattern - start it with play_drum_pattern.", success=False)
        if definition.get("playing"):
            return self.result(f"Pattern '{loop_id}' is already playing.", success=False)
        if self._playing_count(chat_id) >= MAX_LAYERS:
            return self.result(f"Cannot start: {MAX_LAYERS} layers are already playing. Stop one first.", success=False)
        loops = dict(loops)
        loops[loop_id] = dict(definition, playing=True)
        self._store_loops(chat_id, loops)
        await self._push(chat_id, {"type": "music_sequencer:play", "loop": dict(definition, id=loop_id)})
        return self.result(f"Started {definition.get('kind')} pattern '{loop_id}' ({self._playing_count(chat_id)}/{MAX_LAYERS} layers live), joining at the next cycle boundary.", success=True)

    @core.module.tool
    async def stop_loop(self, name: str):
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
            name: The loop's name, as given to create_drum_pattern/create_note_pattern.
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
        Sets the time signature for all loops

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
        """Lists this chat's loop layers"""
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
            if d.get("kind") == "arp":
                entry["key"] = d.get("key")
                entry["arp"] = f"{d.get('arp_mode')} x{len(d.get('seq', []))} every {d.get('step')} step(s), gate {d.get('gate')}"
                if d.get("offset"):
                    entry["offbeat"] = True
            if d.get("pan"):
                entry["pan"] = d["pan"]
            if d.get("sidechain"):
                entry["sidechain"] = d["sidechain"]["rate"]
            if d.get("fx"):
                entry["fx"] = [s["type"] for s in d["fx"]]
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
    async def start_song(self, title: str, sections: list, loop: bool = False, events: list = None):
        """
        Arranges the chat's named loops into a full song and plays it. Patterns must already
        exist (create_drum_pattern / create_note_pattern / create_arp); they
        need not be playing - the song starts the ones each section lists.

        Args:
            title: Song name for display.
            sections: Ordered arrangement; each {name?, bars, layers}. bars: 1-64 meter bars. layers: loops active in that section - each entry a loop name, or {"loop": name, "volume": 0.0-1.0, "pan": -1..1}; a section pan overrides the loop's own pan (absent = keep the loop's), and can move a layer mid-song. An empty list is a break. Max 512 bars total. E.g. [{"name": "intro", "bars": 4, "layers": ["pad"]}, {"name": "verse", "bars": 8, "layers": ["pad", "kick groove", {"loop": "bassline", "volume": 0.7}]}, {"name": "chorus", "bars": 8, "layers": ["pad", "kick groove", "bassline", {"loop": "lead melody", "pan": -0.6}]}]
            loop: Repeat the arrangement forever instead of ending after the final section.
            events: Optional one-shots from the song samples folder (samples/song/ - see list_samples) fired at fixed timeline points. Each {sample, at, volume?, pan?}: at = bar offset from the song start (0 = first beat, fractions welcome, e.g. 7.5 = halfway into bar 8). Re-fired on every loop pass. E.g. [{"sample": "riser", "at": 7.5}, {"sample": "impact", "at": 8, "volume": 0.9}]
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
                entry = {"name": lname, "volume": _velocity(l.get("volume", 1.0), 1.0) if isinstance(l, dict) else 1.0}
                if isinstance(l, dict) and l.get("pan") is not None:
                    entry["pan"] = _num(l.get("pan"), 0.0, -1.0, 1.0)
                clean_layers.append(entry)
            clean_sections.append({"name": str(s.get("name") or "").strip() or f"Part {i + 1}", "bars": bars, "layers": clean_layers})
        clean_events = []
        if events:
            if not isinstance(events, list):
                return self.result("events must be a list of dicts with keys sample, at, volume?, pan?.", success=False)
            if len(events) > 64:
                return self.result("Too many events (max 64 per song).", success=False)
            song_samples = self._samples("song")
            if not song_samples:
                return self.result("events need song samples: the samples/song/ folder is empty. Ask the user to drop audio files into music_sequencer/webui/assets/samples/song/ (see list_samples).", success=False)
            for i, ev in enumerate(events):
                if not isinstance(ev, dict):
                    return self.result(f"event {i} must be a dict with keys sample, at, volume?, pan?.", success=False)
                sname = str(ev.get("sample", "")).strip().lower()
                if sname not in song_samples:
                    return self.result(f"event {i}: unknown song sample '{sname}'. Song samples: {', '.join(sorted(song_samples))}. (Fx samples cannot be song events - move the file to samples/song/.)", success=False)
                if not _is_number(ev.get("at")):
                    return self.result(f"event {i} needs 'at': a bar offset from the song start (0 = first beat, fractions ok).", success=False)
                atv = _num(ev.get("at"), 0.0, 0.0, 511.0)
                if atv >= total:
                    return self.result(f"event {i} fires at bar {atv:g} but the song is only {total} bars long.", success=False)
                ce = {"sample": sname, "at": atv}
                if ev.get("volume") is not None:
                    ce["volume"] = _velocity(ev.get("volume"), 1.0)
                if ev.get("pan") is not None:
                    ce["pan"] = _num(ev.get("pan"), 0.0, -1.0, 1.0)
                clean_events.append(ce)
            clean_events.sort(key=lambda e: e["at"])
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
        if clean_events:
            song["events"] = clean_events
        self._store_song(chat_id, song)
        await self._push(chat_id, {"type": "music_sequencer:song", "song": dict(song)})
        bar_sec = self._meter(chat_id) * (60.0 / self._tempo(chat_id) / 4.0)
        plan = " / ".join(f"{s['name']} ({s['bars']})" for s in clean_sections)
        ev_note = f" {len(clean_events)} sample event(s)." if clean_events else ""
        return self.result(f"Song '{song['title']}' started: {total} bars ~{total * bar_sec:.0f}s at {self._tempo(chat_id):g} BPM {self._meter_name(chat_id)} - {plan}.{ev_note}", success=True)

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
        evs = song.get("events") or []
        if evs:
            out["events"] = [f"bar {e.get('at', 0):g}: {e.get('sample')}" for e in evs]
        if current:
            out["now"] = current
        if not song.get("loop"):
            out["remaining_seconds"] = max(0, round((total - pos) * bar_sec))
        return self.result(out, success=True)


    @core.module.tool
    async def get_drum_pattern(self, name: str):
        """Read a stored drum pattern"""
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        loop_id = _norm_name(name)
        d = self._loops(chat_id).get(loop_id)
        if not d:
            return self.result(f"No pattern named '{name}' in this chat.", success=False)
        if d.get("kind") != "drum":
            return self.result(f"Pattern '{loop_id}' is a {d.get('kind')} pattern - use get_note_pattern for it.", success=False)
        spb = int(d.get("steps_per_beat") or 4)
        bpq = int(d.get("beats_per_bar") or 4)
        pat = d.get("steps", [])
        beats = ["".join(_step_char(v) for v in pat[i:i + spb]).ljust(spb, ".") for i in range(0, len(pat), spb)]
        out = {
            "name": loop_id,
            "voice": d.get("voice"),
            "bar_length": d.get("bar_length"),
            "steps_per_beat": spb,
            "beats": beats,
            "grid": self._ruler(spb, bpq),
            "volume": d.get("volume"),
            "playing": bool(d.get("playing")),
        }
        if d.get("pan"):
            out["pan"] = d["pan"]
        if d.get("sidechain"):
            out["sidechain"] = d["sidechain"]
        if d.get("fx"):
            out["fx"] = d["fx"]
        return self.result(out, success=True)

    @core.module.tool
    async def get_note_pattern(self, name: str):
        """Read a stored melody pattern"""
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        loop_id = _norm_name(name)
        d = self._loops(chat_id).get(loop_id)
        if not d:
            return self.result(f"No pattern named '{name}' in this chat.", success=False)
        if d.get("kind") == "drum":
            return self.result(f"Pattern '{loop_id}' is a drum pattern - use get_drum_pattern for it.", success=False)
        key = d.get("key", "C major")
        root, scale, _, err = _parse_key(key)
        if err:
            root, scale = 60, SCALES["major"]
        spb = int(d.get("steps_per_beat") or 4)
        out = {
            "name": loop_id,
            "kind": d.get("kind"),
            "instrument": d.get("instrument"),
            "key": key,
            "bar_length": d.get("bar_length"),
            "steps_per_beat": spb,
            "volume": d.get("volume"),
            "playing": bool(d.get("playing")),
        }
        if d.get("kind") == "note":
            out["grid"] = self._ruler(spb, int(d.get("beats_per_bar") or 4))
            out["notes"] = [
                [f"{int(n['start']) + 1}-{int(n['start']) + int(n['length'])}", _midi_to_degree(n["pitch"], root, scale), round(n.get("velocity", 0.8), 2)]
                for n in d.get("notes", [])
            ]
        else:
            out["arp"] = {
                "mode": d.get("arp_mode"),
                "step": d.get("step"),
                "gate": d.get("gate"),
                "offset": d.get("offset", 0),
                "velocity": d.get("velocity"),
                "seq_degrees": [_midi_to_degree(m, root, scale) for m in d.get("seq", [])],
            }
        if d.get("pan"):
            out["pan"] = d["pan"]
        if d.get("sidechain"):
            out["sidechain"] = d["sidechain"]
        if d.get("fx"):
            out["fx"] = d["fx"]
        return self.result(out, success=True)

    @core.module.tool
    async def chord_progression(self, progression: str, key: str = "A minor"):
        """
        Translate a chord progression written as chord symbols (e.g. 'Am Em F C',
        'Cmaj7 Dm7 G7') into scale degrees in the given key

        Args:
            progression: Chord symbols separated by spaces or commas, e.g. 'Am Em B C'.
            key: Key to express the degrees in, same format as create_note_pattern ('A minor', 'F# dorian', ...).
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        root_midi, scale, scale_name, err = _parse_key(key)
        if err:
            return self.result(err, success=False)
        tokens = [t for t in re.split(r"[,\s]+", str(progression or "").strip()) if t]
        if not tokens:
            return self.result("progression is empty - give chord symbols like 'Am Em F C'.", success=False)
        if len(tokens) > 32:
            return self.result("progression is too long - 32 chords max.", success=False)
        chords, romans = [], []
        for token in tokens:
            root_pc, intervals, bass_pc, cerr = _parse_chord(token)
            if cerr:
                return self.result(f"{cerr}. Supported: plain major/minor plus 7/maj7/m7/6/9/dim/aug/sus2/sus4/add9... and slash bass (C/E).", success=False)
            degrees = _chord_degrees(root_pc, intervals, root_midi, scale)
            root_degree = _midi_to_degree(root_midi + ((root_pc - root_midi) % 12), root_midi, scale)
            # roman numeral: degree number, lowercase for minor/dim, with °/+ marks
            digits = "".join(c for c in root_degree if c.isdigit() or c == "-")
            roman = digits if digits else str(root_degree)
            third_iv = intervals[1] if len(intervals) > 1 else 4
            if third_iv in (3, 6):
                roman = roman.lower()
            if third_iv == 6:
                roman += "°"
            elif third_iv == 4 and 8 in intervals:
                roman += "+"
            if bass_pc is not None:
                bass_degree = _midi_to_degree(root_midi + ((bass_pc - root_midi) % 12), root_midi, scale)
                roman += f"/{bass_degree}"
            romans.append(roman)
            chords.append({"chord": token, "degree": root_degree, "roman": roman, "degrees": degrees})
        return self.result({
            "key": f"{SHARP_NAMES[root_midi % 12]} {scale_name}",
            "progression": [c["chord"] for c in chords],
            "romans": romans,
            "chords": chords,
        }, success=True)

    @core.module.tool
    async def suggest_chords(self, mood: str, mode: str = "both", key: str = "A minor", limit: int = 3):
        """
        Ready-made chord progressions for a mood - use when you have a vibe but
        no chord ideas.
        Example: suggest_chords(mood="melancholic", key="A minor")

        Args:
            mood: One of: happy, uplifting, hopeful, melancholic, sad, dark, tense, epic, dreamy, nostalgic, romantic, aggressive, spooky, chill.
            mode: 'major', 'minor' or 'both' (default) - which feel(s) to draw from.
            key: The key to render chord symbols in (degree/roman output is key-independent).
            limit: Progressions per mode (1-5, default 3).
        """
        m = str(mood or "").strip().lower()
        if m not in MOOD_PROGRESSIONS:
            return self.result(f"Unknown mood {mood!r}. Options: {', '.join(MOOD_PROGRESSIONS)}.", success=False)
        mode = str(mode or "both").strip().lower()
        if mode not in ("major", "minor", "both"):
            return self.result("mode must be 'major', 'minor' or 'both'.", success=False)
        try:
            lim = max(1, min(5, int(limit)))
        except (TypeError, ValueError):
            return self.result("limit must be an integer between 1 and 5.", success=False)
        root_midi, scale, scale_name, err = _parse_key(key)
        if err:
            return self.result(err, success=False)
        out = {}
        for feel in ("major", "minor"):
            if mode not in ("both", feel):
                continue
            progressions = MOOD_PROGRESSIONS[m].get(feel)
            if not progressions:
                continue
            tonic_pc = 9 if feel == "minor" else 0
            semis = (root_midi - tonic_pc) % 12
            rendered = []
            for prog in progressions[:lim]:
                shifted = [_transpose_chord(tok, semis) for tok in prog.split()]
                degrees = []
                for tok in shifted:
                    rpc, ivals, _, e = _parse_chord(tok)
                    if e:
                        return self.result(f"internal table error on {tok!r}: {e}", success=False)
                    dgrs = _chord_degrees(rpc, ivals, root_midi, scale)
                    degrees.append({tok: dgrs[0] if dgrs else "?"})
                rendered.append({"chords": " ".join(shifted), "root_degrees": degrees})
            out[feel] = rendered
        if not out:
            return self.result(f"No {mode} progressions for mood {mood!r} - try mode='both'.", success=False)
        return self.result({
            "mood": m,
            "key": f"{SHARP_NAMES[root_midi % 12]} {scale_name}",
            "progressions": out,
            "note": "pass any 'chords' string to chord_progression for full per-chord degrees.",
        }, success=True)

    @core.module.tool
    async def suggest_scale(self, mood: str):
        """
        Scales that fit a mood, with the key string to plug into
        create_note_pattern and a one-line flavor note. Default to major/minor;
        reach for these when a plain scale feels too plain.

        Example: suggest_scale("dreamy")

        Args:
            mood: A vibe, e.g. dreamy, dark, medieval, sinister, spacey, ethereal, jazzy, bluesy, japanese, haunting.
        """
        m = str(mood or "").strip().lower()
        hits = [name for name, blurb in MOOD_SCALES.items() if m in blurb.lower() or blurb.lower().split(" ")[0] in m or m in name]
        if not hits:
            return self.result(
                f"No scale suggestions for {mood!r}. Known flavors: " +
                "; ".join(f"{k} ({v})" for k, v in MOOD_SCALES.items()) +
                ". major/minor always work.", success=False)
        return self.result({
            "mood": m,
            "scales": [{"scale": n, "key_example": f"C {n}", "flavor": MOOD_SCALES[n]} for n in hits],
        }, success=True)

    @core.module.tool
    async def genre_pattern(self, genre: str):
        """
        A proven recipe for a genre: tempo range, ready-to-paste drum beat
        strings (kick/snare/hats, one string per beat), a bass approach and
        sidechain advice. Use it when the user names a style; adapt freely -
        this is a starting point, not a template to copy verbatim.

        Example: genre_pattern("drum and bass")

        Args:
            genre: house, techno, trance, edm, future bass, drum and bass, dubstep, trap, synthwave, lo-fi hip hop, hip hop, eurobeat.
        """
        g = str(genre or "").strip().lower().replace("dnb", "drum and bass").replace("d&b", "drum and bass")
        recipe = GENRE_RECIPES.get(g)
        if recipe is None:
            return self.result(f"Unknown genre {genre!r}. Known: {', '.join(GENRE_RECIPES)}.", success=False)
        out = {"genre": g}
        for k, v in recipe.items():
            # re-flow flat groove strings into painted beat strings (4 steps each)
            if isinstance(v, str) and len(v) >= 8 and re.fullmatch(r"[xX.\-_0-9| ]+", v):
                cells = re.sub(r"[ |]", "", v)
                out[k] = [cells[i:i + 4] for i in range(0, len(cells), 4)]
            else:
                out[k] = v
        out["hint"] = "drum parts are beat strings - one per beat, 4 steps each; paste straight into create_drum_pattern(beats=[...])"
        return self.result(out, success=True)

    @core.module.tool
    async def analyze_melody(self, name: str, chords_per_bar: int = 1):
        """
        Harmonize a stored melody: listens to which degrees land on strong
        beats and suggests a fitting chord for every segment of the loop
        (major/minor/diminished triads, built only from the melody's own key).
        Run it after create_note_pattern to get a backing progression without
        any theory knowledge - then play the suggested degrees back as a pad
        or arpeggio pattern.

        Example: analyze_melody("my topline", chords_per_bar=1)

        Args:
            name: Exact name of a stored note pattern (see list_loops).
            chords_per_bar: How many chord changes per bar (1 or 2, default 1).
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)
        loop_id = _norm_name(name)
        d = self._loops(chat_id).get(loop_id)
        if not d:
            return self.result(f"No pattern named '{name}' in this chat.", success=False)
        if d.get("kind") != "note":
            return self.result(f"Pattern '{loop_id}' is not a melody - analyze_melody works on create_note_pattern loops.", success=False)
        try:
            cpb = int(chords_per_bar)
        except (TypeError, ValueError):
            return self.result("chords_per_bar must be 1 or 2.", success=False)
        if cpb not in (1, 2):
            return self.result("chords_per_bar must be 1 or 2.", success=False)
        root_midi, scale, scale_name, err = _parse_key(d.get("key", "C major"))
        if err:
            return self.result(err, success=False)
        grid = d.get("bar_length", 1) * d.get("steps_per_bar", 16)
        seg_len = max(1, grid // (d.get("bar_length", 1) * cpb))
        triads = {
            "maj": [0, 4, 7], "m": [0, 3, 7], "dim": [0, 3, 6],
        }
        suggestions = []
        for s0 in range(0, grid, seg_len):
            seg = [n for n in d.get("notes", []) if s0 <= (n["start"] % grid) < s0 + seg_len]
            if not seg:
                suggestions.append(None)
                continue
            best, best_score, best_cov, best_diat, best_near = None, -1.0, 0.0, 0.0, 0.0
            for deg in range(1, len(scale) + 1):
                root_semis = scale[(deg - 1) % len(scale)]
                for qual, ivals in triads.items():
                    tones = {(root_semis + i) % 12 for i in ivals}
                    # chords built from the key's own notes are preferred;
                    # chromatic tones make a candidate less likely
                    diat = sum(1 for i in ivals if (root_semis + i) % 12 in scale) / len(ivals)
                    chroma = 1.0 - diat
                    strong_w = weak_w = clash = root_w = chroma_w = 0.0
                    strong_cov = weak_cov = 0
                    for n in seg:
                        semis = (n["pitch"] - root_midi) % 12
                        vel = n.get("velocity", 0.8)
                        strong = ((n["start"] % grid) - s0) % 4 == 0
                        if semis in tones:
                            if strong:
                                strong_w += vel
                                strong_cov += 1
                            else:
                                weak_w += vel
                                weak_cov += 1
                            # a melody note ON the chord's root strongly names
                            # that chord: A-heavy bars want Am, not F or C
                            if semis == root_semis:
                                root_w += (1.0 if strong else 0.5) * vel
                            # a chord that absorbs the melody's chromatic notes
                            # (G# over E in a minor key) is a deliberate fit
                            if semis not in scale:
                                chroma_w += vel
                        elif any((semis - t) % 12 in (1, 11) for t in tones):
                            clash += vel
                    s_score = strong_w + 0.35 * weak_w + root_w + 2.0 * chroma_w - 0.8 * clash - 1.5 * chroma
                    cov = (strong_cov + weak_cov) / len(seg)
                    # final tiebreak: chords nearer the tonic (on a tie of
                    # fit, an Am key prefers Am over F or C)
                    near = 1.0 - min(deg - 1, len(scale) - deg + 1) / len(scale)
                    # ordering: coverage of the melody, then staying inside the
                    # key, then the weighted fit score, then tonic proximity
                    if (cov, diat, s_score, near) > (best_cov, best_diat, best_score, best_near):
                        best_cov, best_diat, best_score, best_near, best = cov, diat, s_score, near, (deg, qual)
            deg, qual = best
            digits = str(deg)
            roman = digits if qual == "maj" else digits.lower()
            midi_root = root_midi + (deg - 1) // len(scale) * 12 + scale[(deg - 1) % len(scale)]
            chord_degrees = [_midi_to_degree(midi_root + i, root_midi, scale) for i in triads[qual]]
            symbol = SHARP_NAMES[midi_root % 12] + ("m" if qual == "m" else "°" if qual == "dim" else "")
            suggestions.append({
                "chord": symbol,
                "roman": roman,
                "degrees": chord_degrees,
                "over_notes": sorted({_midi_to_degree(n["pitch"], root_midi, scale) for n in seg}),
            })
        return self.result({
            "pattern": loop_id,
            "key": d.get("key", "C major"),
            "chords_per_bar": cpb,
            "segments": suggestions,
            "note": "null = no notes in that segment (keep the previous chord). Degrees feed straight into create_note_pattern as a pad/arp layer.",
        }, success=True)

    @core.module.tool
    async def edit_loop(self, name: str, instrument: str = "", volume: float = None, pan: float = None, sidechain: str = "", fx: list = None, visual: str = "", octave: int = None):
        """
        Change a stored loop's sound WITHOUT re-supplying its notes:
        instrument/voice, volume, pan, sidechain pump, FX chain, octave, and
        the visual that pulses on its sound's hits. Playing loops restage with
        the new setup on the next cycle; stopped ones apply on their next start.

        Example: edit_loop("bassline", instrument="saw", sidechain="16th", visual="pulse")

        Args:
            name: Exact loop name (see list_loops).
            instrument: New timbre - piano, bass, pad, lead, pluck, bells, sine, square, triangle, saw, organ, strings, synbrass, flute, musicbox (drum loops: kick, snare, clap, hihat_closed, hihat_open, tom, rim, cowbell) or a custom sound; loops also accept sample names (fx samples for drum loops, note samples for note loops; list_samples). '' = keep.
            volume: New volume 0.0-1.0, or omit to keep.
            pan: New position -1..1, or omit to keep.
            sidechain: New pump, e.g. '4th' or '16th:0.8'; 'off' removes it; omit/'' = keep (get_help('sidechain')).
            fx: New FX chain list (get_help('fx')); [] clears, omit = keep.
            visual: Effect that pulses on this loop's sound: flash, bloom, spark, drip, laser, ripple, wave, plasma, aurora, prism, strobe, pulse; persistent: wheel, motes, vortex, soundwave; 'off' = clear, '' = keep (get_help('visuals')).
            octave: New octave for melody/arp loops (0-8) - transposes every note so degree 1 sits in that octave. Drum loops have no pitch, so it's rejected there. Omit = keep.
        """
        chat_id = self._chat_id()
        if not chat_id:
            return self.result("No active chat.", success=False)

        loop_id = _norm_name(name)
        loops = self._loops(chat_id)
        d = loops.get(loop_id)
        if not d:
            return self.result(f"No loop named '{name}' in this chat.", success=False)

        visual = str(visual).strip().lower()
        if visual and visual not in EFFECTS and visual != "off":
            return self.result(f"Unknown visual '{visual}'. Options: {', '.join(EFFECTS)}, off.", success=False)
        new = dict(d)
        changed = []
        instrument = str(instrument).strip().lower()
        if instrument:
            kind = d.get("kind")
            options = DRUM_VOICES if kind == "drum" else INSTRUMENTS
            samples = self._samples("fx" if kind == "drum" else "note")
            if instrument not in options and instrument not in self._sounds(chat_id) and instrument not in samples:
                custom = ", ".join(sorted(self._sounds(chat_id))) or "none defined"
                folder = "fx" if kind == "drum" else "note"
                hint = f" Samples: {', '.join(sorted(samples)) or ('none in samples/' + folder + '/')}."
                return self.result(f"Unknown instrument '{instrument}' for a {kind} loop. Built-in: {', '.join(options)}. Custom: {custom}.{hint}", success=False)
            if kind == "drum":
                new["voice"] = instrument
            else:
                new["instrument"] = instrument
            changed.append(f"instrument -> {instrument}")
        if volume is not None:
            new["volume"] = _velocity(volume, d.get("volume", 1.0))
            changed.append(f"volume -> {new['volume']}")
        if pan is not None:
            panv = _num(pan, 0.0, -1.0, 1.0)
            if panv:
                new["pan"] = panv
            else:
                new.pop("pan", None)
            changed.append(f"pan -> {panv:+.2f}")
        sc_clean, sc_remove = None, False
        if sidechain is not None and str(sidechain).strip():
            if str(sidechain).strip().lower() == "off":
                sc_remove = True
            else:
                sc_clean, sc_err = _clean_sidechain(sidechain)
                if sc_err:
                    return self.result(sc_err, success=False)
        fxs_clean, fx_clear = None, False
        if fx is not None:
            if isinstance(fx, list) and not fx:
                fx_clear = True
            else:
                fxs_clean, fx_err = _clean_fx(fx)
                if fx_err:
                    return self.result(fx_err, success=False)
        if sc_remove:
            new.pop("sidechain", None)
            changed.append("pump removed")
        elif sc_clean:
            new["sidechain"] = sc_clean
            changed.append(f"pump -> {sc_clean['rate']}")
        if fx_clear:
            new.pop("fx", None)
            changed.append("fx cleared")
        elif fxs_clean:
            new["fx"] = fxs_clean
            changed.append("fx -> " + ">".join(s["type"] for s in fxs_clean))

        if octave is not None:
            if d.get("kind") == "drum":
                return self.result(f"Loop '{loop_id}' is a drum pattern - octave only applies to melody/arp loops.", success=False)
            try:
                octv = int(octave)
            except (TypeError, ValueError):
                return self.result("octave must be an integer between 0 and 8.", success=False)
            if octv < 0 or octv > 8:
                return self.result("octave must be between 0 and 8.", success=False)
            cur_root, cur_scale, cur_name, kerr = _parse_key(d.get("key", "C major"))
            if kerr:
                return self.result(kerr, success=False)
            cur_octv = cur_root // 12 - 1
            shift = (octv - cur_octv) * 12
            if shift:
                # notes store absolute MIDI pitches: transpose every note and
                # any arp sequence, then rewrite the key's octave.
                if any(n["pitch"] + shift < 12 or n["pitch"] + shift > 127 for n in d.get("notes", [])) or \
                   any(m + shift < 12 or m + shift > 127 for m in d.get("seq", [])):
                    return self.result(f"octave {octv} would push a note out of MIDI range (12-127).", success=False)
                new["notes"] = [dict(n, pitch=n["pitch"] + shift) for n in d.get("notes", [])]
                if d.get("seq"):
                    new["seq"] = [m + shift for m in d["seq"]]
                new["key"] = f"{SHARP_NAMES[cur_root % 12]}{octv} {cur_name}"
            changed.append(f"octave -> {octv}")

        if visual:
            sound = new.get("voice") or new.get("instrument")
            visuals = dict(self._visuals(chat_id))
            if visual == "off":
                visuals.pop(sound, None)
            else:
                visuals[sound] = visual
            self._store_visuals(chat_id, visuals)
            await self._push(chat_id, {"type": "music_sequencer:visual", "sound": sound, "effect": None if visual == "off" else visual})
            changed.append(f"{sound} visual -> {visual}")
        if changed:
            loops = dict(loops)
            loops[loop_id] = new
            self._store_loops(chat_id, loops)
            if new.get("playing"):
                await self._push(chat_id, {"type": "music_sequencer:play", "loop": dict(new, id=loop_id)})
            else:
                await self._push(chat_id, {"type": "music_sequencer:define", "loop": dict(new, id=loop_id)})
            state = "restaged on the next cycle" if new.get("playing") else "applies on next start"
            return self.result(f"Edited loop '{loop_id}': {', '.join(changed)} ({state}).", success=True)
        return self.result(f"Loop '{loop_id}' unchanged - pass instrument, volume, pan, sidechain, fx, octave and/or visual.", success=True)

    @core.module.tool
    async def define_sound(self, name: str, spec: dict):
        """
        Designs a custom synth sound from a recipe; it then works anywhere a
        built-in does: voice= in create_drum_pattern (one-shot at base_note),
        instrument= in create_note_pattern (at each note's pitch; set
        env.sustain above 0 for held notes). Re-defining a name updates
        playing loops live. Full recipe reference: get_help('sounds').

        Example: define_sound("laser", {"osc": [{"type": "sawtooth"}], "pitch": {"glide": 24}, "filter": {"cutoff": 6000, "env": 36}, "env": {"attack": 0.002, "decay": 0.25}, "base_note": 72})

        Args:
            name: Lowercase id ('pew', 'wobble'); cannot shadow a built-in name.
            spec: Recipe dict. Minimum: {"osc": [{"type": "sawtooth"}]}. Optional engines: fm, pd, ring, wt, chip, grain, sweep; plus noise, filter, env, pitch, lfo, unison and base_note. Details in get_help('sounds').
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
        return self.result(f"{'Updated' if existed else 'Created'} custom sound '{nm}'. Use it as voice= or instrument= in the create tools.", success=True)

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

    @core.module.tool
    async def list_samples(self):
        """
        Lists the user's audio samples from the module's samples folders and
        refreshes the browser's copy of them. Three kinds, by subfolder:
        samples/fx/ one-shots work as drum pattern voices (voice=),
        samples/note/ one-shots work as melody instruments (instrument=),
        pitched to each note (C4 reference), and samples/song/ one-shots fire
        at fixed points via start_song's events param. The filename
        (lowercased, punctuation to dashes) is the name. Call this once after
        the user drops new files so everyone sees them.
        """
        chat_id = self._chat_id()
        samples = self._samples()
        if chat_id:
            await self._push(chat_id, {"type": "music_sequencer:samples", "samples": samples})
        if not samples:
            return self.result("No samples found. Ask the user to drop audio files (.wav/.mp3/.ogg/.flac/.m4a/...) into "
                               "music_sequencer/webui/assets/samples/fx/ (drum voices), .../samples/note/ (pitched melody "
                               "instruments) or .../samples/song/ (song events).", success=True)
        lines = [f"- {n} [{s['kind']}] ({s['bytes'] // 1024} KB): {s['file']}" for n, s in samples.items()]
        return self.result("Samples available:\n" + "\n".join(lines), success=True)

    # -------------------------
    #   WEBUI ROUTES + PROMPTS
    # -------------------------

    @webui.route("state")
    async def _route_state(self, body=None, query=None):
        chat_id = (query or {}).get("chat")
        if not chat_id:
            return {"loops": {}, "sounds": {}, "samples": self._samples(), "tempo": self._tempo(chat_id), "meter": self._meter(chat_id), "master_volume": self.config.get("master_volume", 80)}
        loops = {}
        for loop_id, d in self._loops(chat_id).items():
            loops[loop_id] = dict(d, id=loop_id)
        return {
            "loops": loops,
            "sounds": self._sounds(chat_id),
            "samples": self._samples(),
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
        await self._push(chat_id, {"type": "music_sequencer:visual_clear"})
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
            route = ""
            if d.get("pan"):
                route += f", pan {d['pan']:+.2f}"
            if d.get("sidechain"):
                route += f", pump {d['sidechain']['rate']}"
            if d.get("fx"):
                route += ", fx " + ">".join(s["type"] for s in d["fx"])
            extra = f" arp {d.get('arp_mode')} every {d.get('step')} step(s)" if d.get("kind") == "arp" else ""
            lines.append(f"- {loop_id}: {d.get('kind')} ({name}{key}, {d.get('bar_length')} bars @ {spb} steps, vol {d.get('volume')}{route}{extra}) - {state}")
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
        fx_s = sorted(n for n, s in self._samples("fx").items())
        note_s = sorted(n for n, s in self._samples("note").items())
        song_s = sorted(n for n, s in self._samples("song").items())
        if fx_s:
            block += f"\nFx samples (drum voices): {', '.join(fx_s)}"
        if note_s:
            block += f"\nNote samples (melody instruments, pitched per note): {', '.join(note_s)}"
        if song_s:
            block += f"\nSong samples (start_song events): {', '.join(song_s)}"
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
            route = ""
            if d.get("pan"):
                route += f", pan {d['pan']:+.2f}"
            if d.get("sidechain"):
                route += f", pump {d['sidechain']['rate']}"
            if d.get("fx"):
                route += ", fx " + ">".join(s["type"] for s in d["fx"])
            lines.append(f"{loop_id}: {d.get('kind')} ({name}, {d.get('bar_length')} bars @ {d.get('steps_per_bar', 16)} steps{route}) - {state}")
        return "\n".join(lines)

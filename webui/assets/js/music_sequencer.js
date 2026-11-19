(function () {
    var MAX_LAYERS = 60;
    var STEPS_PER_BAR = 16;
    var LOOKAHEAD = 0.15;
    var TICK_MS = 25;

    var ctx = null;
    var master = null;
    var noiseBuf = null;
    var bpm = 120;
    var anchored = false;
    var anchorT = 0;
    var anchorS = 0;
    var masterVolume = 80;
    var localSeq = 0;
    var curChat = null;
    var loops = new Map();
    var sounds = new Map();
    var visualCues = new Map();
    var vizEl = null;
    var vizQueue = [];
    var VIZ_LEAD = 0.012;

    function clamp01(v) { v = Number(v); if (isNaN(v)) v = 1; return Math.max(0, Math.min(1, v)); }
    function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

    /* one shared step grid: position is kept as an absolute 16th-note step
       index against an (anchorT, anchorS) pair, so tempo changes preserve the
       phase of every loop at once. a bar is always 16 steps. */
    function sps() { return 60 / bpm / 4; }
    function absStep(t) { return anchorS + (t - anchorT) / sps(); }
    function stepTime(s) { return anchorT + (s - anchorS) * sps(); }
    function nextBarStart() { return Math.ceil(absStep(ctx.currentTime) / STEPS_PER_BAR) * STEPS_PER_BAR; }
    /* the "song" is the cycle of the longest playing loop; a new loop joins on
       that loop's next restart, so its phrasing lands on the song's cycle
       start instead of an arbitrary bar line mid-cycle. falls back to the next
       bar when nothing is playing (ties pick the soonest restart). */
    function nextSongStart() {
        if (!audioReady()) return -1;
        var nowStep = absStep(ctx.currentTime);
        var bestSpan = 0;
        var bestTarget = -1;
        loops.forEach(function (l) {
            if (!l.playing || !l.def || l.nextStep < 0) return;
            var span = (l.def.bar_length || 1) * STEPS_PER_BAR;
            var t = l.nextStep;
            while (t < nowStep) t += span;
            if (span > bestSpan || (span === bestSpan && t < bestTarget)) { bestSpan = span; bestTarget = t; }
        });
        return bestTarget >= 0 ? bestTarget : nextBarStart();
    }
    function audioReady() { return !!(ctx && anchored && ctx.state === "running"); }
    function countPlaying() {
        var n = 0;
        loops.forEach(function (l) { if (l.playing) n++; });
        return n;
    }

    /* -------------------------
     * audio unlock (browsers start the AudioContext suspended)
     * ------------------------- */
    function onRunning() {
        if (!anchored && ctx.state === "running") {
            anchorT = ctx.currentTime;
            anchorS = 0;
            anchored = true;
        }
        if (anchored) {
            loops.forEach(function (l) {
                if (l.playing && l.nextStep < 0) l.nextStep = nextBarStart();
            });
        }
    }

    function tryUnlock() {
        if (!ctx) {
            try {
                var AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return;
                ctx = new AC();
                master = ctx.createGain();
                master.gain.value = masterVolume / 100;
                var comp = ctx.createDynamicsCompressor();
                comp.threshold.value = -14;
                comp.ratio.value = 6;
                master.connect(comp);
                comp.connect(ctx.destination);
                ctx.onstatechange = onRunning;
            } catch (e) { return; }
        }
        if (ctx.state === "suspended") ctx.resume().catch(function () {});
        onRunning();
    }

    ["pointerdown", "keydown", "touchstart"].forEach(function (ev) {
        window.addEventListener(ev, tryUnlock, { passive: true });
    });
    tryUnlock();

    /* -------------------------
     * synths (no audio assets needed)
     * ------------------------- */
    function noiseBuffer() {
        if (noiseBuf) return noiseBuf;
        var len = Math.floor(ctx.sampleRate * 2);
        noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
        var d = noiseBuf.getChannelData(0);
        for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        return noiseBuf;
    }

    function env(when, peak, attack, decay) {
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0005, peak), when + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
        g.connect(master);
        return g;
    }

    function envFiltered(when, peak, attack, decay, freq) {
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0005, peak), when + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
        var f = ctx.createBiquadFilter();
        f.type = "bandpass";
        f.frequency.setValueAtTime(freq, when);
        g.connect(f);
        f.connect(master);
        return g;
    }

    function burst(freq, type, when, dest) {
        var o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(freq, when);
        o.connect(dest);
        return o;
    }

    function noiseHit(when, peak, attack, decay, filterType, freq) {
        var g = env(when, peak, attack, decay);
        var src = ctx.createBufferSource();
        src.buffer = noiseBuffer();
        var f = ctx.createBiquadFilter();
        f.type = filterType;
        f.frequency.setValueAtTime(freq, when);
        src.connect(f);
        f.connect(g);
        src.start(when);
        src.stop(when + attack + decay + 0.05);
    }

    /* full FM engine: sine operators wired by an algorithm graph. modulators
       feed the target oscillator's frequency (in Hz); depth scales with the
       played note so ratios keep their sidebands across the keyboard, like
       real FM. operators with feedback self-oscillate through a tiny delay
       (Web Audio requires a delay node to close a cycle). */
    function fmHit(patch, freq, when, vel, gate) {
        var ops = patch.operators || [];
        var oscs = [];
        var maxEnd = 0;
        function opEnv(o, peak) {
            var g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, when);
            g.gain.exponentialRampToValueAtTime(Math.max(0.0005, peak), when + o.attack);
            var sus = Math.max(0.0005, peak * Math.max(0.02, o.sustain));
            g.gain.exponentialRampToValueAtTime(sus, when + o.attack + o.decay);
            var off = gate == null ? when + o.attack + o.decay
                                   : Math.max(when + o.attack + o.decay, when + gate);
            g.gain.setValueAtTime(sus, off);
            g.gain.exponentialRampToValueAtTime(0.0001, off + o.release);
            maxEnd = Math.max(maxEnd, off - when + o.release + 0.03);
            return g;
        }
        var envs = [];
        for (var i = 0; i < ops.length; i++) {
            var o = ops[i];
            var osc = ctx.createOscillator();
            osc.type = "sine";
            osc.frequency.setValueAtTime(Math.max(1, freq * o.ratio), when);
            if (o.feedback > 0) {
                var fb = ctx.createGain();
                fb.gain.value = o.feedback * freq * 0.5;
                var dl = ctx.createDelay(0.05);
                dl.delayTime.value = 0.001;
                osc.connect(fb);
                fb.connect(dl);
                dl.connect(osc.frequency);
            }
            var isCarrier = patch.output.indexOf(i) !== -1;
            var peak = isCarrier ? o.level * vel * 0.5 : o.level * vel * freq * 0.5;
            var g = opEnv(o, peak);
            osc.connect(g);
            osc.start(when);
            osc.stop(when + 5);
            oscs.push(osc);
            envs.push(g);
        }
        Object.keys(patch.algorithm || {}).forEach(function (src) {
            var targets = patch.algorithm[src];
            if (!Array.isArray(targets)) targets = [targets];
            targets.forEach(function (dst) {
                envs[src].connect(oscs[dst].frequency);
            });
        });
        patch.output.forEach(function (dst) {
            envs[dst].connect(master);
        });
        setTimeout(function () {
            oscs.forEach(function (o) { try { o.disconnect(); } catch (e) {} });
            envs.forEach(function (g) { try { g.disconnect(); } catch (e) {} });
        }, (maxEnd + 0.2) * 1000);
    }

    /* DX7 E.Piano-1-flavoured preset for the built-in 'fm' instrument */
    var FM_EP = {
        operators: [
            { ratio: 14.0, level: 0.12, attack: 0.001, decay: 0.045, sustain: 0, release: 0.05 },
            { ratio: 1.0, level: 1.0, attack: 0.002, decay: 0.42, sustain: 0, release: 0.2 },
            { ratio: 1.0, level: 0.35, attack: 0.002, decay: 1.4, sustain: 0.22, release: 0.5 },
            { ratio: 1.0, level: 0.25, attack: 0.01, decay: 1.0, sustain: 0.3, release: 0.5 }
        ],
        algorithm: { 0: [2], 1: [2], 2: [3] },
        output: [3]
    };

    function customHit(def, freq, when, vel, gate) {
        if (def.fm) fmHit(def.fm, freq, when, vel, gate);
        var e = def.env || {};
        var attack = e.attack != null ? e.attack : 0.005;
        var decay = e.decay != null ? e.decay : 0.3;
        var sustain = e.sustain != null ? e.sustain : 0;
        var release = e.release != null ? e.release : 0.15;
        var peak = Math.max(0.0005, vel * 0.6);

        var amp = ctx.createGain();
        amp.connect(master);
        amp.gain.setValueAtTime(0.0001, when);
        amp.gain.exponentialRampToValueAtTime(peak, when + attack);
        var stopAt;
        if (gate == null) {
            amp.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
            stopAt = attack + decay + 0.02;
        } else {
            var sus = Math.max(0.0005, peak * Math.max(0.02, sustain));
            amp.gain.exponentialRampToValueAtTime(sus, when + attack + decay);
            var off = Math.max(when + attack + decay, when + gate);
            amp.gain.setValueAtTime(sus, off);
            amp.gain.exponentialRampToValueAtTime(0.0001, off + release);
            stopAt = off - when + release + 0.02;
        }

        var bus = amp;
        if (def.filter) {
            var fl = def.filter;
            var f = ctx.createBiquadFilter();
            f.type = fl.type || "lowpass";
            f.Q.value = fl.q != null ? fl.q : 1;
            var cutoff = fl.cutoff || 8000;
            if (fl.env) {
                f.frequency.setValueAtTime(Math.min(20000, cutoff * Math.pow(2, fl.env / 12)), when);
                f.frequency.exponentialRampToValueAtTime(cutoff, when + (fl.env_time || 0.2));
            } else {
                f.frequency.setValueAtTime(cutoff, when);
            }
            f.connect(amp);
            bus = f;
        }

        var layers = def.osc || [];
        for (var i = 0; i < layers.length; i++) {
            var o = layers[i];
            if (!o || !(o.level > 0)) continue;
            var osc = ctx.createOscillator();
            osc.type = o.type;
            var f2 = freq * Math.pow(2, o.octave || 0);
            if (def.pitch && def.pitch.glide) {
                osc.frequency.setValueAtTime(Math.max(1, f2 * Math.pow(2, def.pitch.glide / 12)), when);
                osc.frequency.exponentialRampToValueAtTime(f2, when + (def.pitch.glide_time || 0.12));
            } else {
                osc.frequency.setValueAtTime(f2, when);
            }
            if (o.detune) osc.detune.setValueAtTime(o.detune, when);
            var og = ctx.createGain();
            og.gain.value = o.level;
            osc.connect(og);
            og.connect(bus);
            osc.start(when);
            osc.stop(when + stopAt);
        }
        if (def.noise && def.noise.level > 0) {
            var src = ctx.createBufferSource();
            src.buffer = noiseBuffer();
            var nf = ctx.createBiquadFilter();
            nf.type = def.noise.filter || "lowpass";
            nf.frequency.setValueAtTime(def.noise.freq || 2000, when);
            var ng = ctx.createGain();
            ng.gain.value = def.noise.level;
            src.connect(nf);
            nf.connect(ng);
            ng.connect(bus);
            src.start(when);
            src.stop(when + stopAt);
        }
    }

    function drumHit(name, when, vel) {
        var custom = sounds.get(String(name));
        if (custom) {
            customHit(custom, midiToFreq(custom.base_note || 36), when, vel, null);
            return;
        }
        var o;
        switch (name) {
            case "kick": {
                var g = env(when, vel * 0.95, 0.004, 0.34);
                o = burst(160, "sine", when, g);
                o.frequency.exponentialRampToValueAtTime(42, when + 0.11);
                o.start(when); o.stop(when + 0.4);
                break;
            }
            case "snare": {
                noiseHit(when, vel * 0.55, 0.002, 0.16, "highpass", 1500);
                var g2 = env(when, vel * 0.45, 0.002, 0.09);
                o = burst(190, "triangle", when, g2);
                o.start(when); o.stop(when + 0.12);
                break;
            }
            case "clap": {
                noiseHit(when, vel * 0.3, 0.001, 0.02, "bandpass", 1200);
                noiseHit(when + 0.012, vel * 0.3, 0.001, 0.02, "bandpass", 1200);
                noiseHit(when + 0.024, vel * 0.4, 0.001, 0.03, "bandpass", 1200);
                noiseHit(when + 0.036, vel * 0.5, 0.002, 0.14, "bandpass", 1400);
                break;
            }
            case "hihat_closed":
                noiseHit(when, vel * 0.32, 0.001, 0.045, "highpass", 7500);
                break;
            case "hihat_open":
                noiseHit(when, vel * 0.28, 0.001, 0.32, "highpass", 7000);
                break;
            case "tom": {
                var gt = env(when, vel * 0.75, 0.004, 0.26);
                o = burst(220, "sine", when, gt);
                o.frequency.exponentialRampToValueAtTime(95, when + 0.2);
                o.start(when); o.stop(when + 0.3);
                break;
            }
            case "rim": {
                var gr = envFiltered(when, vel * 0.5, 0.001, 0.035, 1700);
                o = burst(1700, "square", when, gr);
                o.start(when); o.stop(when + 0.06);
                break;
            }
            case "cowbell": {
                var gc = envFiltered(when, vel * 0.35, 0.001, 0.14, 2600);
                var a = burst(540, "square", when, gc);
                var b = burst(800, "square", when, gc);
                a.start(when); a.stop(when + 0.18);
                b.start(when); b.stop(when + 0.18);
                break;
            }
        }
    }

    function pluckVoice(type, freq, when, dur, peak) {
        var hold = Math.max(0.12, dur);
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0005, peak), when + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, when + hold);
        g.connect(master);
        var o = burst(freq, type, when, g);
        o.start(when);
        o.stop(when + hold + 0.05);
    }

    function sustainVoice(type, freq, when, dur, peak, atk, rel, cutoff) {
        var hold = Math.max(0.08, dur);
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0005, peak), when + atk);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0005, peak * 0.7), when + Math.max(atk + 0.01, hold));
        g.gain.exponentialRampToValueAtTime(0.0001, when + hold + rel);
        if (cutoff) {
            var f = ctx.createBiquadFilter();
            f.type = "lowpass";
            f.frequency.setValueAtTime(cutoff, when);
            g.connect(f);
            f.connect(master);
        } else {
            g.connect(master);
        }
        var o = burst(freq, type, when, g);
        o.start(when);
        o.stop(when + hold + rel + 0.05);
    }

    function noteHit(kind, midi, when, dur, vel) {
        var f = midiToFreq(midi);
        var custom = sounds.get(String(kind));
        if (custom) {
            customHit(custom, f, when, vel, Math.max(0.05, dur));
            return;
        }
        switch (kind) {
            case "piano":
                pluckVoice("triangle", f, when, Math.max(dur, 0.4), vel * 0.5);
                pluckVoice("sine", f * 2, when, Math.max(dur, 0.4) * 0.5, vel * 0.16);
                break;
            case "pluck":
                pluckVoice("triangle", f, when, Math.min(dur, 0.35), vel * 0.5);
                break;
            case "bass":
                sustainVoice("sawtooth", f, when, dur, vel * 0.5, 0.01, 0.08, Math.min(f * 4, 1100));
                break;
            case "lead":
                sustainVoice("square", f, when, dur, vel * 0.26, 0.01, 0.06, 3200);
                sustainVoice("sawtooth", f * 1.005, when, dur, vel * 0.1, 0.01, 0.06, 3200);
                break;
            case "pad":
                sustainVoice("sawtooth", f, when, dur, vel * 0.16, Math.min(dur * 0.4, 0.35), 0.3, 1600);
                sustainVoice("sawtooth", f * 1.007, when, dur, vel * 0.12, Math.min(dur * 0.4, 0.35), 0.3, 1600);
                break;
            case "bells":
                pluckVoice("sine", f, when, Math.max(dur, 1.2), vel * 0.4);
                pluckVoice("sine", f * 2.76, when, Math.max(dur, 1.2) * 0.6, vel * 0.13);
                pluckVoice("sine", f * 5.4, when, Math.max(dur, 1.2) * 0.3, vel * 0.06);
                break;
            case "sine":
                sustainVoice("sine", f, when, dur, vel * 0.4, 0.01, 0.12, 0);
                break;
            case "square":
                sustainVoice("square", f, when, dur, vel * 0.22, 0.01, 0.1, Math.min(f * 6, 9000));
                break;
            case "triangle":
                sustainVoice("triangle", f, when, dur, vel * 0.35, 0.01, 0.12, 0);
                break;
            case "saw":
                sustainVoice("sawtooth", f, when, dur, vel * 0.28, 0.01, 0.1, Math.min(f * 5, 8000));
                break;
            case "organ":
                sustainVoice("sine", f, when, dur, vel * 0.28, 0.02, 0.15, 0);
                sustainVoice("sine", f * 2, when, dur, vel * 0.16, 0.02, 0.15, 0);
                sustainVoice("sine", f * 3, when, dur, vel * 0.09, 0.02, 0.15, 0);
                sustainVoice("sine", f * 4, when, dur, vel * 0.05, 0.02, 0.15, 0);
                break;
            case "strings":
                sustainVoice("sawtooth", f, when, dur, vel * 0.18, 0.09, 0.35, Math.min(f * 3, 3000));
                sustainVoice("sawtooth", f * 1.008, when, dur, vel * 0.16, 0.1, 0.35, Math.min(f * 3, 3000));
                sustainVoice("sawtooth", f * 0.995, when, dur, vel * 0.13, 0.11, 0.35, Math.min(f * 3, 3000));
                break;
            case "synbrass":
                sustainVoice("sawtooth", f, when, dur, vel * 0.24, 0.03, 0.12, Math.min(f * 8, 4500));
                sustainVoice("square", f * 1.006, when, dur, vel * 0.11, 0.03, 0.12, Math.min(f * 6, 3500));
                break;
            case "flute":
                sustainVoice("sine", f, when, dur, vel * 0.32, 0.06, 0.15, 0);
                sustainVoice("sine", f * 2, when, dur, vel * 0.05, 0.08, 0.15, 0);
                noiseHit(when, vel * 0.03, 0.06, Math.max(dur, 0.2), "bandpass", f * 1.4);
                break;
            case "musicbox":
                pluckVoice("sine", f, when, Math.max(dur, 0.8), vel * 0.38);
                pluckVoice("sine", f * 5.4, when, Math.max(dur, 0.8) * 0.35, vel * 0.1);
                pluckVoice("sine", f * 8.93, when, Math.max(dur, 0.8) * 0.2, vel * 0.04);
                break;
            case "fm":
                fmHit(FM_EP, f, when, vel, Math.max(0.05, dur));
                break;
        }
    }

    /* -------------------------
     * transport scheduler
     * ------------------------- */
    function vizHost() {
        var host = document.getElementById("chat-window") || document.getElementById("messages");
        if (!host) return null;
        if (getComputedStyle(host).position === "static") host.style.position = "relative";
        if (!vizEl || vizEl.parentElement !== host) {
            vizEl = document.createElement("div");
            vizEl.className = "msq-viz";
            host.appendChild(vizEl);
        }
        return vizEl;
    }

    /* short-note effects spawn their own tiny elements so a chord paints one
       pulse per note. Notes land on a Launchpad-style grid: 12 columns x 5
       rows spanning C2-C7, one semitone per cell. Columns are pitch classes
       (every C shares a column), rows climb octave by octave from the bottom
       left (lowest) to the top right (highest). */
    var GRID_COLS = 12;
    var GRID_ROWS = 5;
    var INSTRUMENT_COLORS = {
        piano: "#ffd166",
        pluck: "#4cc9f0",
        bass: "#9d4edd",
        lead: "#f72585",
        pad: "#80ed99",
        bells: "#ffd60a",
        sine: "#8ecae6",
        square: "#ffb703",
        triangle: "#90e0ef",
        saw: "#fb8500",
        organ: "#ff9e9e",
        strings: "#e0aaff",
        synbrass: "#f4845f",
        flute: "#e0f7fa",
        musicbox: "#fcd5ce",
        fm: "#7209b7"
    };
    function colorFor(name) { return INSTRUMENT_COLORS[String(name)] || null; }
    function pitchToCell(midi) {
        var idx = Math.round(Number(midi)) - 36;
        if (!(idx >= 0)) idx = 0;
        if (idx > GRID_COLS * GRID_ROWS - 1) idx = GRID_COLS * GRID_ROWS - 1;
        var col = idx % GRID_COLS;
        var row = Math.floor(idx / GRID_COLS);
        return {
            x: 4 + (col + 0.5) * (92 / GRID_COLS),
            y: 92 - (row + 0.5) * (84 / GRID_ROWS)
        };
    }

    function spawnPulse(cls, xPct, yPct, color, dur) {
        var el = vizHost();
        if (!el) return;
        var d = document.createElement("i");
        d.className = cls;
        if (xPct != null) d.style.left = xPct.toFixed(2) + "%";
        if (yPct != null) d.style.top = yPct.toFixed(2) + "%";
        if (color) d.style.setProperty("--msq-c", color);
        if (dur) d.style.animationDuration = dur.toFixed(3) + "s";
        el.appendChild(d);
        var kill = function () { if (d.parentElement) d.remove(); };
        d.addEventListener("animationend", kill, { once: true });
        setTimeout(kill, Math.max(1200, (dur || 0) * 1000 + 300));
        return d;
    }

    /* laser: corner turret. a beam fires from a random top corner toward the
       note's grid cell with up to 45 degrees of random aim jitter. the beam
       pivots at the corner, so the rotation rides as --msq-a into the
       keyframes. */
    function fireLaser(cell, color) {
        var el = vizHost();
        if (!el) return;
        var w = el.clientWidth || 1, h = el.clientHeight || 1;
        var cx = (cell ? cell.x : 50) / 100 * w;
        var cy = (cell ? cell.y : 50) / 100 * h;
        var x0 = Math.random() < 0.5 ? 0 : w;
        var dx = cx - x0, dy = cy;
        var dist = Math.sqrt(dx * dx + dy * dy) || 1;
        var ang = Math.atan2(dy, dx) + (Math.random() * 2 - 1) * (Math.PI / 12);
        // full diagonal always outruns any in-screen ray from a corner, so
        // every beam is guaranteed to cross a page edge regardless of jitter
        var len = Math.sqrt(w * w + h * h) * 1.02;
        var kids = [];
        var gun = document.createElement("i");
        gun.className = "msq-laser-gun";
        gun.style.left = x0 + "px";
        kids.push(gun);
        var beam = document.createElement("i");
        beam.className = "msq-laser-beam";
        beam.style.left = x0 + "px";
        beam.style.top = "-1px";
        beam.style.width = len.toFixed(1) + "px";
        beam.style.transformOrigin = "left center";
        beam.style.setProperty("--msq-a", ang.toFixed(4) + "rad");
        kids.push(beam);
        kids.forEach(function (n) {
            if (color) n.style.setProperty("--msq-c", color);
            el.appendChild(n);
            n.addEventListener("animationend", function () { if (n.parentElement) n.remove(); }, { once: true });
        });
        setTimeout(function () {
            kids.forEach(function (n) { if (n.parentElement) n.remove(); });
        }, 1200);
    }

    function fireViz(effect, midi, color, dur) {
        if (!effect) return;
        var cell = midi != null ? pitchToCell(midi) : null;
        if (effect === "spark") { spawnPulse("msq-spark-dot", cell ? cell.x : 50, cell ? cell.y : 62, color); return; }
        if (effect === "tick") { spawnPulse("msq-tick-bar", cell ? cell.x : 50, 0, color); return; }
        if (effect === "laser") { fireLaser(cell, color); return; }
        if (effect === "flash") { spawnPulse("msq-flash-full", null, null, color); return; }
        if (effect === "ring") { spawnPulse("msq-ring-el", null, null, color); return; }
        if (effect === "bloom") {
            /* two-part stage flare on the note's grid cell, lifetime synced
               to the sounding note (250ms floor so very short notes still
               read as a flash) */
            var bl = Math.max(0.25, dur || 0.5);
            var bx = cell ? cell.x : 50, by = cell ? cell.y : 50;
            var rays = spawnPulse("msq-bloom-rays", bx, by, color, bl * 1.3);
            // random ray reach AND start angle per burst so no two blooms
            // fan out or spin the same way
            if (rays) {
                rays.style.setProperty("--msq-rl", (50 + Math.random() * 30).toFixed(1) + "%");
                rays.style.setProperty("--msq-r0", (Math.random() * 360).toFixed(1) + "deg");
            }
            spawnPulse("msq-bloom-glow", bx, by, color, bl);
            return;
        }
    }

    /* every effect is its own element, so simultaneous hits stack instead of
       cancelling. cues carry their exact audio-clock time and are flushed by
       rAF against ctx.currentTime, never by drifting wall-clock timers. */
    function pumpViz() {
        requestAnimationFrame(pumpViz);
        if (!ctx || !vizQueue.length) return;
        var now = ctx.currentTime - VIZ_LEAD;
        var keep = [];
        for (var i = 0; i < vizQueue.length; i++) {
            var e = vizQueue[i];
            if (e.t > now) { keep.push(e); continue; }
            if (now - e.t > 0.25) continue;
            fireViz(e.effect, e.midi, e.color, e.dur);
        }
        vizQueue = keep;
    }
    requestAnimationFrame(pumpViz);

    function scheduleOccurrence(loop, startStep) {
        var d = loop.def;
        if (!d) return;
        if (d.kind === "drum") {
            var cue = visualCues.get(String(d.voice));
            var steps = d.steps || [];
            for (var i = 0; i < steps.length; i++) {
                if (steps[i] > 0) {
                    var when = stepTime(startStep + i);
                    drumHit(d.voice, when, steps[i] * loop.volume);
                    if (cue) vizQueue.push({ loop: loop, t: when, effect: cue, midi: null });
                }
            }
        } else if (d.kind === "note") {
            var cueN = visualCues.get(String(d.instrument));
            var noteColor = colorFor(d.instrument);
            var notes = d.notes || [];
            for (var j = 0; j < notes.length; j++) {
                var n = notes[j];
                var whenN = stepTime(startStep + n.start);
                var durN = Math.max(0.05, n.length * sps());
                noteHit(d.instrument, n.pitch, whenN, durN, n.velocity * loop.volume);
                var cue = n.visual || cueN;
                if (cue) vizQueue.push({ loop: loop, t: whenN, effect: cue, midi: n.pitch, color: noteColor, dur: durN });
            }
        }
    }

    setInterval(function () {
        if (!audioReady()) return;
        var nowStep = absStep(ctx.currentTime);
        var horizonStep = absStep(ctx.currentTime + LOOKAHEAD);
        loops.forEach(function (loop) {
            if (!loop.playing || loop.nextStep < 0 || !loop.def) return;
            var span = (loop.def.bar_length || 1) * STEPS_PER_BAR;
            // clock stalled (hidden tab, long tempo jump): fast-forward whole
            // occurrences so the loop resumes exactly on its own phase
            while (loop.nextStep < nowStep) loop.nextStep += span;
            while (loop.nextStep < horizonStep) {
                scheduleOccurrence(loop, loop.nextStep);
                loop.nextStep += span;
            }
        });
    }, TICK_MS);

    /* -------------------------
     * loop control (the public frontend API)
     * ------------------------- */
    function play(def, id) {
        if (!def || typeof def !== "object") return null;
        id = String(id || def.id || ("local_" + (++localSeq)));
        var existing = loops.get(id);
        if (!existing && countPlaying() >= MAX_LAYERS) return null;
        loops.set(id, {
            def: def,
            volume: clamp01(def.volume == null ? 1 : def.volume),
            playing: true,
            nextStep: nextSongStart()
        });
        return id;
    }

    function stop(id) {
        var e = loops.get(String(id));
        if (!e) return false;
        e.playing = false;
        e.nextStep = -1;
        vizQueue = vizQueue.filter(function (v) { return v.loop !== e; });
        return true;
    }

    function start(id) {
        var e = loops.get(String(id));
        if (!e) return false;
        if (e.playing) return true;
        if (countPlaying() >= MAX_LAYERS) return false;
        e.playing = true;
        e.nextStep = nextSongStart();
        return true;
    }

    function stopAll() {
        loops.forEach(function (e) { e.playing = false; e.nextStep = -1; });
        vizQueue = [];
    }

    function setTempo(newBpm) {
        var v = Number(newBpm);
        if (isNaN(v) || v < 20 || v > 300) return false;
        if (audioReady()) {
            var pos = absStep(ctx.currentTime);
            bpm = v;
            anchorT = ctx.currentTime;
            anchorS = pos;
        } else {
            bpm = v;
        }
        return true;
    }

    function setMasterVolume(v) {
        if (v == null) return;
        v = Number(v);
        if (isNaN(v)) return;
        masterVolume = Math.max(0, Math.min(100, v));
        if (master) master.gain.value = masterVolume / 100;
    }

    window.MusicSequencer = {
        play: play,
        stop: stop,
        start: start,
        remove: function (id) {
            id = String(id);
            var e = loops.get(id);
            if (e) vizQueue = vizQueue.filter(function (v) { return v.loop !== e; });
            loops.delete(id);
        },
        stopAll: stopAll,
        testVisual: function (effect) { fireViz(String(effect || "flash")); },
        vizDiag: function () {
            var host = document.getElementById("chat-window") || document.getElementById("messages");
            var st = vizEl ? getComputedStyle(vizEl) : null;
            return {
                hostFound: host ? (host.id || host.tagName) : null,
                attached: !!(vizEl && host && vizEl.parentElement === host),
                position: st ? st.position : null,
                zIndex: st ? st.zIndex : null,
                pointerEvents: st ? st.pointerEvents : null,
                kickRuleLoaded: [].some.call(document.styleSheets, function (s) {
                    try {
                        return [].some.call(s.cssRules || [], function (r) {
                            return (r.name || "") === "msq-kick-flash" || (r.selectorText || "").indexOf(".msq-viz") === 0;
                        });
                    } catch (e) { return false; }
                })
            };
        },
        setVisual: function (voice, effect) {
            voice = String(voice);
            if (!effect) visualCues.delete(voice);
            else visualCues.set(voice, String(effect));
        },
        listVisuals: function () {
            var out = [];
            visualCues.forEach(function (fx, voice) { out.push({ voice: voice, effect: fx }); });
            return out;
        },
        defineSound: function (name, spec) { sounds.set(String(name), spec); },
        removeSound: function (name) { sounds.delete(String(name)); },
        listSounds: function () {
            var out = [];
            sounds.forEach(function (spec, name) { out.push({ name: name, spec: spec }); });
            return out;
        },
        setTempo: setTempo,
        getTempo: function () { return bpm; },
        setMasterVolume: setMasterVolume,
        list: function () {
            var out = [];
            loops.forEach(function (e, id) {
                out.push({
                    id: id,
                    kind: e.def ? e.def.kind : null,
                    voice_or_instrument: e.def ? (e.def.voice || e.def.instrument) : null,
                    bar_length: e.def ? e.def.bar_length : null,
                    playing: !!e.playing
                });
            });
            return out;
        },
        layerCount: function () { return loops.size; },
        playingCount: countPlaying,
        maxLayers: MAX_LAYERS
    };

    /* -------------------------
     * backend bridge: websocket frames + per-chat state reload
     * ------------------------- */
    function selectedChat() {
        try { return Alpine.store("chat").selectedChat || null; } catch (e) { return null; }
    }

    function loadChat(chatId) {
        curChat = chatId;
        loops.clear();
        sounds.clear();
        vizQueue = [];
        if (typeof simpleApiFetch !== "function") {
            setTimeout(function () { loadChat(chatId); }, 300);
            return;
        }
        if (!chatId) return;
        simpleApiFetch("/api/ext/music_sequencer/state?chat=" + encodeURIComponent(chatId))
            .then(function (d) {
                if (!d || String(curChat) !== String(chatId)) return;
                setMasterVolume(d.master_volume);
                if (d.tempo) setTempo(d.tempo);
                var sd = d.sounds || {};
                Object.keys(sd).forEach(function (sn) { sounds.set(sn, sd[sn]); });
                var vc = d.visuals || {};
                Object.keys(vc).forEach(function (vn) { visualCues.set(vn, vc[vn]); });
                var defs = d.loops || {};
                Object.keys(defs).forEach(function (lid) {
                    var def = defs[lid];
                    def.id = lid;
                    if (def.playing) play(def, lid);
                    else loops.set(lid, {
                        def: def,
                        volume: clamp01(def.volume == null ? 1 : def.volume),
                        playing: false,
                        nextStep: -1
                    });
                });
            })
            .catch(function () {});
    }

    function handleFrame(data) {
        var t = data && data.type;
        if (!t) return;
        if (t === "chat_switched") {
            loadChat(data.id || selectedChat());
            return;
        }
        if (t.indexOf("music_sequencer:") !== 0) return;
        var sel = selectedChat();
        if (data.chat && String(data.chat) !== String(sel)) return;
        if (t === "music_sequencer:play") play(data.loop || {}, (data.loop || {}).id);
        else if (t === "music_sequencer:stop") stop(data.id);
        else if (t === "music_sequencer:stop_all") stopAll();
        else if (t === "music_sequencer:tempo") setTempo(data.bpm);
        else if (t === "music_sequencer:sound") {
            if (data.spec) sounds.set(String(data.name), data.spec);
            else sounds.delete(String(data.name));
        }
        else if (t === "music_sequencer:visual") {
            if (data.effect) visualCues.set(String(data.sound), String(data.effect));
            else visualCues.delete(String(data.sound));
        }
    }

    function hookWs() {
        if (typeof window.handleWebSocketMessage !== "function") {
            setTimeout(hookWs, 200);
            return;
        }
        if (window.handleWebSocketMessage.msqHooked) return;
        var orig = window.handleWebSocketMessage;
        window.handleWebSocketMessage.msqHooked = true;
        window.handleWebSocketMessage = function (data) {
            try { handleFrame(data); } catch (e) {}
            return orig.apply(this, arguments);
        };
    }

    function boot(retries) {
        if (selectedChat()) {
            loadChat(selectedChat());
            return;
        }
        if (retries > 0) setTimeout(function () { boot(retries - 1); }, 400);
        else curChat = null;
    }

    visualCues.set("kick", "flash");
    visualCues.set("snare", "ring");

    hookWs();
    boot(30);
})();

(function () {
    var MAX_LAYERS = 60;
    /* global grid: meter steps per bar on the 16th-note transport. loops
       author their own resolution (def.steps_per_bar cells per bar, e.g. 12
       for triplets) and map them onto meter-long bars, so feel varies while
       every layer still shares one bar grid */
    var stepsPerBar = 16;
    var song = null;
    var LOOKAHEAD = 0.15;
    var TICK_MS = 25;

    var ctx = null;
    var master = null;
    /* fixed chain nodes the master bus hangs on; kept module-level so panic()
       can re-hang a fresh master mid-session */
    var fxIn = null;
    var verbSend = null;
    var verbNode = null;
    var compNode = null;
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
    /* user audio files (samples/fx/ + samples/song/) -> name: {file, url, kind,
       buffer, loading, failed}; buffers decode lazily and are prefetched on chat load */
    var samples = new Map();
    var sampleQueue = [];
    var visualCues = new Map();
    var vizEl = null;
    var vizQueue = [];
    var VIZ_LEAD = 0.012;
    var AMBIENT_EFFECTS = ["wheel", "motes", "vortex", "soundwave"];
    var SOUND_BANDS = 16;
    var MAX_AMBIENT = 8;
    var masterAnalyser = null;
    var masterTimeData = null;
    var instrumentBuses = new Map();
    var ambientDefs = [];
    var ambientDirty = true;
    var audioSoundBands = new Float32Array(MAX_AMBIENT * SOUND_BANDS);
    var audioAmbLevels = new Float32Array(MAX_AMBIENT);
    var audioMasterLevel = 0;
    var sentTempo = 0;

    function clamp01(v) { v = Number(v); if (isNaN(v)) v = 1; return Math.max(0, Math.min(1, v)); }
    function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

    /* one shared step grid: position is kept as an absolute 16th-note step
       index against an (anchorT, anchorS) pair, so tempo changes preserve the
       phase of every loop at once. a bar is always 16 steps. */
    function sps() { return 60 / bpm / 4; }
    function absStep(t) { return anchorS + (t - anchorT) / sps(); }
    function stepTime(s) { return anchorT + (s - anchorS) * sps(); }
    function nextBarStart() { return Math.ceil(absStep(ctx.currentTime) / stepsPerBar) * stepsPerBar; }
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
            var span = (l.def.bar_length || 1) * stepsPerBar;
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
                var shaper = ctx.createWaveShaper();
                shaper.curve = tanhCurve(1.4);
                var comp = ctx.createDynamicsCompressor();
                comp.threshold.value = -12;
                comp.knee.value = 8;
                comp.ratio.value = 3;
                comp.attack.value = 0.008;
                comp.release.value = 0.18;
                master.connect(shaper);
                shaper.connect(comp);
                comp.connect(ctx.destination);
                try {
                    masterAnalyser = ctx.createAnalyser();
                    masterAnalyser.fftSize = 2048;
                    masterAnalyser.smoothingTimeConstant = 0.55;
                    comp.connect(masterAnalyser);
                    masterTimeData = new Uint8Array(masterAnalyser.fftSize);
                } catch (e) {
                    masterAnalyser = null;
                    masterTimeData = null;
                }
                fxIn = shaper;
                compNode = comp;
                try {
                    var verb = ctx.createConvolver();
                    verb.buffer = makeIR(2.1, 3.0);
                    var vhp = ctx.createBiquadFilter();
                    vhp.type = "highpass";
                    vhp.frequency.value = 260;
                    /* darkening the wet tail keeps the reverb spacious, not hissy */
                    var vlp = ctx.createBiquadFilter();
                    vlp.type = "lowpass";
                    vlp.frequency.value = 6800;
                    var predelay = ctx.createDelay(0.1);
                    predelay.delayTime.value = 0.02;
                    var send = ctx.createGain();
                    send.gain.value = 0.22;
                    master.connect(vhp);
                    vhp.connect(send);
                    send.connect(predelay);
                    predelay.connect(verb);
                    verb.connect(vlp);
                    vlp.connect(comp);
                    verbNode = verb;
                    verbSend = vhp;
                } catch (e) {}
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
    function stableSeed(value) {
        var h = 2166136261;
        var s = String(value || "");
        for (var i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0) / 4294967295;
    }

    function isAmbientEffect(effect) {
        return AMBIENT_EFFECTS.indexOf(String(effect || "").toLowerCase()) >= 0;
    }

    function isSoundwaveVisual(name) {
        return visualCues.get(String(name)) === "soundwave";
    }

    function ensureInstrumentBus(name) {
        if (!ctx || !master) return null;
        var key = String(name || "");
        if (!key) return master;
        var ent = instrumentBuses.get(key);
        if (!ent) {
            try {
                var gain = ctx.createGain();
                gain.gain.value = 1;
                gain.connect(master);
                var analyser = ctx.createAnalyser();
                analyser.fftSize = 512;
                analyser.smoothingTimeConstant = 0.82;
                gain.connect(analyser);
                ent = { gain: gain, analyser: analyser, data: new Uint8Array(analyser.frequencyBinCount) };
                instrumentBuses.set(key, ent);
            } catch (e) {
                return master;
            }
        }
        return ent.gain;
    }

    function audioOut(name) {
        if (!isSoundwaveVisual(name)) return master;
        return ensureInstrumentBus(name) || master;
    }

    /* RMS loudness of one instrument bus; instant attack, smooth release, so
       the soundwave visualiser can fade with the volume it is attached to */
    function busLevel(ent) {
        if (!ent || !ent.analyser) return 0;
        try {
            if (!ent.time) ent.time = new Uint8Array(ent.analyser.fftSize);
            ent.analyser.getByteTimeDomainData(ent.time);
            var sum = 0;
            for (var i = 0; i < ent.time.length; i++) {
                var v = (ent.time[i] - 128) / 128;
                sum += v * v;
            }
            var rms = Math.min(1, Math.sqrt(sum / ent.time.length) * 3.0 * (masterVolume / 100));
            var prev = ent.level || 0;
            ent.level = rms > prev ? rms : prev * 0.90 + rms * 0.10;
            return ent.level;
        } catch (e) {
            return 0;
        }
    }

    function bandLevels(analyser, data, out, low, high) {
        if (!ctx || !analyser || !data || !out) return;
        analyser.getByteFrequencyData(data);
        var bins = data.length;
        var hzPerBin = (ctx.sampleRate || 44100) / Math.max(2, analyser.fftSize);
        var ratio = high / Math.max(1, low);
        for (var i = 0; i < out.length; i++) {
            var f0 = low * Math.pow(ratio, i / out.length);
            var f1 = low * Math.pow(ratio, (i + 1) / out.length);
            var b0 = Math.max(0, Math.min(bins - 1, Math.floor(f0 / hzPerBin)));
            var b1 = Math.min(bins - 1, Math.floor(f1 / hzPerBin));
            if (b1 < b0) b1 = b0;
            var total = 0;
            for (var b = b0; b <= b1; b++) total += data[b];
            var level = total / ((b1 - b0 + 1) * 255);
            out[i] = Math.min(1, Math.pow(level, 0.72) * 1.25);
        }
    }

    function updateMasterLevel() {
        audioMasterLevel = 0;
        if (!masterAnalyser || !masterTimeData) return;
        try {
            masterAnalyser.getByteTimeDomainData(masterTimeData);
            var sum = 0;
            for (var i = 0; i < masterTimeData.length; i++) {
                var v = (masterTimeData[i] - 128) / 128;
                sum += v * v;
            }
            audioMasterLevel = Math.min(1, Math.sqrt(sum / masterTimeData.length) * 2.4);
        } catch (e) {
            audioMasterLevel = 0;
        }
    }

    function syncAmbientDefs() {
        ambientDirty = false;
        var items = [];
        visualCues.forEach(function (fx, voice) {
            fx = String(fx || "").toLowerCase();
            voice = String(voice || "");
            if (!isAmbientEffect(fx)) return;
            if (voice === "master") return;
            items.push({ fx: fx, voice: voice });
        });
        var nonEq = items.slice(0, MAX_AMBIENT);
        var defs = [];
        var laneCount = nonEq.length;
        for (var j = 0; j < nonEq.length; j++) {
            var item = nonEq[j];
            var x = laneCount <= 1 ? 0.5 : 0.08 + j * (0.84 / (laneCount - 1));
            var y = laneCount <= 1 ? 0.55 : 0.20 + j * (0.60 / (laneCount - 1));
            if (item.fx === "wheel") {
                x = 0.5;
                y = 0.56;
            } else if (item.fx === "motes") {
                y = 0.08;
            } else if (item.fx === "vortex") {
                y = 0.5;
            } else if (item.fx === "soundwave") {
                x = 0.5;
                y = 0.16 + stableSeed(item.voice + "|waveY") * 0.68;
            }
            defs.push({
                effect: item.fx,
                name: item.voice,
                x: x,
                y: y,
                color: colorFor(item.voice),
                seed: stableSeed(item.voice),
                speed: Math.max(0.02, bpm / 120)
            });
        }
        ambientDefs = defs;
        if (window.MusicSequencerShaderFx && window.MusicSequencerShaderFx.setAmbient) {
            window.MusicSequencerShaderFx.setAmbient(defs);
        }
    }

    function sendAmbientAudio() {
        var fx = window.MusicSequencerShaderFx;
        if (!fx || !ambientDefs.length) return;
        var running = !!(ctx && ctx.state === "running");
        for (var k = 0; k < audioSoundBands.length; k++) audioSoundBands[k] = 0;
        for (var q = 0; q < audioAmbLevels.length; q++) audioAmbLevels[q] = 0;
        if (!running) {
            audioMasterLevel = 0;
            instrumentBuses.forEach(function (e) { e.level = 0; });
            if (fx.setAudioData) fx.setAudioData({ bands: audioSoundBands, levels: audioAmbLevels, master: audioMasterLevel });
            return;
        }
        if (masterAnalyser) updateMasterLevel();
        else audioMasterLevel = 0;
        for (var j = 0; j < ambientDefs.length && j < MAX_AMBIENT; j++) {
            if (ambientDefs[j].effect !== "soundwave") continue;
            var ent = instrumentBuses.get(String(ambientDefs[j].name));
            if (!ent || !ent.analyser) continue;
            var offset = j * SOUND_BANDS;
            var slice = audioSoundBands.subarray(offset, offset + SOUND_BANDS);
            bandLevels(ent.analyser, ent.data, slice, 35, 10000);
            audioAmbLevels[j] = busLevel(ent);
        }
        if (fx.setAudioData) fx.setAudioData({ bands: audioSoundBands, levels: audioAmbLevels, master: audioMasterLevel });
    }

    function noiseBuffer() {
        if (noiseBuf) return noiseBuf;
        var len = Math.floor(ctx.sampleRate * 2);
        noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
        var d = noiseBuf.getChannelData(0);
        for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        return noiseBuf;
    }

    function env(when, peak, attack, decay, dest) {
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0005, peak), when + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
        g.connect(dest || master);
        return g;
    }

    /* gentle tanh soft-clip curve so the bus saturates instead of hard-clipping
       when several layers stack */
    function tanhCurve(k) {
        var n = 2048;
        var c = new Float32Array(n);
        for (var i = 0; i < n; i++) {
            var x = (2 * i) / (n - 1) - 1;
            c[i] = Math.tanh(x * k) / Math.tanh(k);
        }
        return c;
    }

    /* stereo noise-decay impulse response for the reverb send */
    function makeIR(seconds, decay) {
        var len = Math.floor(ctx.sampleRate * seconds);
        var ir = ctx.createBuffer(2, len, ctx.sampleRate);
        for (var c = 0; c < 2; c++) {
            var d = ir.getChannelData(c);
            for (var i = 0; i < len; i++) {
                d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
            }
        }
        return ir;
    }

    function envFiltered(when, peak, attack, decay, freq, dest) {
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0005, peak), when + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
        var f = ctx.createBiquadFilter();
        f.type = "bandpass";
        f.frequency.setValueAtTime(freq, when);
        g.connect(f);
        f.connect(dest || master);
        return g;
    }

    function burst(freq, type, when, dest) {
        var o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(freq, when);
        o.connect(dest);
        return o;
    }

    function noiseHit(when, peak, attack, decay, filterType, freq, q, dest) {
        var g = env(when, peak, attack, decay, dest);
        var src = ctx.createBufferSource();
        src.buffer = noiseBuffer();
        src.loop = true;
        var f = ctx.createBiquadFilter();
        f.type = filterType;
        f.frequency.setValueAtTime(freq, when);
        if (q) f.Q.value = q;
        src.connect(f);
        f.connect(g);
        src.start(when, Math.random() * 1.5);
        src.stop(when + attack + decay + 0.05);
    }

    /* tiny bright noise transient for kick attack */
    function clickHit(when, peak, dest) {
        noiseHit(when, peak, 0.0005, 0.01, "highpass", 2600, 0, dest);
    }

    /* TR-808-style metallic hat: six detuned square oscillators at inharmonic
       ratios, highpassed - far more "metal" than plain filtered noise */
    function metalHat(when, peak, decay, hpFreq, dest) {
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0005, peak), when + 0.001);
        g.gain.exponentialRampToValueAtTime(0.0001, when + 0.001 + decay);
        var f = ctx.createBiquadFilter();
        f.type = "highpass";
        f.frequency.setValueAtTime(hpFreq, when);
        f.Q.value = 1.4;
        g.connect(f);
        f.connect(dest || master);
        var ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
        for (var i = 0; i < ratios.length; i++) {
            var o = burst(62 * ratios[i], "square", when, g);
            o.start(when);
            o.stop(when + decay + 0.05);
        }
    }

    /* ---------------- FM synthesis engine ----------------
       Sine operators wired by an algorithm graph (DX7-style). A patch is
       parsed and defaulted up front so building the graph can never throw
       half-finished or stall the transport scheduler. Modulation depth
       scales with the target operator's own frequency, so a ratio keeps its
       sidebands across the keyboard like real FM, and operators with
       feedback self-oscillate through a tiny delay (Web Audio requires a
       delay node to close a cycle). Voices are torn down strictly against
       the audio clock, so a note always finishes its release. */
    function fmOp(raw) {
        function num(v, d, lo, hi) {
            var x = Number(v);
            if (isNaN(x)) x = d;
            return Math.max(lo, Math.min(hi, x));
        }
        return {
            ratio: num(raw.ratio, 1, 0.25, 32),
            level: num(raw.level == null ? 1 : raw.level, 1, 0, 1),
            feedback: num(raw.feedback, 0, 0, 0.9),
            attack: num(raw.attack, 0.002, 0.001, 20),
            decay: num(raw.decay, 0.3, 0.001, 20),
            sustain: num(raw.sustain, 0, 0, 1),
            release: num(raw.release, 0.15, 0.005, 20)
        };
    }
    function fmHit(patch, freq, when, vel, gate, dest, mods) {
        var raw = (patch && patch.operators) || [];
        var out = (patch && patch.output) || [];
        var n = Math.min(raw.length, 6);
        if (!n || !out.length) return;
        vel = clamp01(vel == null ? 1 : vel);
        dest = dest || master;

        /* pass 1 - validate: every index and envelope time is parsed and
           defaulted before a single audio node exists, so pass 2 cannot
           throw mid-build or poison the transport with an exception */
        var isCarrier = [], targets = [], pars = [], links = [], i, k;
        for (i = 0; i < n; i++) { isCarrier.push(false); targets.push(-1); pars.push(fmOp(raw[i] || {})); }
        for (i = 0; i < out.length; i++) {
            k = Math.round(Number(out[i]));
            if (k >= 0 && k < n) isCarrier[k] = true;
        }
        var algo = patch.algorithm || {};
        Object.keys(algo).forEach(function (s) {
            var src = Math.round(Number(s));
            if (!(src >= 0 && src < n)) return;
            var dsts = Array.isArray(algo[s]) ? algo[s] : [algo[s]];
            dsts.forEach(function (d) {
                var dst = Math.round(Number(d));
                if (!(dst >= 0 && dst < n) || dst === src) return;
                links.push([src, dst]);
                if (targets[src] < 0) targets[src] = dst;
            });
        });
        var live = false;
        for (i = 0; i < n; i++) if (isCarrier[i] || targets[i] >= 0) live = true;
        if (!live) return;

        /* pass 2 - build. carrier envelopes hold amplitude; modulator
           envelopes hold depth in Hz, scaled by the TARGET operator's own
           frequency so the sidebands track the played note */
        var oscs = [], envs = [], aux = [], endAt = when;
        for (i = 0; i < n; i++) {
            oscs.push(null);
            envs.push(null);
            if (!isCarrier[i] && targets[i] < 0) continue;
            var p = pars[i];
            var f = Math.max(1, freq * p.ratio);
            var peak = isCarrier[i] ? p.level * vel * 0.5
                                    : p.level * vel * Math.max(1, freq * pars[targets[i]].ratio);
            peak = Math.max(0.0005, peak);
            var off = gate == null ? when + p.attack + p.decay
                                   : Math.max(when + p.attack + p.decay, when + gate);
            var end = gate == null ? when + p.attack + p.decay : off + p.release;
            var g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, when);
            g.gain.exponentialRampToValueAtTime(peak, when + p.attack);
            if (gate != null) {
                var sus = Math.max(0.0005, peak * Math.max(0.0001, p.sustain));
                g.gain.exponentialRampToValueAtTime(sus, when + p.attack + p.decay);
                if (off > when + p.attack + p.decay) g.gain.setValueAtTime(sus, off);
                g.gain.exponentialRampToValueAtTime(0.0001, end);
            } else {
                g.gain.exponentialRampToValueAtTime(0.0001, end);
            }
            var osc = ctx.createOscillator();
            osc.type = "sine";
            osc.frequency.setValueAtTime(f, when);
            osc.connect(g);
            attachMods(mods, osc.detune);
            if (p.feedback > 0) {
                var fbg = ctx.createGain();
                fbg.gain.value = p.feedback * f * 0.25;
                var dl = ctx.createDelay(0.05);
                dl.delayTime.value = Math.min(0.01, 4 / ctx.sampleRate);
                osc.connect(fbg);
                fbg.connect(dl);
                dl.connect(osc.frequency);
                aux.push(fbg);
                aux.push(dl);
            }
            osc.start(when);
            osc.stop(end + 0.02);
            if (isCarrier[i]) g.connect(dest);
            oscs[i] = osc;
            envs[i] = g;
            if (end > endAt) endAt = end;
        }

        /* wire the algorithm: modulator envelope out -> target frequency */
        for (i = 0; i < links.length; i++) {
            var srcEnv = envs[links[i][0]];
            var dstOsc = oscs[links[i][1]];
            if (srcEnv && dstOsc) srcEnv.connect(dstOsc.frequency);
        }

        /* teardown measured from the AUDIO clock (the old one timed from
           wall-clock "now" while the note could still be lookahead-future,
           disconnecting still-releasing voices = abrupt cutoff) */
        (function (nodes) {
            var ms = Math.max(300, (endAt - ctx.currentTime + 0.25) * 1000);
            setTimeout(function () {
                nodes.forEach(function (x) { try { x.disconnect(); } catch (e) {} });
            }, ms);
        })(oscs.concat(envs, aux).filter(Boolean));
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

    /* classic DX7 "warm pad"-flavoured preset: slow swelling attack, two gentle
       modulators on a sine carrier - smooth and glassy instead of buzzy */
    var FM_PAD = {
        operators: [
            { ratio: 1.0, level: 0.28, attack: 0.55, decay: 1.3, sustain: 0.55, release: 0.7 },
            { ratio: 2.0, level: 0.09, attack: 0.9, decay: 1.6, sustain: 0.3, release: 0.9 },
            { ratio: 1.0, level: 1.0, attack: 0.45, decay: 1.4, sustain: 0.85, release: 0.6 }
        ],
        algorithm: { 0: [2], 1: [2] },
        output: [2]
    };

    /* waveform cache: DFT-generated PeriodicWaves (phase distortion,
       wavetable, chip duty) share this; keys are quantised so every distinct
       wave is built at most once per session. */
    var waveCache = new Map();
    var WT_H = 96;
    function dftWave(key, fn, norm) {
        var w = waveCache.get(key);
        if (w) return w;
        var H = 48;
        var N = H * 8;
        var s = new Float32Array(N);
        for (var i = 0; i < N; i++) s[i] = fn(i / N);
        var re = new Float32Array(H), im = new Float32Array(H);
        for (var k = 1; k < H; k++) {
            var a = 0, b = 0;
            for (var i = 0; i < N; i++) {
                var ph = 2 * Math.PI * k * i / N;
                a += s[i] * Math.cos(ph);
                b += s[i] * Math.sin(ph);
            }
            re[k] = 2 * a / N;
            im[k] = -2 * b / N;
        }
        if (norm) {
            /* normalise to peak harmonic amplitude 1, so a shape keeps a steady
               loudness as its harmonic count changes */
            var peakH = 0;
            for (var k2 = 1; k2 < H; k2++) peakH = Math.max(peakH, Math.hypot(re[k2], im[k2]));
            if (peakH > 0) {
                for (var k3 = 1; k3 < H; k3++) { re[k3] /= peakH; im[k3] /= peakH; }
            }
        }
        w = ctx.createPeriodicWave(re, im);
        waveCache.set(key, w);
        return w;
    }
    function n01(v, d, lo, hi) { v = Number(v); if (isNaN(v)) v = d; return Math.max(lo, Math.min(hi, v)); }

    /* band-limited basic shapes (built analytically, no DFT): native
       square/saw oscillators alias harshly above ~1 kHz, which is most of a
       lead's range. 64 partials covers everything musical at these pitches. */
    function basicWave(type) {
        var key = "basic" + type;
        var w = waveCache.get(key);
        if (w) return w;
        var H = 64, re = new Float32Array(H), im = new Float32Array(H), k;
        for (k = 1; k < H; k++) {
            if (type === "square") { if (k % 2) im[k] = 4 / (Math.PI * k); }
            else im[k] = -2 / (Math.PI * k);
        }
        w = ctx.createPeriodicWave(re, im);
        waveCache.set(key, w);
        return w;
    }

    /* phase distortion (Casio CZ flavour): the ramp's phase is warped around
       its wrap point - shape 0.05 saw-bright, 0.5 hollow triangle, 0.95
       reversed saw. two cached waves crossfade over pd.decay for the classic
       brightness settle. */
    function pdWave(s) {
        return dftWave("pd" + Math.round(s * 40), function (p) {
            var q = p < s ? p * (0.5 / s) : 0.5 + (p - s) * (0.5 / (1 - s));
            return 2 * q - 1;
        });
    }
    /* constant-power crossfade pair: linear ramps dip about 3 dB at the
       midpoint, equal-power holds the perceived level through a sweep */
    function powerFade(t) {
        t = n01(t, 0, 1);
        return [Math.cos(t * Math.PI / 2), Math.sin(t * Math.PI / 2)];
    }
    function pdVoice(pd, freq, when, stopAt, bus, mods) {
        var sA = n01(pd.shape, 0.12, 0.02, 0.98);
        var sB = n01(pd.shape_end, 0.5, 0.02, 0.98);
        var ct = n01(pd.decay, 0.25, 0.01, 4);
        var oA = ctx.createOscillator();
        oA.setPeriodicWave(pdWave(sA));
        oA.frequency.setValueAtTime(freq, when);
        var gA = ctx.createGain();
        gA.gain.setValueAtTime(1, when);
        oA.connect(gA);
        gA.connect(bus);
        attachMods(mods, oA.detune);
        oA.start(when);
        oA.stop(when + stopAt + 0.02);
        if (Math.abs(sA - sB) > 0.001) {
            var oB = ctx.createOscillator();
            oB.setPeriodicWave(pdWave(sB));
            oB.frequency.setValueAtTime(freq, when);
            var gB = ctx.createGain();
            gB.gain.setValueAtTime(0, when);
            oB.connect(gB);
            gB.connect(bus);
            attachMods(mods, oB.detune);
            oB.start(when);
            oB.stop(when + stopAt + 0.02);
            var NSEG = 12;
            for (var i = 1; i <= NSEG; i++) {
                var f = powerFade(i / NSEG);
                gA.gain.linearRampToValueAtTime(f[0], when + ct * i / NSEG);
                gB.gain.linearRampToValueAtTime(f[1], when + ct * i / NSEG);
            }
        }
    }

    /* wavetable: procedurally generated additive tables, built as a partial
       sum straight into harmonic coefficients (no time-domain DFT round trip,
       so partials land exactly on the bin and stay band-limited). Position 0
       is the bare/soft end of the table, 1 the fully formed bright end. */
    var WT_PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47];
    /* per-partial shape at full formation; fold = mirror phase, quad = the
       1-0-(-1)-0 pattern Serum's basic shapes get their hollow edge from */
    function wtShape(table, k, amps) {
        /* custom table: raw per-harmonic amplitudes, negative = phase-flipped */
        if (amps) { var av = Number(amps[k - 1]); return { a: isNaN(av) ? 0 : av, fold: true }; }
        switch (table) {
            case "basic": case "saw": return { a: 1 / k, fold: true };
            case "even": return k % 2 ? { a: 0 } : { a: 1 / k, fold: true };
            case "odd": return k % 2 ? { a: 1 / k, fold: true } : { a: 0 };
            case "quad": return k % 4 === 1 ? { a: 1 / k } : (k % 4 === 3 ? { a: -1 / k } : { a: 0 });
            case "sparse": return WT_PRIMES.indexOf(k) >= 0 ? { a: 1 / Math.sqrt(k), fold: true } : { a: 0 };
            case "bell": return { a: (k <= 3 ? 1 : 1 / Math.pow(k, 1.7)) * (k % 2 ? 1 : 0.55), fold: true };
            case "vocal": return { a: (1 / k) * Math.exp(-Math.pow(Math.log(k / 3.2) / 1.15, 2)), fold: true };
            case "organ": return { a: k % 2 ? 1 / k : 0.62 / k, fold: true };
            default: return { a: Math.pow(1 / k, 0.8), fold: true };
        }
    }
    /* how far a table has opened at harmonic k for sweep position p. the
       threshold is logarithmic in k (matching how pitch is heard), so the
       sweep sounds evenly paced from sine to full spectrum; p=0 leaves only
       the fundamental, p=1 opens the whole band-limited table */
    function wtOpen(p, k, cap) {
        if (k === 1) return 1;
        var f = 0.1 + 0.9 * Math.log(k) / Math.log(Math.max(4, cap));
        return 1 / (1 + Math.exp(-(p * 1.05 - f) * 10));
    }
    /* build the coefficient pair for one table position, scaled so the summed
       waveform sits at roughly unit peak whatever the shape */
    function wtCoeffs(table, p, cap, out, amps) {
        var re = new Float64Array(WT_H), im = new Float64Array(WT_H);
        var lim = Math.max(2, Math.min(WT_H - 1, cap));
        var peak = 0, k, sh, gate, a;
        for (k = 1; k <= lim; k++) {
            sh = wtShape(table, k, amps);
            gate = wtOpen(p, k, lim);
            a = sh.a * gate;
            if (!a) continue;
            if (sh.fold) re[k] = a; else im[k] = a;
            peak += Math.abs(a);
        }
        var norm = peak > 0 ? 0.72 / peak : 1;
        for (k = 1; k < WT_H; k++) { re[k] *= norm; im[k] *= norm; }
        out.re = re; out.im = im;
    }
    var wtScratch = { re: null, im: null };
    function wtWave(table, p, cap, amps) {
        var key = "wt" + table + "|" + Math.round(p * 64) + "|" + cap;
        var w = waveCache.get(key);
        if (w) return w;
        wtCoeffs(table, p, cap, wtScratch, amps);
        /* createPeriodicWave only accepts Float32Array - Float64 inputs throw */
        w = ctx.createPeriodicWave(Float32Array.from(wtScratch.re), Float32Array.from(wtScratch.im));
        waveCache.set(key, w);
        return w;
    }
    /* audible partial count at this pitch, so a low bass note gets a dense
       table and a high lead gets a clean one instead of aliasing */
    function wtCap(freq) {
        return Math.max(2, Math.min(WT_H - 1, Math.floor((ctx.sampleRate * 0.44) / Math.max(20, freq))));
    }
    /* wavetable voice. Without an LFO the table sweeps once from pos_start to
       pos_end (attack motion). With lfo {rate, depth, target, wave} the core
       voice either wobbles - position retraced along the LFO waveform between
       pos_start and pos_end, depth scaling the excursion around the midpoint
       - or vibratos (target "pitch", depth 1 = a full semitone). */
    function wtVoice(wt, freq, when, stopAt, bus, mods) {
        /* custom table: a raw list of harmonic amplitudes gets a stable cache
           key derived from its values; built-ins keep their name key */
        var amps = null, table;
        if (Array.isArray(wt.table)) {
            amps = wt.table.map(Number).slice(0, 64);
            table = "arr:" + amps.map(function (x) { return Math.round((isNaN(x) ? 0 : x) * 1000) / 1000; }).join(",");
        } else {
            table = String(wt.table || "basic");
        }
        var p0 = n01(wt.pos_start, 0.05, 0, 1);
        var p1 = n01(wt.pos_end, 0.9, 0, 1);
        var sweep = n01(wt.pos_time, 0.4, 0.01, 8);
        /* curve shapes the sweep trajectory: <1 rushes out of the attack,
           >1 creeps then blooms - Serum's slope control */
        var curve = n01(wt.curve, 1, 0.2, 5);
        var cap = wtCap(freq);
        var lf = (wt.lfo && typeof wt.lfo === "object") ? wt.lfo : null;
        var lDepth = lf ? n01(lf.depth, 0.5, 0, 1) : 0;
        var lTarget = lf ? String(lf.target || "pos") : "pos";
        var lRate = lf ? n01(lf.rate, 5, 0.05, 40) : 5;
        var lWave = lf ? String(lf.wave || "sine") : "sine";
        var posLfo = !!(lf && lDepth > 0 && lTarget === "pos" && Math.abs(p1 - p0) * cap >= 0.6);
        var pitchLfo = !!(lf && lDepth > 0 && lTarget === "pitch");
        var lfo = null, lfoAmt = null;
        if (pitchLfo) {
            lfo = ctx.createOscillator();
            lfo.type = lWave === "square" ? "square" : lWave === "triangle" ? "triangle" : "sine";
            lfo.frequency.value = lRate;
            lfoAmt = ctx.createGain();
            lfoAmt.gain.value = lDepth * 100;
            lfo.connect(lfoAmt);
            lfo.start(when);
            lfo.stop(when + stopAt + 0.05);
        }
        /* precompute the position timeline: either one fading sweep across the
           table, or a repeating LFO path sampled at 16 table snapshots per
           LFO cycle (capped so a long note can never explode node counts) */
        var segs = [];
        var s, w, ph;
        if (posLfo) {
            var mid = (p0 + p1) / 2, half = (p1 - p0) / 2 * lDepth;
            var segDur = Math.max(1 / (lRate * 16), stopAt / 220);
            var n = Math.max(2, Math.ceil(stopAt / segDur));
            for (s = 0; s < n; s++) {
                ph = s * segDur * lRate;
                w = lWave === "square" ? ((ph % 1) < 0.5 ? 1 : -1)
                    : lWave === "triangle" ? (1 - 4 * Math.abs((ph % 1) - 0.5))
                    : Math.sin(2 * Math.PI * ph);
                segs.push({ p: n01(mid + half * w, 0.5, 0, 1), t: s * segDur, d: segDur });
            }
        } else {
            var steps = Math.round(n01(wt.steps, p1 === p0 ? 1 : Math.max(6, sweep * 24), 1, 64));
            var dt = sweep / steps;
            /* the step count is a density cap only; a sweep with no audible
               movement collapses to a single static table */
            if (Math.abs(p1 - p0) * cap < 0.6) { steps = 1; dt = sweep; }
            for (s = 0; s < steps; s++) {
                var frac = steps === 1 ? 1 : Math.pow(s / (steps - 1), curve);
                segs.push({ p: p0 + (p1 - p0) * frac, t: s * dt, d: dt });
            }
        }
        /* sampling at a fixed density lands several reads on the same
           quantised table; merge those runs so a square wobble (2 states)
           spawns two voices, not one per sample */
        var merged = [];
        for (i = 0; i < segs.length; i++) {
            var lastM = merged[merged.length - 1];
            if (lastM && Math.round(lastM.p * 64) === Math.round(segs[i].p * 64)) lastM.d += segs[i].d;
            else merged.push(segs[i]);
        }
        segs = merged;
        /* square wobbles keep their edge, so their crossfade is near instant */
        var fade = segs.length === 1 ? 0 : Math.min(segs[0].d * (posLfo ? (lWave === "square" ? 0.15 : 0.5) : 0.9), posLfo && lWave === "square" ? 0.003 : 0.02);
        for (var i = 0; i < segs.length; i++) {
            var t0 = when + segs[i].t;
            var o = ctx.createOscillator();
            o.setPeriodicWave(wtWave(table, segs[i].p, cap, amps));
            o.frequency.setValueAtTime(freq, when);
            /* start BEFORE scheduling stop - Web Audio throws InvalidStateError
               on stop() for a source that has not been started yet */
            o.start(t0);
            var g = ctx.createGain();
            if (i === 0) g.gain.setValueAtTime(1, when);
            else { g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(1, t0 + fade); }
            if (i < segs.length - 1) {
                g.gain.setValueAtTime(1, t0 + segs[i].d);
                g.gain.linearRampToValueAtTime(0, t0 + segs[i].d + fade);
                o.stop(t0 + segs[i].d + fade + 0.02);
            } else {
                o.stop(when + stopAt + 0.02);
            }
            o.connect(g);
            g.connect(bus);
            if (lfo) lfoAmt.connect(o.detune);
            attachMods(mods, o.detune);
        }
        /* Serum's unison: voices detuned symmetrically around pitch with a
           deterministic per-voice phase offset, which is what turns one thin
           wave into a wide, slowly moving stack */
        var uni = Math.round(n01(wt.unison, 0, 0, 8));
        if (uni && uni % 2) uni++;
        var det = n01(wt.detune, 0.12, 0, 1) * 28;
        var spread = n01(wt.spread, 0.5, 0, 1);
        /* start offsets decorrelate the stack (the width effect), but stay
           tiny so the unison still lands on the beat */
        var jit = Math.min(segs[0].d, 0.03);
        for (var u = 0; u < uni; u++) {
            var side = (u % 2 ? 1 : -1) * det * (1 + Math.floor(u / 2) * 0.75);
            ph = (0.11 + 0.37 * ((u * 7) % 5) / 5) % 1;
            var ov = ctx.createOscillator();
            ov.setPeriodicWave(wtWave(table, p1, cap, amps));
            ov.detune.setValueAtTime(side, when);
            var gv = ctx.createGain();
            gv.gain.setValueAtTime(0.9 / uni, when);
            ov.connect(gv);
            /* fan the stack across the stereo field - the width half of a
               proper supersaw */
            if (uni > 1 && spread > 0 && ctx.createStereoPanner) {
                var upn = ctx.createStereoPanner();
                upn.pan.value = (u / (uni - 1) * 2 - 1) * spread;
                gv.connect(upn);
                upn.connect(bus);
            } else gv.connect(bus);
            ov.start(when + ph * jit);
            ov.stop(when + stopAt + 0.02);
            if (lfo) lfoAmt.connect(ov.detune);
            attachMods(mods, ov.detune);
        }
    }

    /* chip (NES 2A03 flavour): pulse wave at a set duty, optional duty sweep
       and authentic rate-stepped arpeggio */
    function chipWave(d) {
        return dftWave("chip" + Math.round(d * 40), function (p) { return p < d ? 1 : -1; });
    }
    function chipVoice(chip, freq, when, stopAt, bus, mods) {
        var dA = n01(chip.duty, 0.5, 0.03, 0.5);
        var dB = chip.duty_end == null ? dA : n01(chip.duty_end, dA, 0.03, 0.5);
        var oscs = [ctx.createOscillator()];
        oscs[0].setPeriodicWave(chipWave(dA));
        oscs[0].frequency.setValueAtTime(freq, when);
        var gA = ctx.createGain();
        gA.gain.setValueAtTime(1, when);
        oscs[0].connect(gA);
        gA.connect(bus);
        attachMods(mods, oscs[0].detune);
        oscs[0].start(when);
        oscs[0].stop(when + stopAt + 0.02);
        if (Math.abs(dA - dB) > 0.001) {
            var sw = n01(chip.duty_time, 0.15, 0.01, 4);
            var oB = ctx.createOscillator();
            oB.setPeriodicWave(chipWave(dB));
            oB.frequency.setValueAtTime(freq, when);
            var gB = ctx.createGain();
            gB.gain.setValueAtTime(0, when);
            oB.connect(gB);
            gB.connect(bus);
            attachMods(mods, oB.detune);
            oscs.push(oB);
            oB.start(when);
            oB.stop(when + stopAt + 0.02);
            for (var q = 1; q <= 12; q++) {
                var fq = powerFade(q / 12);
                gA.gain.linearRampToValueAtTime(fq[0], when + sw * q / 12);
                gB.gain.linearRampToValueAtTime(fq[1], when + sw * q / 12);
            }
        }
        var arp = (Array.isArray(chip.arp) ? chip.arp : []).map(Number).filter(function (x) { return !isNaN(x); }).slice(0, 8);
        if (arp.length) {
            var rate = n01(chip.arp_rate, 25, 1, 100);
            var step = 1 / rate;
            var n = Math.min(400, Math.ceil(stopAt / step));
            for (var i = 0; i < n; i++) {
                var f = Math.max(20, freq * Math.pow(2, arp[i % arp.length] / 12));
                for (var j = 0; j < oscs.length; j++) oscs[j].frequency.setValueAtTime(f, when + i * step);
            }
        }
    }

    /* granular: pitch-locked swarm of tiny windowed grains. the source is one
       sine cycle (looped, playbackRate = f/f0 per note) or noise for shimmer
       clouds. grain count caps at 400 per note for safety. */
    var grainSrc = null;
    function grainSource() {
        if (grainSrc) return grainSrc;
        var len = Math.max(8, Math.round(ctx.sampleRate / 110));
        grainSrc = ctx.createBuffer(1, len, ctx.sampleRate);
        var d = grainSrc.getChannelData(0);
        for (var i = 0; i < len; i++) d[i] = Math.sin(2 * Math.PI * i / len);
        return grainSrc;
    }
    function grainVoice(gr, freq, when, vel, dur, bus) {
        var gs = n01(gr.size, 0.08, 0.01, 1);
        var rate = n01(gr.rate, 14, 1, 80);
        var scatter = n01(gr.scatter, 0.015, 0, 0.2);
        var noise = String(gr.src) === "noise";
        var buf = noise ? noiseBuffer() : grainSource();
        var d = Math.max(0.1, dur == null ? 0.6 : dur);
        var n = Math.max(1, Math.min(400, Math.round(d * rate)));
        var gap = d / n;
        var amp = vel * 0.7 / Math.sqrt(Math.max(4, n));
        for (var i = 0; i < n; i++) {
            var t = when + i * gap + Math.random() * gap * 0.5;
            var src = ctx.createBufferSource();
            src.buffer = buf;
            src.loop = true;
            src.playbackRate.value = noise
                ? Math.max(0.05, 1 + scatter * (Math.random() * 2 - 1))
                : Math.max(0.05, (freq / 110) * (1 + scatter * (Math.random() * 2 - 1)));
            var g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t);
            g.gain.linearRampToValueAtTime(amp, t + gs * 0.5);
            g.gain.linearRampToValueAtTime(0.0001, t + gs);
            src.connect(g);
            g.connect(bus);
            src.start(t, Math.random() * buf.duration * 0.9);
            src.stop(t + gs + 0.02);
        }
    }

    /* -------------------------
     * per-loop routing: FX chain, stereo pan, sidechain ducking
     * ------------------------- */
    var DELAY_SYNC = { "1/1": 4, bar: 4, "1/2": 2, "1/4": 1, "1/4d": 1.5, "1/8": 0.5, "1/8d": 0.75, "1/8t": 2 / 3, "1/16": 0.25, "1/16d": 0.375, "1/16t": 1 / 3 };
    var LFO_SYNC = { "1/1": 4, bar: 4, "1/2": 2, "1/4": 1, "1/8": 0.5, "1/16": 0.25, "1/32": 0.125, "1/4t": 1.5, "1/8t": 2 / 3, "1/16t": 1 / 3 };

    function attachMods(mods, param) {
        if (!mods) return;
        for (var i = 0; i < mods.length; i++) { try { mods[i].connect(param); } catch (e) {} }
    }

    function distCurve(kind, d, bits) {
        var n = 2048, c = new Float32Array(n), i, x;
        if (kind === "crush") {
            var steps = Math.pow(2, Math.max(1, Math.min(8, Number(bits) || 5)));
            var pgain = 1 + d * 6;
            for (i = 0; i < n; i++) {
                x = ((2 * i) / (n - 1) - 1) * pgain;
                c[i] = Math.max(-1, Math.min(1, Math.round(x * steps) / steps));
            }
            return c;
        }
        if (kind === "hard") {
            var k = 0.25 + d * 0.6;
            for (i = 0; i < n; i++) {
                x = ((2 * i) / (n - 1) - 1) / k;
                c[i] = Math.max(-1, Math.min(1, x));
            }
            return c;
        }
        if (kind === "fold") {
            var g = 1 + d * 4;
            for (i = 0; i < n; i++) {
                x = ((2 * i) / (n - 1) - 1) * g;
                c[i] = Math.asin(Math.sin(x * Math.PI / 2)) * (2 / Math.PI);
            }
            return c;
        }
        return tanhCurve(1.2 + d * 6);
    }

    /* one stage of a loop's FX chain: wraps nextIn, returns the stage input */
    function buildFxStage(fx, nextIn, synced, keepAlive) {
        var t = String((fx && fx.type) || "").toLowerCase();
        var input, i;
        if (t === "dist") {
            var d = n01(fx.drive, 0.5, 0, 1);
            var mix = n01(fx.mix, 1, 0, 1);
            input = ctx.createGain();
            var pre = ctx.createGain(); pre.gain.value = 1 + d * 8;
            var sh = ctx.createWaveShaper(); sh.curve = distCurve(String(fx.curve || "tanh"), d, fx.bits);
            var post = ctx.createGain(); post.gain.value = 1 / (0.6 + d * 1.4);
            var wet = ctx.createGain(); wet.gain.value = mix;
            var dry = ctx.createGain(); dry.gain.value = 1 - mix;
            input.connect(pre); pre.connect(sh); sh.connect(post); post.connect(wet); wet.connect(nextIn);
            input.connect(dry); dry.connect(nextIn);
            return input;
        }
        if (t === "chorus") {
            var rate = n01(fx.rate, 0.6, 0.05, 4);
            var depth = n01(fx.depth, 0.5, 0, 1) * 0.0028;
            var cmix = n01(fx.mix, 0.4, 0, 1);
            input = ctx.createGain();
            var cdry = ctx.createGain(); cdry.gain.value = 1 - cmix;
            var cwet = ctx.createGain(); cwet.gain.value = cmix * 0.9;
            input.connect(cdry); cdry.connect(nextIn); cwet.connect(nextIn);
            var offs = [0.021, 0.027], pans = [-0.7, 0.7];
            for (i = 0; i < 2; i++) {
                var dl = ctx.createDelay(0.1); dl.delayTime.value = offs[i];
                input.connect(dl);
                if (ctx.createStereoPanner) {
                    var pn = ctx.createStereoPanner(); pn.pan.value = pans[i];
                    dl.connect(pn); pn.connect(cwet);
                } else dl.connect(cwet);
                var lo = ctx.createOscillator(); lo.type = "sine"; lo.frequency.value = rate;
                var lg = ctx.createGain(); lg.gain.value = i ? -depth : depth;
                lo.connect(lg); lg.connect(dl.delayTime);
                lo.start();
                keepAlive.push(lo);
            }
            return input;
        }
        if (t === "delay") {
            var secs = Number(fx.time);
            var beats = null;
            if (!(secs >= 0.01)) {
                beats = DELAY_SYNC[String(fx.sync || "1/4")];
                secs = beats != null ? beats * 60 / bpm : 0.375;
            }
            var dinput = ctx.createGain();
            var dmix = n01(fx.mix, 0.3, 0, 1);
            var ddry = ctx.createGain(); ddry.gain.value = 1 - dmix;
            dinput.connect(ddry); ddry.connect(nextIn);
            var wetg = ctx.createGain(); wetg.gain.value = dmix; wetg.connect(nextIn);
            var lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = n01(fx.damp, 4500, 200, 16000);
            var fbg = ctx.createGain(); fbg.gain.value = n01(fx.feedback, 0.35, 0, 0.92);
            var dt = Math.max(0.01, Math.min(2, secs));
            var d1 = ctx.createDelay(2); d1.delayTime.value = dt;
            dinput.connect(d1);
            if (beats != null) synced.push({ node: d1, beats: beats });
            if (fx.pingpong && ctx.createStereoPanner) {
                var d2 = ctx.createDelay(2); d2.delayTime.value = dt;
                if (beats != null) synced.push({ node: d2, beats: beats });
                var pL = ctx.createStereoPanner(); pL.pan.value = -0.8;
                var pR = ctx.createStereoPanner(); pR.pan.value = 0.8;
                d1.connect(pL); pL.connect(wetg); pL.connect(lp);
                d2.connect(pR); pR.connect(wetg); pR.connect(lp);
                lp.connect(fbg); fbg.connect(d1); fbg.connect(d2);
            } else {
                d1.connect(lp); lp.connect(fbg); fbg.connect(d1); d1.connect(wetg);
            }
            return dinput;
        }
        if (t === "verb") {
            input = ctx.createGain();
            input.connect(nextIn);
            if (verbSend) {
                var vs = ctx.createGain(); vs.gain.value = n01(fx.mix, 0.3, 0, 1) * 1.15;
                input.connect(vs); vs.connect(verbSend);
            }
            return input;
        }
        return nextIn;
    }

    function destroyChain(e) {
        if (!e || !e.chain) return;
        var c = e.chain;
        e.chain = null;
        try { c.input.disconnect(); } catch (x) {}
        try { c.duck.disconnect(); } catch (x) {}
        (c.lfos || []).forEach(function (lo) { try { lo.stop(); lo.disconnect(); } catch (x) {} });
    }

    /* lazy per-loop chain (built once audio is unlocked): voices -> fx -> pan
       -> duck -> master/instrument bus; only created when the loop asks for
       one, so plain loops stay on the direct path */
    function ensureChain(loop) {
        if (loop.chain || !ctx || !loop.def) return;
        var d = loop.def;
        if (!d.sidechain && !(d.fx && d.fx.length) && d.pan == null) return;
        try {
            var duck = ctx.createGain();
            duck.gain.value = 1;
            duck.connect(audioOut(d.voice || d.instrument));
            var pan = null;
            if (ctx.createStereoPanner) {
                pan = ctx.createStereoPanner();
                pan.pan.value = Math.max(-1, Math.min(1, Number(loop.panOv != null ? loop.panOv : (d.pan || 0))));
                pan.connect(duck);
            }
            var nextIn = pan || duck;
            var synced = [], lfos = [];
            var input = nextIn;
            if (d.fx && d.fx.length) {
                for (var i = d.fx.length - 1; i >= 0; i--) input = buildFxStage(d.fx[i], input, synced, lfos) || input;
            }
            loop.chain = { input: input, duck: duck, pan: pan, synced: synced, lfos: lfos };
        } catch (e) { loop.chain = null; }
    }

    /* sidechain pump: duck the loop on a fixed grid, phase-aligned to the bar.
       chained linear ramps stay continuous even when ducks overlap. */
    function scheduleDucks(loop, from, to) {
        var sc = loop.def && loop.def.sidechain;
        if (!sc || !loop.chain) return;
        var iv = sc.rate === "8th" ? 2 : sc.rate === "16th" ? 1 : 4;
        var depth = Math.max(0, Math.min(0.95, Number(sc.depth) || 0.65));
        var atk = Math.max(0.001, Number(sc.attack) || 0.006);
        var rel = Math.max(0.02, Number(sc.release) || 0.22);
        var g = loop.chain.duck.gain;
        for (var k = Math.ceil(from / iv) * iv; k < to; k += iv) {
            var v = loop.occT0 + k * loop.occCell;
            g.linearRampToValueAtTime(1 - depth, v + atk);
            g.linearRampToValueAtTime(1, v + atk + rel);
        }
    }

    /* voice LFOs: def.lfo = {target: pitch|cutoff|amp, rate: Hz or tempo sync
       ("1/8", "1/16t", "bar"...), wave, depth 0-1, delay: fade-in s} or a list
       of up to 4. cutoff/amp connect to the voice's own nodes; pitch mods are
       returned so every engine can attach them to each oscillator's detune. */
    function buildVoiceLfos(def, when, stopAt, tgt) {
        var list = def.lfo == null ? [] : (Array.isArray(def.lfo) ? def.lfo : [def.lfo]);
        var nodes = [];
        for (var i = 0; i < list.length && i < 4; i++) {
            var l = list[i];
            if (!l || typeof l !== "object") continue;
            var target = String(l.target || "pitch").toLowerCase();
            var hz = Number(l.rate);
            if (!(hz >= 0.05)) {
                var beats = LFO_SYNC[String(l.rate || "1/8")];
                hz = beats != null ? (bpm / 60) / beats : 5;
            }
            var depth = n01(l.depth, 0.5, 0, 1);
            if (depth <= 0.001) continue;
            var wave = String(l.wave || "sine").toLowerCase();
            var lo = ctx.createOscillator();
            lo.type = wave === "square" ? "square" : wave === "triangle" ? "triangle" : wave === "sawtooth" ? "sawtooth" : "sine";
            lo.frequency.value = hz;
            var amt = ctx.createGain();
            var amtVal = target === "cutoff" ? depth * Math.max(30, tgt.cutoff || 1000) * 0.98
                : target === "amp" ? depth * (tgt.ampPeak || 0.5)
                : depth * 100;
            var dl = n01(l.delay, 0, 0, 8);
            if (dl > 0.005) {
                amt.gain.setValueAtTime(0.0001, when);
                amt.gain.linearRampToValueAtTime(amtVal, when + dl);
            } else amt.gain.value = amtVal;
            lo.connect(amt);
            lo.start(when);
            lo.stop(when + stopAt + 0.05);
            nodes.push(lo, amt);
            if (target === "cutoff") {
                for (var fi = 0; fi < (tgt.filters || []).length; fi++) amt.connect(tgt.filters[fi].frequency);
            } else if (target === "amp" && tgt.amp) amt.connect(tgt.amp.gain);
            else tgt.pitchMods.push(amt);
        }
        if (nodes.length) {
            (function (ns) {
                setTimeout(function () { ns.forEach(function (x) { try { x.disconnect(); } catch (e) {} }); }, (stopAt + 0.6) * 1000);
            })(nodes);
        }
        return tgt.pitchMods;
    }

    /* risers and downlifters: noise or a tone swept across the note's whole
       gate; from/to in Hz (0 = sensible default), curve shapes the rise. */
    function sweepVoice(sw, freq, when, stopAt, bus) {
        var kind = String(sw.src || "noise").toLowerCase();
        var curve = n01(sw.curve, 1, 0.2, 5);
        var durT = Math.max(0.08, stopAt);
        var g = ctx.createGain();
        g.gain.value = n01(sw.level, 0.4, 0, 1);
        g.connect(bus);
        var f0 = swClamp(sw.from, kind === "noise" ? 150 : freq / 2);
        var f1 = swClamp(sw.to, kind === "noise" ? 14000 : freq * 2);
        var n = 48, arr = new Float32Array(n), r = f1 / f0;
        for (var i = 0; i < n; i++) {
            var t = i / (n - 1);
            arr[i] = Math.max(10, Math.min(20000, f0 * Math.pow(r, Math.pow(t, curve))));
        }
        if (kind === "noise") {
            var src = ctx.createBufferSource();
            src.buffer = noiseBuffer();
            src.loop = true;
            var nf = ctx.createBiquadFilter();
            nf.type = String(sw.filter || "lowpass");
            nf.Q.value = n01(sw.q, 1.2, 0.0001, 12);
            nf.frequency.setValueCurveAtTime(arr, when, durT);
            src.connect(nf); nf.connect(g);
            src.start(when, Math.random() * 1.5);
            src.stop(when + durT + 0.05);
        } else {
            var osc = ctx.createOscillator();
            osc.type = kind === "sawtooth" ? "sawtooth" : kind === "square" ? "square" : kind === "triangle" ? "triangle" : "sine";
            osc.frequency.setValueCurveAtTime(arr, when, durT);
            osc.connect(g);
            osc.start(when);
            osc.stop(when + durT + 0.05);
        }
    }
    function swClamp(v, dflt) {
        var x = Number(v);
        if (!(x >= 10)) x = dflt;
        return Math.max(10, Math.min(20000, x));
    }

    function customHit(def, freq, when, vel, gate, dest) {
        dest = dest || master;
        var e = def.env || {};
        var attack = e.attack != null ? e.attack : 0.005;
        var decay = e.decay != null ? e.decay : 0.3;
        var sustain = e.sustain != null ? e.sustain : 0;
        var release = e.release != null ? e.release : 0.15;
        var peak = Math.max(0.0005, vel * 0.6);

        var amp = ctx.createGain();
        amp.connect(dest);
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

        /* ring modulator sits between the voice bus and the amp: its gain
           param is driven purely by the modulator osc (base 0), so the
           output is signal x sine - metallic sum/difference sidebands */
        var sink = amp;
        if (def.ring) {
            var ringG = ctx.createGain();
            ringG.gain.value = 0;
            ringG.connect(amp);
            sink = ringG;
        }
        var bus = sink;
        var filters = [];
        var cutoffNow = 8000;
        if (def.filter) {
            var fl = def.filter;
            var poles = Math.round(n01(fl.poles, 1, 1, 2));
            cutoffNow = fl.cutoff || 8000;
            if (fl.keytrack) cutoffNow *= Math.pow(Math.max(0.05, freq / 440), n01(fl.keytrack, 1, 0, 1));
            cutoffNow = Math.max(20, Math.min(20000, cutoffNow));
            var fOff = 0, fEnd = 0, fAtk = 0, fDec = 0.2;
            if (typeof fl.env === "number") {
                fOff = fl.env; fDec = fl.env_time || 0.2;
            } else if (fl.env && typeof fl.env === "object") {
                fOff = n01(fl.env.from, 24, -60, 60);
                fEnd = n01(fl.env.to, 0, -60, 60);
                fAtk = n01(fl.env.attack, 0, 0, 8);
                fDec = n01(fl.env.decay, 0.3, 0.01, 8);
            }
            for (var pi = 0; pi < poles; pi++) {
                var fp = ctx.createBiquadFilter();
                fp.type = fl.type || "lowpass";
                fp.Q.value = fl.q != null ? fl.q : 1;
                /* second pole a bit lower keeps the 24 dB cascade musical */
                var base = Math.max(20, Math.min(20000, cutoffNow * (pi ? 0.82 : 1)));
                var v0 = Math.max(20, Math.min(20000, base * Math.pow(2, fOff / 12)));
                var v1 = Math.max(20, Math.min(20000, base * Math.pow(2, fEnd / 12)));
                if (fOff || fEnd) {
                    fp.frequency.setValueAtTime(v0, when);
                    if (fAtk > 0.005) fp.frequency.setValueAtTime(v0, when + fAtk);
                    fp.frequency.exponentialRampToValueAtTime(v1, when + fAtk + fDec);
                } else {
                    fp.frequency.setValueAtTime(base, when);
                }
                fp.connect(pi ? filters[pi - 1] : sink);
                filters.push(fp);
            }
            if (filters.length) bus = filters[filters.length - 1];
        }

        var pitchMods = buildVoiceLfos(def, when, stopAt, { cutoff: cutoffNow, amp: amp, ampPeak: peak, filters: filters, pitchMods: [] });

        /* generic unison: whole engines re-struck detuned and fanned across
           the stereo field (the wavetable stacks its own voices internally) */
        var un = def.unison && typeof def.unison === "object" ? def.unison : null;
        var uni = un ? Math.max(1, Math.min(8, Math.round(Number(un.voices) || 3))) : 1;
        var udet = un ? n01(un.detune, 0.5, 0, 1) * 22 : 0;
        var uspr = un ? n01(un.spread, 0.7, 0, 1) : 0;
        function unFreq(u) {
            if (uni <= 1 || u === 0) return freq;
            var s = (u % 2 ? 1 : -1) * (1 + Math.floor((u - 1) / 2));
            return freq * Math.pow(2, ((s / Math.max(1, Math.ceil((uni - 1) / 2))) * udet) / 12);
        }
        function unOut(u, target) {
            if (uni <= 1) return target;
            var pg = ctx.createGain();
            pg.gain.value = 1 / Math.sqrt(uni);
            if (uspr > 0 && ctx.createStereoPanner) {
                var pn = ctx.createStereoPanner();
                pn.pan.value = (u / (uni - 1) * 2 - 1) * uspr;
                pg.connect(pn); pn.connect(target);
            } else pg.connect(target);
            return pg;
        }
        for (var u = 0; u < uni; u++) {
            var fu = unFreq(u);
            var cu = unOut(u, bus);
            if (def.pd) pdVoice(def.pd, fu, when, stopAt, cu, pitchMods);
            if (def.wt) wtVoice(def.wt, fu, when, stopAt, cu, pitchMods);
            if (def.chip) chipVoice(def.chip, fu, when, stopAt, cu, pitchMods);
            /* FM carries its own per-operator envelopes, so (as before) it
               feeds the destination directly instead of the amp'd bus */
            if (def.fm) fmHit(def.fm, fu, when, vel, gate, unOut(u, dest), pitchMods);
            if (def.grain && u === 0) grainVoice(def.grain, fu, when, vel, gate, cu);
            if (def.sweep && u === 0) sweepVoice(def.sweep, fu, when, stopAt, cu);
            var layers = def.osc || [];
            if (!layers.length && def.ring && !def.fm && !def.pd && !def.wt && !def.chip && !def.grain && !def.sweep) {
                layers = [{ type: "sine", level: 1 }];
            }
            for (var li = 0; li < layers.length; li++) {
                var o = layers[li];
                if (!o || !(o.level > 0)) continue;
                var osc = ctx.createOscillator();
                if (o.type === "square" || o.type === "sawtooth") {
                    /* native square/saw alias badly at mid/high pitches; route the
                       custom layers through the same band-limited tables */
                    osc.setPeriodicWave(basicWave(o.type));
                } else {
                    osc.type = o.type;
                }
                var f2 = fu * Math.pow(2, o.octave || 0);
                if (def.pitch && def.pitch.glide) {
                    osc.frequency.setValueAtTime(Math.max(1, f2 * Math.pow(2, def.pitch.glide / 12)), when);
                    osc.frequency.exponentialRampToValueAtTime(f2, when + (def.pitch.glide_time || 0.12));
                } else {
                    osc.frequency.setValueAtTime(f2, when);
                }
                osc.detune.setValueAtTime(o.detune || 0, when);
                attachMods(pitchMods, osc.detune);
                var og = ctx.createGain();
                og.gain.value = o.level;
                osc.connect(og);
                og.connect(cu);
                osc.start(when);
                osc.stop(when + stopAt);
            }
        }
        if (def.noise && def.noise.level > 0) {
            var src = ctx.createBufferSource();
            src.buffer = noiseBuffer();
            src.loop = true;
            var nf = ctx.createBiquadFilter();
            nf.type = def.noise.filter || "lowpass";
            nf.frequency.setValueAtTime(def.noise.freq || 2000, when);
            var ng = ctx.createGain();
            ng.gain.value = def.noise.level;
            src.connect(nf);
            nf.connect(ng);
            ng.connect(bus);
            src.start(when, Math.random() * 1.5);
            src.stop(when + stopAt);
        }
        if (def.ring) {
            var rf = Number(def.ring.freq);
            if (!(rf >= 20)) rf = Math.max(1, freq * n01(def.ring.ratio, 1.5, 0.05, 32));
            var rmo = ctx.createOscillator();
            rmo.type = "sine";
            rmo.frequency.setValueAtTime(rf, when);
            rmo.connect(sink);
            rmo.start(when);
            rmo.stop(when + stopAt + 0.02);
        }
    }

    /* -------------------------
     * user samples: audio files from webui/assets/samples/{fx,song}/ served
     * via /ext-assets/. fx samples are drum voices; song samples fire as
     * arrangement events (see gateSong's event pass).
     * ------------------------- */
    function loadSampleBuffer(ent) {
        if (!ent || ent.buffer || ent.loading || ent.failed) return;
        if (!ctx) { tryUnlock(); if (!ctx) return; }
        ent.loading = true;
        fetch(ent.url).then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.arrayBuffer();
        }).then(function (b) {
            return ctx.decodeAudioData(b);
        }).then(function (buf) {
            ent.buffer = buf;
            ent.loading = false;
        }).catch(function (e) {
            ent.failed = true;
            ent.loading = false;
            console.warn("[music_sequencer] sample could not be loaded: " + (ent.url || "?"), e);
        });
    }

    function fireSample(buf, when, vel, dest, pan, rate) {
        if (!ctx) return;
        var w = Math.max(when, ctx.currentTime + 0.004);
        var src = ctx.createBufferSource();
        src.buffer = buf;
        /* note samples re-fire pitched to each note (rate = 2^((midi-60)/12),
           C4 reference); fx and song events play at natural pitch */
        if (rate && rate !== 1) src.playbackRate.value = Math.max(0.06, Math.min(16, rate));
        var g = ctx.createGain();
        g.gain.value = Math.max(0, Math.min(1, vel == null ? 1 : vel));
        src.connect(g);
        if (pan && ctx.createStereoPanner) {
            var pn = ctx.createStereoPanner();
            pn.pan.value = Math.max(-1, Math.min(1, pan));
            g.connect(pn);
            pn.connect(dest || master);
        } else g.connect(dest || master);
        src.start(w);
    }

    /* hits are scheduled ~lookahead ahead; a sample whose decode is still
       running parks in sampleQueue and fires from rAF the moment its buffer
       is ready (exactly on time when decode beats the lookahead, late-
       rather-than-never when it does not) */
    function sampleAudio(name, when, vel, dest, pan, rate) {
        var ent = samples.get(String(name));
        if (!ent || ent.failed) return false;
        if (!ent.buffer) {
            loadSampleBuffer(ent);
            if (!ent.buffer) {
                sampleQueue.push({ ent: ent, t: when, vel: vel, dest: dest, pan: pan, rate: rate });
                return true;
            }
        }
        fireSample(ent.buffer, when, vel, dest, pan, rate);
        return true;
    }

    function drumHit(name, when, vel, dest) {
        dest = dest || master;
        var custom = sounds.get(String(name));
        if (custom) {
            customHit(custom, midiToFreq(custom.base_note || 36), when, vel, null, dest);
            return;
        }
        if (samples.has(String(name))) { sampleAudio(name, when, vel, dest, 0); return; }
        var o;
        switch (name) {
            case "kick": {
                clickHit(when, vel * 0.4, dest);
                var g = env(when, vel * 0.9, 0.003, 0.4, dest);
                o = burst(170, "sine", when, g);
                o.frequency.exponentialRampToValueAtTime(45, when + 0.09);
                o.frequency.exponentialRampToValueAtTime(38, when + 0.4);
                o.start(when); o.stop(when + 0.45);
                break;
            }
            case "snare": {
                /* crack (top), body (batter tone), shell (sides) - the classic
                   three-part snare build, plus a stick transient */
                clickHit(when, vel * 0.18, dest);
                noiseHit(when, vel * 0.5, 0.002, 0.16, "highpass", 1500, 0, dest);
                noiseHit(when, vel * 0.24, 0.001, 0.045, "bandpass", 3600, 1.1, dest);
                noiseHit(when, vel * 0.14, 0.002, 0.08, "bandpass", 880, 0.8, dest);
                var g2 = env(when, vel * 0.42, 0.002, 0.09, dest);
                o = burst(190, "triangle", when, g2);
                o.frequency.exponentialRampToValueAtTime(165, when + 0.09);
                o.start(when); o.stop(when + 0.12);
                var g3 = env(when, vel * 0.16, 0.002, 0.06, dest);
                var o3 = burst(335, "triangle", when, g3);
                o3.start(when); o3.stop(when + 0.09);
                break;
            }
            case "clap": {
                noiseHit(when, vel * 0.28, 0.001, 0.02, "bandpass", 1100, 1.2, dest);
                noiseHit(when + 0.011, vel * 0.28, 0.001, 0.02, "bandpass", 1150, 1.2, dest);
                noiseHit(when + 0.022, vel * 0.36, 0.001, 0.025, "bandpass", 1200, 1.2, dest);
                noiseHit(when + 0.034, vel * 0.45, 0.002, 0.16, "bandpass", 1250, 1.5, dest);
                /* stereo-ish sparkle tail on a higher band keeps the clap airy */
                noiseHit(when + 0.034, vel * 0.14, 0.002, 0.2, "bandpass", 4200, 0.9, dest);
                break;
            }
            case "hihat_closed":
                /* noise transient softens the squares' edge, then the metal ring */
                noiseHit(when, vel * 0.1, 0.0005, 0.008, "highpass", 8000, 0, dest);
                metalHat(when, vel * 0.3, 0.055, 8500, dest);
                break;
            case "hihat_open":
                noiseHit(when, vel * 0.08, 0.0005, 0.01, "highpass", 8000, 0, dest);
                metalHat(when, vel * 0.24, 0.42, 7500, dest);
                /* sustained sizzle under the ring so the open hat breathes */
                noiseHit(when, vel * 0.07, 0.004, 0.4, "highpass", 6000, 0, dest);
                break;
            case "tom": {
                noiseHit(when, vel * 0.12, 0.002, 0.025, "lowpass", 900, 0, dest);
                var gt = env(when, vel * 0.7, 0.003, 0.3, dest);
                o = burst(210, "sine", when, gt);
                o.frequency.exponentialRampToValueAtTime(92, when + 0.22);
                o.start(when); o.stop(when + 0.35);
                /* membrane overtone (~1.5x fundamental) gives the tuned skin */
                var go = env(when, vel * 0.16, 0.003, 0.18, dest);
                var o2 = burst(315, "triangle", when, go);
                o2.frequency.exponentialRampToValueAtTime(138, when + 0.15);
                o2.start(when); o2.stop(when + 0.24);
                var go2 = env(when, vel * 0.1, 0.003, 0.12, dest);
                var o4 = burst(420, "sine", when, go2);
                o4.frequency.exponentialRampToValueAtTime(185, when + 0.12);
                o4.start(when); o4.stop(when + 0.2);
                /* stick accent for definition in a mix */
                noiseHit(when, vel * 0.06, 0.001, 0.02, "bandpass", 1400, 1, dest);
                break;
            }
            case "rim": {
                /* two-pulse rimshot: bright metal tick + woody stick snap */
                var gr = envFiltered(when, vel * 0.5, 0.001, 0.03, 1700, dest);
                o = burst(1700, "square", when, gr);
                o.start(when); o.stop(when + 0.05);
                var gr2 = envFiltered(when, vel * 0.32, 0.001, 0.014, 480, dest);
                var or2 = burst(480, "square", when, gr2);
                or2.start(when); or2.stop(when + 0.03);
                noiseHit(when, vel * 0.12, 0.001, 0.015, "highpass", 2200, 0, dest);
                break;
            }
            case "cowbell": {
                /* classic 808: 540+800 Hz squares through a bandpass, with a
                   sharp attack burst then the ringing body */
                var gc = envFiltered(when, vel * 0.3, 0.001, 0.26, 2600, dest);
                var a = burst(540, "square", when, gc);
                var b = burst(800, "square", when, gc);
                a.start(when); a.stop(when + 0.32);
                b.start(when); b.stop(when + 0.32);
                var gca = envFiltered(when, vel * 0.34, 0.0008, 0.035, 2600, dest);
                var a2 = burst(540, "square", when, gca);
                var b2 = burst(800, "square", when, gca);
                a2.start(when); a2.stop(when + 0.05);
                b2.start(when); b2.stop(when + 0.05);
                break;
            }
        }
    }

    /* opts: from/to (Hz) add a lowpass that decays from to -> to for a
       plucked-string brightness fall */
    function pluckVoice(type, freq, when, dur, peak, dest, opts) {
        var hold = Math.max(0.12, dur);
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0005, peak), when + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, when + hold);
        if (opts && opts.from) {
            var f = ctx.createBiquadFilter();
            f.type = "lowpass";
            f.Q.value = 0.8;
            f.frequency.setValueAtTime(opts.from, when);
            f.frequency.exponentialRampToValueAtTime(opts.to || 500, when + hold * 0.7);
            g.connect(f);
            f.connect(dest || master);
        } else {
            g.connect(dest || master);
        }
        var o = burst(freq, type, when, g);
        o.start(when);
        o.stop(when + hold + 0.05);
    }

    /* opts: drop (semitones of pitch sag at onset, for punchy bass),
       sweep (cutoff*2^semitones -> cutoff over sweep seconds, filter env) */
    function sustainVoice(type, freq, when, dur, peak, atk, rel, cutoff, vib, dest, opts) {
        dest = dest || master;
        opts = opts || {};
        var hold = Math.max(0.08, dur);
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0005, peak), when + atk);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0005, peak * 0.7), when + Math.max(atk + 0.01, hold));
        g.gain.exponentialRampToValueAtTime(0.0001, when + hold + rel);
        if (cutoff) {
            var f = ctx.createBiquadFilter();
            f.type = "lowpass";
            f.frequency.setValueAtTime(opts.sweep ? Math.min(18000, cutoff * Math.pow(2, opts.sweep / 12)) : cutoff, when);
            if (opts.sweep) f.frequency.exponentialRampToValueAtTime(cutoff, when + (opts.sweep_time || 0.12));
            g.connect(f);
            f.connect(dest);
        } else {
            g.connect(dest);
        }
        var o = burst(freq, type, when, g);
        if (opts.drop) {
            o.frequency.setValueAtTime(freq * Math.pow(2, opts.drop / 12), when);
            o.frequency.exponentialRampToValueAtTime(freq, when + (opts.drop_time || 0.05));
        }
        if (vib) {
            var lfo = ctx.createOscillator();
            lfo.type = "sine";
            lfo.frequency.value = vib.rate || 5.5;
            var lg = ctx.createGain();
            lg.gain.setValueAtTime(0, when);
            lg.gain.linearRampToValueAtTime(vib.depth || 10, when + (vib.delay || 0.25));
            lfo.connect(lg);
            lg.connect(o.detune);
            lfo.start(when);
            lfo.stop(when + hold + rel + 0.05);
        }
        o.start(when);
        o.stop(when + hold + rel + 0.05);
    }

        /* lush analog-style pad: three detuned saws + sub-octave sine through a
       lowpass swell, one shared vibrato LFO that fades in, and a quiet
       FM_PAD layer on top for glassy shimmer. The amp swell is fast and
       two-stage (near-immediate body, gentle push to full level) so pads land
       on the beat; the filter still opens over 0.3s for the classic bloom. */
    function padVoice(freq, when, dur, vel, dest) {
        dest = dest || master;
        var hold = Math.max(0.15, dur);
        var atk = Math.min(0.05, Math.max(0.008, dur * 0.04));
        var rel = 0.7;
        var peak = Math.max(0.0005, vel * 0.5);
        var amp = ctx.createGain();
        amp.gain.setValueAtTime(0.0001, when);
        amp.gain.exponentialRampToValueAtTime(peak * 0.85, when + atk);
        /* after the fast initial swell, ease into full level over a shorter,
           capped tail - keeps the pad character without drifting off-beat */
        amp.gain.exponentialRampToValueAtTime(peak, when + atk + Math.min(0.25, Math.max(0.06, dur * 0.1)));
        amp.gain.setValueAtTime(peak, when + Math.max(atk + 0.01, hold));
        amp.gain.exponentialRampToValueAtTime(0.0001, when + Math.max(atk + 0.01, hold) + rel);
        var f = ctx.createBiquadFilter();
        f.type = "lowpass";
        f.Q.value = 0.7;
        f.frequency.setValueAtTime(Math.min(500, Math.max(120, freq * 1.4)), when);
        f.frequency.exponentialRampToValueAtTime(Math.min(2800, Math.max(600, freq * 4)), when + 0.3);
        amp.connect(f);
        f.connect(dest);
        var lfo = ctx.createOscillator();
        lfo.type = "sine";
        lfo.frequency.value = 4.6;
        var lg = ctx.createGain();
        lg.gain.setValueAtTime(0, when);
        lg.gain.linearRampToValueAtTime(8, when + 0.9);
        lfo.connect(lg);
        lfo.start(when);
        lfo.stop(when + hold + rel + 0.1);
        var dets = [-9, 0, 7];
        var lvls = [0.22, 0.22, 0.19];
        for (var i = 0; i < 3; i++) {
            var o = ctx.createOscillator();
            o.type = "sawtooth";
            o.frequency.setValueAtTime(freq, when);
            o.detune.setValueAtTime(dets[i], when);
            var og = ctx.createGain();
            og.gain.value = lvls[i];
            o.connect(og);
            og.connect(amp);
            lg.connect(o.detune);
            o.start(when);
            o.stop(when + hold + rel + 0.1);
        }
        var sub = ctx.createOscillator();
        sub.type = "sine";
        sub.frequency.setValueAtTime(freq / 2, when);
        var sg = ctx.createGain();
        sg.gain.value = 0.28;
        sub.connect(sg);
        sg.connect(amp);
        sub.start(when);
        sub.stop(when + hold + rel + 0.1);
        fmHit(FM_PAD, freq, when, vel * 0.18, hold, dest);
    }

    function noteHit(kind, midi, when, dur, vel, dest) {
        dest = dest || master;
        var f = midiToFreq(midi);
        var custom = sounds.get(String(kind));
        if (custom) {
            customHit(custom, f, when, vel, Math.max(0.05, dur), dest);
            return;
        }
        /* note samples: every note re-fires the file pitched to it (C4
           reference); it rings its natural length, chords stack copies */
        if (samples.has(String(kind))) { sampleAudio(kind, when, vel, dest, 0, Math.pow(2, ((Number(midi) || 60) - 60) / 12)); return; }
        switch (kind) {
            case "piano": {
                /* layered: fundamental + stretched-string partials with a
                   brightness fall, hammer noise, and a whisper of FM warmth */
                var pd = Math.max(dur, 0.5) + vel * 0.5;
                pluckVoice("triangle", f, when, pd, vel * 0.42, dest, { from: Math.min(16000, f * 8), to: Math.max(400, f * 1.6) });
                pluckVoice("triangle", f * 1.0015, when, pd * 0.9, vel * 0.14, dest);
                pluckVoice("sine", f * 2, when, pd * 0.55, vel * 0.13, dest);
                pluckVoice("sine", f * 3, when, pd * 0.3, vel * 0.05, dest);
                noiseHit(when, vel * 0.05, 0.001, 0.025, "lowpass", 900, 0, dest);
                noiseHit(when, vel * 0.025, 0.0005, 0.006, "highpass", 3000, 0, dest);
                fmHit(FM_EP, f, when, vel * 0.1, Math.max(0.05, dur) * 0.6, dest);
                break;
            }
            case "pluck":
                pluckVoice("triangle", f, when, Math.min(dur, 0.35), vel * 0.42, dest, { from: Math.min(16000, f * 7), to: Math.max(350, f * 1.2) });
                pluckVoice("triangle", f * 1.003, when, Math.min(dur, 0.28), vel * 0.18, dest);
                pluckVoice("sine", f * 2, when, Math.min(dur, 0.12), vel * 0.12, dest);
                break;
            case "bass":
                /* filter-env saw with pitch sag for a punchy attack, clean sub underneath */
                sustainVoice("sawtooth", f, when, dur, vel * 0.45, 0.008, 0.08, Math.min(f * 3.5, 950), null, dest,
                    { drop: 6, drop_time: 0.04, sweep: 26, sweep_time: 0.1 });
                sustainVoice("square", f * 1.004, when, dur, vel * 0.09, 0.01, 0.08, Math.min(f * 2.2, 650), null, dest);
                sustainVoice("sine", Math.max(30, f * 0.5), when, dur, vel * 0.28, 0.015, 0.08, 0, null, dest);
                break;
            case "lead":
                sustainVoice("square", f, when, dur, vel * 0.22, 0.01, 0.06, 3200, { rate: 5.8, depth: 8, delay: 0.25 }, dest);
                sustainVoice("sawtooth", f * 1.005, when, dur, vel * 0.1, 0.01, 0.06, 3200, { rate: 5.8, depth: 8, delay: 0.25 }, dest);
                sustainVoice("sawtooth", f * 0.995, when, dur, vel * 0.08, 0.012, 0.06, 2400, { rate: 5.8, depth: 8, delay: 0.3 }, dest);
                break;
            case "pad":
                padVoice(f, when, dur, vel, dest);
                break;
            case "bells":
                pluckVoice("sine", f, when, Math.max(dur, 1.2), vel * 0.38, dest, { from: 9000, to: 1200 });
                pluckVoice("sine", f * 2.01, when, Math.max(dur, 1.2) * 0.85, vel * 0.09, dest);
                pluckVoice("sine", f * 2.76, when, Math.max(dur, 1.2) * 0.6, vel * 0.13, dest);
                pluckVoice("sine", f * 5.4, when, Math.max(dur, 1.2) * 0.3, vel * 0.06, dest);
                break;
            case "sine":
                sustainVoice("sine", f, when, dur, vel * 0.4, 0.01, 0.12, 0, null, dest);
                break;
            case "square":
                sustainVoice("square", f, when, dur, vel * 0.2, 0.01, 0.1, Math.min(f * 6, 9000), null, dest);
                sustainVoice("square", f * 1.004, when, dur, vel * 0.08, 0.012, 0.1, Math.min(f * 4, 6000), null, dest);
                break;
            case "triangle":
                sustainVoice("triangle", f, when, dur, vel * 0.33, 0.01, 0.12, 0, null, dest);
                sustainVoice("sine", f * 2, when, dur * 0.7, vel * 0.05, 0.02, 0.12, 0, null, dest);
                break;
            case "saw":
                sustainVoice("sawtooth", f, when, dur, vel * 0.22, 0.01, 0.1, Math.min(f * 5, 8000), null, dest);
                sustainVoice("sawtooth", f * 1.006, when, dur, vel * 0.14, 0.014, 0.1, Math.min(f * 3.5, 6000), null, dest);
                break;
            case "organ":
                /* B3 drawbars: key click transient, slight Leslie wobble */
                pluckVoice("sine", f * 3, when, 0.04, vel * 0.1, dest);
                sustainVoice("sine", f, when, dur, vel * 0.26, 0.02, 0.15, 0, { rate: 6.2, depth: 4, delay: 0.1 }, dest);
                sustainVoice("sine", f * 2, when, dur, vel * 0.15, 0.02, 0.15, 0, { rate: 6.2, depth: 4, delay: 0.1 }, dest);
                sustainVoice("sine", f * 3, when, dur, vel * 0.08, 0.02, 0.15, 0, { rate: 6.2, depth: 4, delay: 0.15 }, dest);
                sustainVoice("sine", f * 4, when, dur, vel * 0.05, 0.02, 0.15, 0, { rate: 6.2, depth: 4, delay: 0.15 }, dest);
                sustainVoice("sine", f * 0.5, when, dur, vel * 0.07, 0.03, 0.15, 0, { rate: 6.2, depth: 4, delay: 0.2 }, dest);
                break;
            case "strings":
                sustainVoice("sawtooth", f, when, dur, vel * 0.16, 0.09, 0.35, Math.min(f * 3, 3000), { rate: 5.2, depth: 7, delay: 0.4 }, dest);
                sustainVoice("sawtooth", f * 1.008, when, dur, vel * 0.14, 0.1, 0.35, Math.min(f * 3, 3000), { rate: 5.5, depth: 7, delay: 0.5 }, dest);
                sustainVoice("sawtooth", f * 0.995, when, dur, vel * 0.12, 0.11, 0.35, Math.min(f * 3, 3000), { rate: 4.9, depth: 7, delay: 0.45 }, dest);
                sustainVoice("sawtooth", f * 0.5, when, dur, vel * 0.09, 0.16, 0.35, Math.min(f * 2, 1500), { rate: 4.6, depth: 6, delay: 0.6 }, dest);
                break;
            case "synbrass":
                sustainVoice("sawtooth", f, when, dur, vel * 0.22, 0.03, 0.12, Math.min(f * 8, 4500), { rate: 5, depth: 5, delay: 0.4 }, dest, { sweep: 18, sweep_time: 0.18 });
                sustainVoice("square", f * 1.006, when, dur, vel * 0.1, 0.03, 0.12, Math.min(f * 6, 3500), { rate: 5, depth: 5, delay: 0.4 }, dest);
                break;
            case "flute":
                sustainVoice("sine", f, when, dur, vel * 0.3, 0.06, 0.15, 0, { rate: 5.2, depth: 14, delay: 0.3 }, dest);
                sustainVoice("sine", f * 2, when, dur, vel * 0.05, 0.08, 0.15, 0, { rate: 5.2, depth: 14, delay: 0.35 }, dest);
                noiseHit(when, vel * 0.03, 0.06, Math.max(dur, 0.2), "bandpass", f * 1.4, 0, dest);
                break;
            case "musicbox":
                pluckVoice("sine", f, when, Math.max(dur, 0.8), vel * 0.38, dest);
                pluckVoice("sine", f * 5.4, when, Math.max(dur, 0.8) * 0.35, vel * 0.1, dest);
                pluckVoice("sine", f * 8.93, when, Math.max(dur, 0.8) * 0.2, vel * 0.04, dest);
                break;
            case "fm":
                fmHit(FM_EP, f, when, vel, Math.max(0.05, dur), dest);
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
            var layers = host.querySelectorAll(".msq-viz");
            if (layers.length) {
                vizEl = layers[layers.length - 1];
                for (var i = 0; i < layers.length - 1; i++) {
                    if (layers[i] !== vizEl && layers[i].parentElement === host) host.removeChild(layers[i]);
                }
            } else {
                vizEl = document.createElement("div");
                vizEl.className = "msq-viz";
                host.appendChild(vizEl);
            }
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
        fm: "#7209b7",
        /* drum voices */
        kick: "#ff4d6d",
        snare: "#f4a261",
        clap: "#ffd166",
        hihat_closed: "#caf0f8",
        hihat_open: "#90e0ef",
        tom: "#b08968",
        rim: "#ede0d4",
        cowbell: "#ffe066",
        /* custom sounds palette (trance set) */
        trancepad: "#2ee6c8",
        wtlead: "#ff5da2",
        supersaw: "#ff9e40",
        acid: "#c6ff3f",
        chime: "#bfefff",
        riser: "#c77dff"
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

    var SHADER_DOM_FALLBACK = {
        ripple: "bloom",
        wave: "drip",
        plasma: "bloom",
        aurora: "bloom",
        prism: "laser",
        strobe: "flash",
        spiral: "bloom",
        pulse: "flash"
    };

    function fireViz(effect, midi, color, dur, vel, source, voice) {
        if (!effect) return;
        try {
            if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        } catch (e) {}
        var cell = midi != null ? pitchToCell(midi) : null;
        if (window.MusicSequencerShaderFx && window.MusicSequencerShaderFx.trigger(effect, cell, color, dur, vel, source, voice, midi)) return;

        var fallback = SHADER_DOM_FALLBACK[effect] || effect;
        if (fallback === "spark") { spawnPulse("msq-spark-dot", cell ? cell.x : 50, cell ? cell.y : 62, color); return; }
        if (fallback === "drip") {
            /* same 4-octave absolute-pitch spread as the shader (C2 left .. C6 right) */
            var dx = midi != null && isFinite(Number(midi))
                ? 4 + 92 * Math.max(0, Math.min(48, Math.round(Number(midi)) - 36)) / 48
                : (cell ? cell.x : 50);
            spawnPulse("msq-drip-bar", dx, 0, color);
            return;
        }
        if (fallback === "laser") { fireLaser(cell, color); return; }
        if (fallback === "flash") { spawnPulse("msq-flash-full", null, null, color); return; }
        if (fallback === "bloom") {
            /* DOM fallback only: WebGL is unavailable. Two-part stage flare on
               the note's grid cell, lifetime synced to the sounding note. */
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
        var fx = window.MusicSequencerShaderFx;
        if (fx && ambientDirty) syncAmbientDefs();
        if (ctx && sampleQueue.length) {
            var keepS = [];
            for (var qi = 0; qi < sampleQueue.length; qi++) {
                var q = sampleQueue[qi];
                if (q.ent.failed) continue;
                if (!q.ent.buffer) {
                    loadSampleBuffer(q.ent);
                    if (!q.ent.buffer) { keepS.push(q); continue; }
                }
                fireSample(q.ent.buffer, Math.max(q.t, ctx.currentTime), q.vel, q.dest, q.pan, q.rate);
            }
            sampleQueue = keepS;
        }
        if (ctx && vizQueue.length) {
            var now = ctx.currentTime - VIZ_LEAD;
            var keep = [];
            for (var i = 0; i < vizQueue.length; i++) {
                var e = vizQueue[i];
                if (e.t > now) { keep.push(e); continue; }
                if (now - e.t > 0.25) continue;
                fireViz(e.effect, e.midi, e.color, e.dur, e.vel, e.src, e.voice);
            }
            vizQueue = keep;
        }
        if (fx) {
            if (sentTempo !== bpm) {
                if (fx.setTempo) fx.setTempo(bpm);
                sentTempo = bpm;
            }
            sendAmbientAudio();
            fx.render();
        }
    }
    requestAnimationFrame(pumpViz);

    /* one occurrence spans bar_length meter bars; authored cells map onto it
       at (stepsPerBar / authored) global steps per cell, so a 12-cell triplet
       loop fills the same 4/4 bar as a 16-cell straight one. commits are
       windowed [from, to) in global steps relative to the occurrence start,
       so a slice of an occurrence can be scheduled without committing the
       whole thing (song gating relies on this to stop layers near-exactly).
       past window times are fine: hits whose instant already passed fire
       immediately, later ones keep their exact absolute offset. */
    function scheduleOccurrence(loop, from, to) {
        var d = loop.def;
        if (!d) return;
        var ratio = stepsPerBar / (d.steps_per_bar || 16);
        /* t0 and cell length are frozen at the occurrence start (loop.occT0 /
           loop.occCell), so chunks committed across a tempo change still land
           on one consistent map for that occurrence */
        var cellSpan = ratio * loop.occCell;
        var t0 = loop.occT0;
        if (d.kind === "drum") {
            var cue = visualCues.get(String(d.voice));
            var voiceOut = loop.chain ? loop.chain.input : audioOut(d.voice);
            var steps = d.steps || [];
            for (var i = 0; i < steps.length; i++) {
                var off = i * ratio;
                if (steps[i] > 0 && off >= from && off < to) {
                    var when = t0 + i * cellSpan;
                    drumHit(d.voice, when, steps[i] * loop.volume, voiceOut);
                    if (cue) vizQueue.push({ loop: loop, t: when, effect: cue, voice: d.voice, midi: null, color: colorFor(d.voice), vel: steps[i], src: d.id ? String(d.id) : null });
                    if (d.voice === "kick" && window.MusicSequencerShaderFx) window.MusicSequencerShaderFx.wheelKick(when);
                }
            }
        } else if (d.kind === "note") {
            var cueN = visualCues.get(String(d.instrument));
            var noteColor = colorFor(d.instrument);
            var noteOut = loop.chain ? loop.chain.input : audioOut(d.instrument);
            var notes = d.notes || [];
            for (var j = 0; j < notes.length; j++) {
                var n = notes[j];
                var offN = n.start * ratio;
                if (offN >= from && offN < to) {
                    var whenN = t0 + n.start * cellSpan;
                    var durN = Math.max(0.05, n.length * cellSpan);
                    noteHit(d.instrument, n.pitch, whenN, durN, n.velocity * loop.volume, noteOut);
                    if (cueN) vizQueue.push({ loop: loop, t: whenN, effect: cueN, voice: d.instrument, midi: n.pitch, color: noteColor, dur: durN, vel: n.velocity, src: d.id ? String(d.id) : null });
                }
            }
        } else if (d.kind === "arp") {
            var cueA = visualCues.get(String(d.instrument));
            var arpColor = colorFor(d.instrument);
            var arpOut = loop.chain ? loop.chain.input : audioOut(d.instrument);
            var seq = d.seq || [];
            if (seq.length) {
                var gridA = (d.bar_length || 1) * (d.steps_per_bar || 16);
                var stepA = Math.max(0.25, Number(d.step) || 1);
                var gateA = d.gate == null ? 0.5 : d.gate;
                var velA = d.velocity == null ? 0.8 : d.velocity;
                var cntA = Math.floor(gridA / stepA + 0.001);
                for (var q = 0; q < cntA; q++) {
                    var offA = (q * stepA + (d.offset || 0)) % gridA;
                    if (offA >= from && offA < to) {
                        var whenA = t0 + offA * cellSpan;
                        var durA = Math.max(0.04, stepA * gateA * cellSpan);
                        var midiA = seq[q % seq.length];
                        noteHit(d.instrument, midiA, whenA, durA, velA * loop.volume, arpOut);
                        if (cueA) vizQueue.push({ loop: loop, t: whenA, effect: cueA, voice: d.instrument, midi: midiA, color: arpColor, dur: durA, vel: velA, src: d.id ? String(d.id) : null });
                    }
                }
            }
        }
    }

    /* song mode: boundaries are applied the moment the scheduler's commit
       horizon REACHES them - the scheduler only commits LOOKAHEAD ahead, so
       at apply time nothing past the boundary is committed yet: stopped
       layers are capped exactly there, and new layers start their first
       occurrence on the boundary step. (The old bug: the whole occurrence was
       committed at once and the gate fired on wall-clock "now", so whatever
       the lookahead held leaked across section lines by up to a loop span.) */
    function applyBoundary(step, sec) {
        if (!sec) {
            /* end boundary: cap every layer, let tails ring out to the line */
            loops.forEach(function (e, id) {
                if (e.playing) e.stopAt = Math.min(e.stopAt == null ? Infinity : e.stopAt, step);
            });
            song = null;
            return;
        }
        var wanted = {};
        (sec.layers || []).forEach(function (l) { wanted[String(l.name)] = { volume: l.volume == null ? 1 : l.volume, pan: l.pan }; });
        loops.forEach(function (e, id) {
            if (wanted[id] != null) {
                e.volume = clamp01(wanted[id].volume);
                /* section pan overrides the loop's own; absent means fall back */
                e.panOv = wanted[id].pan == null ? null : Math.max(-1, Math.min(1, Number(wanted[id].pan)));
                if (e.chain && e.chain.pan) {
                    var pv = e.panOv == null ? Number((e.def && e.def.pan) || 0) : e.panOv;
                    try { e.chain.pan.pan.linearRampToValueAtTime(pv, ctx.currentTime + 0.08); } catch (x) {}
                }
                if (!e.playing) {
                    e.playing = true;
                    e.nextStep = step;
                    e.sched = -1;
                }
                e.stopAt = Infinity;
            } else if (e.playing && (e.stopAt == null || e.stopAt > step)) {
                e.stopAt = step;
            }
        });
    }
    function gateSong() {
        if (!song || !audioReady()) return;
        if (song.startStep < 0) {
            song.startStep = nextBarStart();
            song.bIdx = 0;
            song.bStep = song.startStep;
            song.pass = 0;
            song.fired = [];
        }
        var horizon = absStep(ctx.currentTime + LOOKAHEAD);
        while (song && horizon >= song.bStep) {
            var n = song.def.sections.length;
            var sec = song.bIdx < n ? song.def.sections[song.bIdx] : null;
            var step = song.bStep;
            var bars = sec ? sec.bars : 0;
            applyBoundary(step, sec);
            if (song) {
                /* wrapping back to the first section starts a new pass: song
                   sample events fire once per pass, so arm them again */
                if (sec && song.bIdx === n - 1 && song.def.loop) { song.pass = (song.pass || 0) + 1; song.fired = []; }
                song.bIdx = song.bIdx + 1 >= n && song.def.loop ? 0 : song.bIdx + 1;
                if (song.bIdx >= n) song.bStep = song.startStep + (song.def.total_bars || 1) * stepsPerBar;
                else song.bStep = step + bars * stepsPerBar;
            }
        }
    }

    setInterval(function () {
        if (!audioReady()) return;
        var nowStep = absStep(ctx.currentTime);
        var horizonStep = absStep(ctx.currentTime + LOOKAHEAD);
        gateSong();
        /* song sample events: one-shots anchored at
           startStep + pass * total_bars + at, so a looping song re-fires them
           every cycle (gateSong re-arms `fired` on the wrap) */
        if (song && song.startStep >= 0 && song.def && song.def.events && song.def.events.length) {
            if (!song.fired) song.fired = [];
            var evBase = song.startStep + (song.pass || 0) * (song.def.total_bars || 0) * stepsPerBar;
            for (var ei = 0; ei < song.def.events.length; ei++) {
                if (song.fired[ei]) continue;
                var ev = song.def.events[ei];
                var estep = evBase + (Number(ev.at) || 0) * stepsPerBar;
                /* resuming a half-played song starts it from the top: events
                   already behind the playhead are consumed, not machine-gunned */
                if (estep < nowStep - 0.05) { song.fired[ei] = true; continue; }
                if (estep <= horizonStep) {
                    song.fired[ei] = true;
                    sampleAudio(ev.sample, stepTime(estep), ev.volume == null ? 1 : ev.volume, master, ev.pan || 0);
                }
            }
        }
        loops.forEach(function (loop, id) {
            if (!loop.playing || loop.nextStep < 0 || !loop.def) return;
            var span = (loop.def.bar_length || 1) * stepsPerBar;
            /* (re)open an occurrence: freeze its audio-clock map so chunks
               stay consistent even if tempo changes while it plays */
            if (!(loop.sched >= loop.nextStep)) {
                loop.sched = loop.nextStep;
                loop.occT0 = stepTime(loop.nextStep);
                loop.occCell = sps();
            }
            var stopAt = loop.stopAt == null ? Infinity : loop.stopAt;
            if (stopAt <= loop.sched) {
                vizQueue = vizQueue.filter(function (v) { return v.loop !== loop; });
                stop(id);
                return;
            }
            var occEnd = loop.nextStep + span;
            if (occEnd <= nowStep && stopAt === Infinity) {
                /* clock stalled (throttled tab, huge jump): drop the
                   remainder, resume the loop exactly on its own phase */
                while (loop.nextStep + span <= nowStep) loop.nextStep += span;
                loop.sched = -1;
                return;
            }
            /* commit only within lookahead: a stopAt capping this chunk
               therefore falls silent at the exact boundary step */
            var to = Math.min(horizonStep, occEnd, stopAt);
            if (loop.sched < to) {
                /* one bad definition must not stall every other loop */
                try {
                    ensureChain(loop);
                    scheduleOccurrence(loop, loop.sched - loop.nextStep, to - loop.nextStep);
                    scheduleDucks(loop, loop.sched - loop.nextStep, to - loop.nextStep);
                }
                catch (e) {
                    if (!loop.errored) {
                        loop.errored = true;
                        console.error("[music_sequencer] loop '" + id + "' stopped: a voice threw while being scheduled", e);
                    }
                    loop.playing = false; return;
                }
                loop.sched = to;
            }
            if (loop.sched >= occEnd) {
                /* occurrence fully committed: hop to the next one and let the
                   next tick re-open it (fresh frozen clock map for its chunks) */
                loop.nextStep = occEnd;
                loop.sched = -1;
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
        if (existing) destroyChain(existing);
        def.id = id;
        loops.set(id, {
            def: def,
            volume: clamp01(def.volume == null ? 1 : def.volume),
            playing: true,
            nextStep: nextSongStart()
        });
        return id;
    }

    function stop(id) {
        id = String(id);
        var e = loops.get(id);
        if (!e) return false;
        e.playing = false;
        e.nextStep = -1;
        e.sched = -1;
        e.stopAt = Infinity;
        vizQueue = vizQueue.filter(function (v) { return v.loop !== e; });
        if (window.MusicSequencerShaderFx) window.MusicSequencerShaderFx.remove(id);
        return true;
    }

    function start(id) {
        var e = loops.get(String(id));
        if (!e) return false;
        if (e.playing) return true;
        if (countPlaying() >= MAX_LAYERS) return false;
        e.playing = true;
        e.nextStep = nextSongStart();
        e.sched = -1;
        e.stopAt = Infinity;
        return true;
    }

    function stopAll() {
        loops.forEach(function (e) { e.playing = false; e.nextStep = -1; e.sched = -1; e.stopAt = Infinity; });
        vizQueue = [];
        sampleQueue = [];
        if (window.MusicSequencerShaderFx) window.MusicSequencerShaderFx.clear();
    }

    /* hard cut for chat switches: already-scheduled notes (long pads can ring
       for seconds) keep playing after stopAll, so swap the master bus instead
       - the old one and everything feeding it falls silent instantly, and a
       fresh master hangs on the same chain for what plays next. the reverb
       tail is cut too, then the send re-hangs a frame later. */
    function panicAudio() {
        stopAll();
        if (!ctx || !master || !fxIn) return;
        try { master.disconnect(); } catch (e) {}
        if (verbNode) { try { verbNode.disconnect(); } catch (e) {} }
        var gen = ++localSeq;
        master = ctx.createGain();
        master.gain.value = masterVolume / 100;
        try {
            master.connect(fxIn);
            if (verbSend) master.connect(verbSend);
        } catch (e) {}
        instrumentBuses.forEach(function (ent) {
            try { ent.gain.disconnect(); } catch (e) {}
            try {
                ent.gain.connect(master);
                ent.gain.connect(ent.analyser);
            } catch (e) {}
        });
        /* loop chains hang on the duck tail: re-attach so they reach the
           fresh master instead of the muted old one */
        loops.forEach(function (e) {
            if (!e.chain) return;
            try { e.chain.duck.disconnect(); e.chain.duck.connect(master); } catch (x) {}
        });
        if (verbNode && compNode) {
            setTimeout(function () {
                if (gen !== localSeq) return;
                try { verbNode.connect(compNode); } catch (e) {}
            }, 60);
        }
    }
    /* leaving the tab must not leave a full generative set running unseen:
       panic and reload this chat's state so returning picks the loops back
       up at the bar (the backend never learns anything stopped) */
    document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") {
            if (audioReady() && countPlaying()) loadChat(selectedChat());
        } else if (selectedChat()) {
            loadChat(selectedChat());
        }
    });

    function setTempo(newBpm) {
        var v = Number(newBpm);
        if (isNaN(v) || v < 20 || v > 300) return false;
        if (audioReady()) {
            var pos = absStep(ctx.currentTime);
            bpm = v;
            anchorT = ctx.currentTime;
            anchorS = pos;
            /* tempo-synced delay taps follow the new grid */
            loops.forEach(function (e) {
                if (!e.chain) return;
                (e.chain.synced || []).forEach(function (s) {
                    try { s.node.delayTime.setValueAtTime(Math.min(2, s.beats * 60 / v), ctx.currentTime); } catch (x) {}
                });
            });
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

    /* transport bar width for loop-start quantization only; already-scheduled
       loops repeat on their own authored steps_per_bar and never shift */
    function setMeter(steps) {
        var v = Math.round(Number(steps));
        if (isNaN(v) || v < 1 || v > 128) return false;
        stepsPerBar = v;
        return true;
    }

    window.MusicSequencer = {
        play: play,
        stop: stop,
        start: start,
        remove: function (id) {
            id = String(id);
            var e = loops.get(id);
            if (e) {
                vizQueue = vizQueue.filter(function (v) { return v.loop !== e; });
                destroyChain(e);
            }
            loops.delete(id);
            if (window.MusicSequencerShaderFx) window.MusicSequencerShaderFx.remove(id);
        },
        stopAll: stopAll,
        panic: function () { song = null; panicAudio(); },
        testVisual: function (effect) { fireViz(String(effect || "flash"), null, null, 0.65, 1); },
        shaderDiag: function () {
            return window.MusicSequencerShaderFx
                ? window.MusicSequencerShaderFx.diag()
                : { ready: false, supported: false, enabled: false, activeEvents: 0, error: "shader asset not loaded" };
        },
        setShaderEnabled: function (on) {
            return window.MusicSequencerShaderFx ? window.MusicSequencerShaderFx.setEnabled(on) : false;
        },
        setShaderFogEnabled: function (on) {
            return window.MusicSequencerShaderFx ? window.MusicSequencerShaderFx.setFogEnabled(on) : false;
        },
        setShaderFogIntensity: function (value) {
            return window.MusicSequencerShaderFx ? window.MusicSequencerShaderFx.setFogIntensity(value) : 0;
        },
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
            ambientDirty = true;
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
        listSamples: function () {
            var out = [];
            samples.forEach(function (ent, name) {
                out.push({ name: name, kind: ent.kind || null, url: ent.url, ready: !!ent.buffer, failed: !!ent.failed });
            });
            return out;
        },
        getAudioTime: function () {
            if (ctx && ctx.state === "running") return ctx.currentTime;
            return window.performance ? performance.now() / 1000 : Date.now() / 1000;
        },
        setTempo: setTempo,
        getTempo: function () { return bpm; },
        setMeter: setMeter,
        getMeter: function () { return stepsPerBar; },
        setMasterVolume: setMasterVolume,
        list: function () {
            var out = [];
            loops.forEach(function (e, id) {
                out.push({
                    id: id,
                    kind: e.def ? e.def.kind : null,
                    voice_or_instrument: e.def ? (e.def.voice || e.def.instrument) : null,
                    bar_length: e.def ? e.def.bar_length : null,
                    steps_per_bar: e.def ? (e.def.steps_per_bar || 16) : null,
                    pan: e.def ? (e.def.pan || 0) : null,
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

    function seedDefaultVisuals() {
        if (!visualCues.has("kick")) visualCues.set("kick", "flash");
        if (!visualCues.has("snare")) visualCues.set("snare", "ripple");
        ambientDirty = true;
    }

    function loadChat(chatId) {
        curChat = chatId;
        /* hard cut the old chat: kill scheduled notes too, not just future
           gating, so a long pad from chat A can't ring over chat B */
        song = null;
        panicAudio();
        loops.clear();
        sounds.clear();
        samples.clear();
        sampleQueue = [];
        visualCues.clear();
        vizQueue = [];
        ambientDefs = [];
        ambientDirty = true;
        if (window.MusicSequencerShaderFx) {
            if (window.MusicSequencerShaderFx.clearAmbient) window.MusicSequencerShaderFx.clearAmbient();
            window.MusicSequencerShaderFx.clear();
        }
        if (typeof simpleApiFetch !== "function") {
            setTimeout(function () { loadChat(chatId); }, 300);
            return;
        }
        if (!chatId) {
            seedDefaultVisuals();
            return;
        }
        simpleApiFetch("/api/ext/music_sequencer/state?chat=" + encodeURIComponent(chatId))
            .then(function (d) {
                if (!d || String(curChat) !== String(chatId)) return;
                setMasterVolume(d.master_volume);
                if (d.tempo) setTempo(d.tempo);
                if (d.meter) setMeter(d.meter);
                var sd = d.sounds || {};
                Object.keys(sd).forEach(function (sn) { sounds.set(sn, sd[sn]); });
                var smp = d.samples || {};
                Object.keys(smp).forEach(function (sn) {
                    samples.set(sn, smp[sn]);
                    if (ctx) loadSampleBuffer(smp[sn]);
                });
                var vc = d.visuals || {};
                Object.keys(vc).forEach(function (vn) {
                    var vfx = String(vc[vn] || "").toLowerCase();
                    var vname = String(vn || "").toLowerCase();
                    if (vname === "all") vname = "master";
                    visualCues.set(vname, vfx);
                });
                seedDefaultVisuals();
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
                /* a song that was playing resumes its arrangement from the top */
                if (d.song && d.song.playing) song = { def: d.song, startStep: -1, curSection: null };
            })
            .catch(function () {
                if (String(curChat) === String(chatId)) seedDefaultVisuals();
            });
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
        else if (t === "music_sequencer:define") {
            /* stored pattern: kept known (for song gating and the layer list)
               without playing; a later play/start of the same id replaces it */
            var dd = data.loop || {};
            if (dd.id && !loops.has(String(dd.id))) {
                loops.set(String(dd.id), { def: dd, volume: clamp01(dd.volume == null ? 1 : dd.volume), playing: false, nextStep: -1 });
            } else if (dd.id) {
                var ex = loops.get(String(dd.id));
                if (!ex.playing) {
                    destroyChain(ex);
                    ex.def = dd;
                    ex.volume = clamp01(dd.volume == null ? 1 : dd.volume);
                }
            }
        }
        else if (t === "music_sequencer:stop") stop(data.id);
        else if (t === "music_sequencer:stop_all") panicAudio();
        else if (t === "music_sequencer:tempo") setTempo(data.bpm);
        else if (t === "music_sequencer:meter") setMeter(data.steps);
        else if (t === "music_sequencer:visual_clear") {
            visualCues.clear();
            seedDefaultVisuals();
            if (window.MusicSequencerShaderFx && window.MusicSequencerShaderFx.clearAmbient) {
                window.MusicSequencerShaderFx.clearAmbient();
            }
            ambientDirty = true;
        }
        else if (t === "music_sequencer:sound") {
            if (data.spec) sounds.set(String(data.name), data.spec);
            else sounds.delete(String(data.name));
        }
        else if (t === "music_sequencer:samples") {
            /* live folder refresh (list_samples): swap in the new map and
               prefetch what we can, dropping hits parked for old files */
            samples.clear();
            sampleQueue = [];
            var sm = data.samples || {};
            Object.keys(sm).forEach(function (sn) {
                samples.set(sn, sm[sn]);
                if (ctx) loadSampleBuffer(sm[sn]);
            });
        }
        else if (t === "music_sequencer:visual") {
            var sfx = data.effect ? String(data.effect) : null;
            var sv = String(data.sound || "");
            if (sfx && sv === "all") sv = "master";
            if (sfx) visualCues.set(sv, sfx);
            else visualCues.delete(sv);
            ambientDirty = true;
        }
        else if (t === "music_sequencer:song") {
            panicAudio();
            song = { def: data.song || {}, startStep: -1, curSection: null };
        }
        else if (t === "music_sequencer:stop_song") {
            panicAudio();
            song = null;
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

    seedDefaultVisuals();

    hookWs();
    boot(30);
    if (window.MusicSequencerShaderFx) window.MusicSequencerShaderFx.ensure();
})();

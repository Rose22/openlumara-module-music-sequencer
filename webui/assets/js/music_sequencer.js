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
                fxIn = shaper;
                compNode = comp;
                try {
                    var verb = ctx.createConvolver();
                    verb.buffer = makeIR(1.6, 3.2);
                    var vhp = ctx.createBiquadFilter();
                    vhp.type = "highpass";
                    vhp.frequency.value = 220;
                    var send = ctx.createGain();
                    send.gain.value = 0.22;
                    master.connect(vhp);
                    vhp.connect(send);
                    send.connect(verb);
                    verb.connect(comp);
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

    function noiseHit(when, peak, attack, decay, filterType, freq, q) {
        var g = env(when, peak, attack, decay);
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
    function clickHit(when, peak) {
        noiseHit(when, peak, 0.0005, 0.01, "highpass", 2600);
    }

    /* TR-808-style metallic hat: six detuned square oscillators at inharmonic
       ratios, highpassed - far more "metal" than plain filtered noise */
    function metalHat(when, peak, decay, hpFreq) {
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, when);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0005, peak), when + 0.001);
        g.gain.exponentialRampToValueAtTime(0.0001, when + 0.001 + decay);
        var f = ctx.createBiquadFilter();
        f.type = "highpass";
        f.frequency.setValueAtTime(hpFreq, when);
        f.Q.value = 1.4;
        g.connect(f);
        f.connect(master);
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
    function fmHit(patch, freq, when, vel, gate) {
        var raw = (patch && patch.operators) || [];
        var out = (patch && patch.output) || [];
        var n = Math.min(raw.length, 6);
        if (!n || !out.length) return;
        vel = clamp01(vel == null ? 1 : vel);

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
            if (isCarrier[i]) g.connect(master);
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
    function dftWave(key, fn) {
        var w = waveCache.get(key);
        if (w) return w;
        var N = 512, H = 48;
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
        w = ctx.createPeriodicWave(re, im);
        waveCache.set(key, w);
        return w;
    }
    function n01(v, d, lo, hi) { v = Number(v); if (isNaN(v)) v = d; return Math.max(lo, Math.min(hi, v)); }

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
    function pdVoice(pd, freq, when, stopAt, bus) {
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
        oA.start(when);
        oA.stop(when + stopAt + 0.02);
        if (Math.abs(sA - sB) > 0.001) {
            gA.gain.linearRampToValueAtTime(0, when + ct);
            var oB = ctx.createOscillator();
            oB.setPeriodicWave(pdWave(sB));
            oB.frequency.setValueAtTime(freq, when);
            var gB = ctx.createGain();
            gB.gain.setValueAtTime(0, when);
            gB.gain.linearRampToValueAtTime(1, when + ct);
            oB.connect(gB);
            gB.connect(bus);
            oB.start(when);
            oB.stop(when + stopAt + 0.02);
        }
    }

    /* wavetable: procedurally generated additive tables (harmonics = saw
       forming, even = reedy, sparse = prime partials, bellish) swept by
       crossfading cached waves at position steps */
    var WT_PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47];
    function wtWave(table, p) {
        var lim = 2 + p * 45;
        return dftWave("wt" + table + Math.round(p * 40), function (t) {
            var v = 0;
            for (var k = 1; k < 48 && k <= lim; k++) {
                var a = 0;
                if (table === "even") { if (k % 2 === 0) a = 1 / k; }
                else if (table === "sparse") { if (WT_PRIMES.indexOf(k) !== -1) a = 1 / Math.sqrt(k); }
                else a = Math.pow(1 / k, 0.75);
                if (a) v += a * Math.sin(2 * Math.PI * k * t);
            }
            return v;
        });
    }
    function wtVoice(wt, freq, when, stopAt, bus) {
        var table = String(wt.table || "harmonics");
        var p0 = n01(wt.pos_start, 0.05, 0, 1);
        var p1 = n01(wt.pos_end, 0.9, 0, 1);
        var steps = Math.round(n01(wt.steps, 8, 1, 24));
        if (p1 === p0) steps = 1;
        var sweep = n01(wt.pos_time, 0.4, 0.01, 4);
        var dt = sweep / steps;
        var fade = Math.min(0.04, dt * 0.8);
        for (var i = 0; i < steps; i++) {
            var p = steps === 1 ? p1 : p0 + (p1 - p0) * i / (steps - 1);
            var t0 = when + i * dt;
            var o = ctx.createOscillator();
            o.setPeriodicWave(wtWave(table, p));
            o.frequency.setValueAtTime(freq, when);
            var g = ctx.createGain();
            if (i === 0) g.gain.setValueAtTime(1, when);
            else { g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(1, t0 + fade); }
            if (i < steps - 1) {
                g.gain.setValueAtTime(1, t0 + dt);
                g.gain.linearRampToValueAtTime(0, t0 + dt + fade);
                o.stop(t0 + dt + fade + 0.02);
            } else {
                o.stop(when + stopAt + 0.02);
            }
            o.connect(g);
            g.connect(bus);
            o.start(t0);
        }
    }

    /* chip (NES 2A03 flavour): pulse wave at a set duty, optional duty sweep
       and authentic rate-stepped arpeggio */
    function chipWave(d) {
        return dftWave("chip" + Math.round(d * 40), function (p) { return p < d ? 1 : -1; });
    }
    function chipVoice(chip, freq, when, stopAt, bus) {
        var dA = n01(chip.duty, 0.5, 0.03, 0.5);
        var dB = chip.duty_end == null ? dA : n01(chip.duty_end, dA, 0.03, 0.5);
        var oscs = [ctx.createOscillator()];
        oscs[0].setPeriodicWave(chipWave(dA));
        oscs[0].frequency.setValueAtTime(freq, when);
        var gA = ctx.createGain();
        gA.gain.setValueAtTime(1, when);
        oscs[0].connect(gA);
        gA.connect(bus);
        oscs[0].start(when);
        oscs[0].stop(when + stopAt + 0.02);
        if (Math.abs(dA - dB) > 0.001) {
            var sw = n01(chip.duty_time, 0.15, 0.01, 4);
            gA.gain.linearRampToValueAtTime(0, when + sw);
            var oB = ctx.createOscillator();
            oB.setPeriodicWave(chipWave(dB));
            oB.frequency.setValueAtTime(freq, when);
            var gB = ctx.createGain();
            gB.gain.setValueAtTime(0, when);
            gB.gain.linearRampToValueAtTime(1, when + sw);
            oB.connect(gB);
            gB.connect(bus);
            oscs.push(oB);
            oB.start(when);
            oB.stop(when + stopAt + 0.02);
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
            f.connect(sink);
            bus = f;
        }

        if (def.pd) pdVoice(def.pd, freq, when, stopAt, bus);
        if (def.wt) wtVoice(def.wt, freq, when, stopAt, bus);
        if (def.chip) chipVoice(def.chip, freq, when, stopAt, bus);
        if (def.grain) grainVoice(def.grain, freq, when, vel, gate, bus);
        var layers = def.osc || [];
        if (!layers.length && def.ring && !def.fm && !def.pd && !def.wt && !def.chip && !def.grain) {
            layers = [{ type: "sine", level: 1 }];
        }
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

    function drumHit(name, when, vel) {
        var custom = sounds.get(String(name));
        if (custom) {
            customHit(custom, midiToFreq(custom.base_note || 36), when, vel, null);
            return;
        }
        var o;
        switch (name) {
            case "kick": {
                clickHit(when, vel * 0.4);
                var g = env(when, vel * 0.9, 0.003, 0.4);
                o = burst(170, "sine", when, g);
                o.frequency.exponentialRampToValueAtTime(45, when + 0.09);
                o.frequency.exponentialRampToValueAtTime(38, when + 0.4);
                o.start(when); o.stop(when + 0.45);
                break;
            }
            case "snare": {
                noiseHit(when, vel * 0.5, 0.002, 0.18, "highpass", 1800);
                noiseHit(when, vel * 0.3, 0.001, 0.05, "bandpass", 3400, 0.9);
                var g2 = env(when, vel * 0.42, 0.002, 0.09);
                o = burst(190, "triangle", when, g2);
                o.frequency.exponentialRampToValueAtTime(165, when + 0.09);
                o.start(when); o.stop(when + 0.12);
                var g3 = env(when, vel * 0.16, 0.002, 0.06);
                var o3 = burst(335, "triangle", when, g3);
                o3.start(when); o3.stop(when + 0.09);
                break;
            }
            case "clap": {
                noiseHit(when, vel * 0.28, 0.001, 0.02, "bandpass", 1100, 1.2);
                noiseHit(when + 0.011, vel * 0.28, 0.001, 0.02, "bandpass", 1150, 1.2);
                noiseHit(when + 0.022, vel * 0.36, 0.001, 0.025, "bandpass", 1200, 1.2);
                noiseHit(when + 0.034, vel * 0.45, 0.002, 0.16, "bandpass", 1250, 1.5);
                break;
            }
            case "hihat_closed":
                metalHat(when, vel * 0.28, 0.055, 9000);
                break;
            case "hihat_open":
                metalHat(when, vel * 0.24, 0.42, 8000);
                break;
            case "tom": {
                noiseHit(when, vel * 0.1, 0.002, 0.02, "lowpass", 900);
                var gt = env(when, vel * 0.7, 0.003, 0.3);
                o = burst(210, "sine", when, gt);
                o.frequency.exponentialRampToValueAtTime(92, when + 0.22);
                o.start(when); o.stop(when + 0.35);
                var go = env(when, vel * 0.12, 0.003, 0.16);
                var o2 = burst(420, "sine", when, go);
                o2.frequency.exponentialRampToValueAtTime(185, when + 0.14);
                o2.start(when); o2.stop(when + 0.22);
                break;
            }
            case "rim": {
                var gr = envFiltered(when, vel * 0.5, 0.001, 0.03, 1700);
                o = burst(1700, "square", when, gr);
                o.start(when); o.stop(when + 0.05);
                noiseHit(when, vel * 0.12, 0.001, 0.015, "highpass", 2200);
                break;
            }
            case "cowbell": {
                var gc = envFiltered(when, vel * 0.35, 0.001, 0.3, 2600);
                var a = burst(540, "square", when, gc);
                var b = burst(800, "square", when, gc);
                a.start(when); a.stop(when + 0.35);
                b.start(when); b.stop(when + 0.35);
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

    function sustainVoice(type, freq, when, dur, peak, atk, rel, cutoff, vib) {
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
    function padVoice(freq, when, dur, vel) {
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
        f.connect(master);
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
        fmHit(FM_PAD, freq, when, vel * 0.18, hold);
    }

    function noteHit(kind, midi, when, dur, vel) {
        var f = midiToFreq(midi);
        var custom = sounds.get(String(kind));
        if (custom) {
            customHit(custom, f, when, vel, Math.max(0.05, dur));
            return;
        }
        switch (kind) {
            case "piano": {
                var pd = Math.max(dur, 0.5) + vel * 0.5;
                pluckVoice("triangle", f, when, pd, vel * 0.45);
                pluckVoice("sine", f * 2, when, pd * 0.55, vel * 0.14);
                pluckVoice("sine", f * 3, when, pd * 0.3, vel * 0.05);
                noiseHit(when, vel * 0.05, 0.001, 0.025, "lowpass", 900);
                break;
            }
            case "pluck":
                pluckVoice("triangle", f, when, Math.min(dur, 0.35), vel * 0.42);
                pluckVoice("triangle", f * 1.003, when, Math.min(dur, 0.28), vel * 0.18);
                pluckVoice("sine", f * 2, when, Math.min(dur, 0.12), vel * 0.12);
                break;
            case "bass":
                sustainVoice("sawtooth", f, when, dur, vel * 0.45, 0.008, 0.08, Math.min(f * 3.5, 950));
                sustainVoice("sine", Math.max(30, f * 0.5), when, dur, vel * 0.25, 0.015, 0.08, 0);
                break;
            case "lead":
                sustainVoice("square", f, when, dur, vel * 0.24, 0.01, 0.06, 3200, { rate: 5.8, depth: 8, delay: 0.25 });
                sustainVoice("sawtooth", f * 1.005, when, dur, vel * 0.1, 0.01, 0.06, 3200, { rate: 5.8, depth: 8, delay: 0.25 });
                break;
            case "pad":
                padVoice(f, when, dur, vel);
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
                sustainVoice("sawtooth", f, when, dur, vel * 0.17, 0.09, 0.35, Math.min(f * 3, 3000), { rate: 5.2, depth: 7, delay: 0.4 });
                sustainVoice("sawtooth", f * 1.008, when, dur, vel * 0.15, 0.1, 0.35, Math.min(f * 3, 3000), { rate: 5.5, depth: 7, delay: 0.5 });
                sustainVoice("sawtooth", f * 0.995, when, dur, vel * 0.12, 0.11, 0.35, Math.min(f * 3, 3000), { rate: 4.9, depth: 7, delay: 0.45 });
                break;
            case "synbrass":
                sustainVoice("sawtooth", f, when, dur, vel * 0.22, 0.03, 0.12, Math.min(f * 8, 4500), { rate: 5, depth: 5, delay: 0.4 });
                sustainVoice("square", f * 1.006, when, dur, vel * 0.1, 0.03, 0.12, Math.min(f * 6, 3500), { rate: 5, depth: 5, delay: 0.4 });
                break;
            case "flute":
                sustainVoice("sine", f, when, dur, vel * 0.3, 0.06, 0.15, 0, { rate: 5.2, depth: 14, delay: 0.3 });
                sustainVoice("sine", f * 2, when, dur, vel * 0.05, 0.08, 0.15, 0, { rate: 5.2, depth: 14, delay: 0.35 });
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
        wave: "tick",
        plasma: "bloom",
        aurora: "bloom",
        prism: "laser",
        strobe: "flash"
    };

    function fireViz(effect, midi, color, dur, vel, source) {
        if (!effect) return;
        try {
            if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        } catch (e) {}
        var cell = midi != null ? pitchToCell(midi) : null;
        if (window.MusicSequencerShaderFx && window.MusicSequencerShaderFx.trigger(effect, cell, color, dur, vel, source)) return;

        var fallback = SHADER_DOM_FALLBACK[effect] || effect;
        if (fallback === "spark") { spawnPulse("msq-spark-dot", cell ? cell.x : 50, cell ? cell.y : 62, color); return; }
        if (fallback === "tick") { spawnPulse("msq-tick-bar", cell ? cell.x : 50, 0, color); return; }
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
        if (ctx && vizQueue.length) {
            var now = ctx.currentTime - VIZ_LEAD;
            var keep = [];
            for (var i = 0; i < vizQueue.length; i++) {
                var e = vizQueue[i];
                if (e.t > now) { keep.push(e); continue; }
                if (now - e.t > 0.25) continue;
                fireViz(e.effect, e.midi, e.color, e.dur, e.vel, e.src);
            }
            vizQueue = keep;
        }
        if (window.MusicSequencerShaderFx) window.MusicSequencerShaderFx.render();
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
            var steps = d.steps || [];
            for (var i = 0; i < steps.length; i++) {
                var off = i * ratio;
                if (steps[i] > 0 && off >= from && off < to) {
                    var when = t0 + i * cellSpan;
                    drumHit(d.voice, when, steps[i] * loop.volume);
                    if (cue) vizQueue.push({ loop: loop, t: when, effect: cue, midi: null, color: colorFor(d.voice), vel: steps[i], src: d.id ? String(d.id) : null });
                }
            }
        } else if (d.kind === "note") {
            var cueN = visualCues.get(String(d.instrument));
            var noteColor = colorFor(d.instrument);
            var notes = d.notes || [];
            for (var j = 0; j < notes.length; j++) {
                var n = notes[j];
                var offN = n.start * ratio;
                if (offN >= from && offN < to) {
                    var whenN = t0 + n.start * cellSpan;
                    var durN = Math.max(0.05, n.length * cellSpan);
                    noteHit(d.instrument, n.pitch, whenN, durN, n.velocity * loop.volume);
                    if (cueN) vizQueue.push({ loop: loop, t: whenN, effect: cueN, midi: n.pitch, color: noteColor, dur: durN, vel: n.velocity, src: d.id ? String(d.id) : null });
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
        (sec.layers || []).forEach(function (l) { wanted[String(l.name)] = l.volume == null ? 1 : l.volume; });
        loops.forEach(function (e, id) {
            if (wanted[id] != null) {
                e.volume = clamp01(wanted[id]);
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
        }
        var horizon = absStep(ctx.currentTime + LOOKAHEAD);
        while (song && horizon >= song.bStep) {
            var n = song.def.sections.length;
            var sec = song.bIdx < n ? song.def.sections[song.bIdx] : null;
            var step = song.bStep;
            var bars = sec ? sec.bars : 0;
            applyBoundary(step, sec);
            if (song) {
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
                try { scheduleOccurrence(loop, loop.sched - loop.nextStep, to - loop.nextStep); }
                catch (e) { loop.playing = false; return; }
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
            if (e) vizQueue = vizQueue.filter(function (v) { return v.loop !== e; });
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
        /* hard cut the old chat: kill scheduled notes too, not just future
           gating, so a long pad from chat A can't ring over chat B */
        song = null;
        panicAudio();
        loops.clear();
        sounds.clear();
        vizQueue = [];
        if (window.MusicSequencerShaderFx) window.MusicSequencerShaderFx.clear();
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
                if (d.meter) setMeter(d.meter);
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
                /* a song that was playing resumes its arrangement from the top */
                if (d.song && d.song.playing) song = { def: d.song, startStep: -1, curSection: null };
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
        else if (t === "music_sequencer:stop_all") panicAudio();
        else if (t === "music_sequencer:tempo") setTempo(data.bpm);
        else if (t === "music_sequencer:meter") setMeter(data.steps);
        else if (t === "music_sequencer:sound") {
            if (data.spec) sounds.set(String(data.name), data.spec);
            else sounds.delete(String(data.name));
        }
        else if (t === "music_sequencer:visual") {
            if (data.effect) visualCues.set(String(data.sound), String(data.effect));
            else visualCues.delete(String(data.sound));
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

    visualCues.set("kick", "flash");
    visualCues.set("snare", "ripple");

    hookWs();
    boot(30);
    if (window.MusicSequencerShaderFx) window.MusicSequencerShaderFx.ensure();
})();

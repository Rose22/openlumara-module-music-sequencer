(function () {
    var MAX_EVENTS = 24;
    var TYPES = {
        flash: 1,
        bloom: 3,
        spark: 4,
        tick: 5,
        laser: 6,
        ripple: 7,
        wave: 8,
        plasma: 9,
        aurora: 10,
        prism: 12,
        strobe: 13,
        pulse: 15
    };
    var AMBIENT = {
        wheel: 21,
        motes: 22,
        vortex: 23,
        soundwave: 24
    };
    var DEFAULT_DUR = {
        flash: 0.45,
        bloom: 0.80,
        spark: 0.50,
        tick: 0.90,
        laser: 0.18,
        ripple: 0.90,
        wave: 0.90,
        plasma: 1.35,
        aurora: 1.80,
        prism: 0.85,
        strobe: 0.55,
        pulse: 0.55
    };

    var canvas = null;
    var gl = null;
    var program = null;
    var buffer = null;
    var ro = null;
    var ready = false;
    var supported = false;
    var enabled = true;
    var dirty = false;
    var lastError = null;
    var events = [];
    var loc = {};
    var lifeData = new Float32Array(MAX_EVENTS * 4);
    var centerData = new Float32Array(MAX_EVENTS * 2);
    var colorData = new Float32Array(MAX_EVENTS * 3);
    var paramData = new Float32Array(MAX_EVENTS * 4);
    var typeData = new Int32Array(MAX_EVENTS);
    var colorCache = new Map();
    var fogEnabled = true;
    var fogIntensity = 0.75;
    var accentCache = null;
    var accentFetchedAt = 0;
    var probe = null;
    var defaultAccent = [0.97, 0.15, 0.52];
    var MAX_AMBIENT = 8;
    var MAX_SOUND_BANDS = 16;
    var WHEEL_SEGS = 24;
    var ambient = [];
    var bpm = 120;
    var masterLevel = 0;
    var lastRender = 0;
    var ambTypeData = new Int32Array(MAX_AMBIENT);
    var ambPosData = new Float32Array(MAX_AMBIENT * 2);
    var ambColorData = new Float32Array(MAX_AMBIENT * 3);
    var ambEnergyData = new Float32Array(MAX_AMBIENT);
    var ambSeedData = new Float32Array(MAX_AMBIENT);
    var ambSpeedData = new Float32Array(MAX_AMBIENT);
    var audioBands = new Float32Array(MAX_AMBIENT * MAX_SOUND_BANDS);
    var audioLevels = new Float32Array(MAX_AMBIENT);
    var wheelData = new Float32Array(MAX_AMBIENT * WHEEL_SEGS);
    var wheelHold = new Float32Array(MAX_AMBIENT * WHEEL_SEGS);
    var wheelSpinData = new Float32Array(MAX_AMBIENT);
    var wheelSizeData = new Float32Array(MAX_AMBIENT);
    /* queued kick hit-times (audio-clock) fed by the host's scheduler; the
       render loop consumes them as their moment arrives */
    var kickTimes = [];

    var vs = [
        "attribute vec2 aPos;",
        "void main() {",
        "    gl_Position = vec4(aPos, 0.0, 1.0);",
        "}"
    ].join("\n");

    var fs = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

const int MAX_EVENTS = 24;
const float PI = 3.141592653589793;
const float TAU = 6.283185307179586;

uniform int uCount;
uniform float uTime;
uniform vec2 uRes;
uniform vec4 uLife[24];
uniform vec2 uCenter[24];
uniform vec3 uColor[24];
uniform vec4 uParam[24];
uniform int uType[24];
uniform vec3 uAccent;
uniform float uFogAmount;
uniform float uBpm;
uniform float uBeat;
uniform int uAmbCount;
uniform int uAmbType[8];
uniform vec2 uAmbPos[8];
uniform vec3 uAmbColor[8];
uniform float uAmbEnergy[8];
uniform float uAmbSeed[8];
uniform float uAmbSpeed[8];
uniform float uSoundBands[128];
uniform float uAmbLevel[8];
uniform float uWheelSeg[192];
uniform float uWheelSpin[8];
uniform float uWheelSize[8];
uniform float uMasterLevel;

const int MAX_AMBIENT = 8;
const int SOUND_BANDS = 16;
const int TYPE_WHEEL = 21;
const int TYPE_MOTES = 22;
const int TYPE_VORTEX = 23;
const int TYPE_SOUNDWAVE = 24;

float aspect() {
    return uRes.x / max(1.0, uRes.y);
}

float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 34.56);
    return fract(p.x * p.y);
}

float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i++) {
        value += vnoise(p) * amplitude;
        p = p * 2.07 + vec2(3.17, 7.21);
        amplitude *= 0.5;
    }
    return value;
}

float fogDensity(vec2 uv) {
    if (uFogAmount <= 0.0) return 0.0;
    vec2 drift = vec2(uTime * 0.035, -uTime * 0.023);
    vec2 warp = vec2(fbm(uv * 2.0 + drift), fbm(uv * 2.0 - drift + vec2(7.3, 2.1)));
    float body = fbm(uv * 1.6 + warp * 0.38 + drift * 0.55);
    float wisps = fbm(uv * 6.0 - drift * 0.75 + warp * 0.25);
    float density = smoothstep(0.26, 0.88, mix(body, wisps, 0.28));
    float radius = length((uv - vec2(0.5, 0.57)) * vec2(aspect(), 1.0));
    float mask = 1.0 - smoothstep(0.18, 1.52, radius);
    return density * mask * 0.085 * uFogAmount;
}

float ease(float x) {
    return smoothstep(0.0, 1.0, x);
}

vec4 fogScatter(vec3 col, float raw, float gain, float maxAmount) {
    float amount = clamp(raw * gain, 0.0, maxAmount);
    vec3 light = mix(mix(col, vec3(1.0), 0.36), vec3(0.70, 0.75, 1.0), 0.38) * amount;
    return vec4(light, amount);
}

float fogShimmer(float phase) {
    return 0.68 + 0.32 * sin(phase);
}

vec4 flashFogFx(vec2 uv, vec3 col, float t, float seed, float strength, float fog) {
    if (fog <= 0.0005) return vec4(0.0);
    float fade = pow(1.0 - t, 1.85);
    vec2 p = (uv - vec2(0.5, 0.62)) * vec2(aspect(), 1.0);
    float mask = pow(1.0 - smoothstep(0.05, 1.45, length(p)), 1.25);
    float flick = fogShimmer(uTime * 13.0 + seed * TAU + t * 24.0);
    return fogScatter(col, mask * fade * strength * fog * flick, 3.15, 0.62);
}

vec4 bloomFogFx(vec2 uv, vec2 c, vec3 col, float t, float seed, float strength, float fog) {
    if (fog <= 0.0005) return vec4(0.0);
    vec2 p = (uv - c) * vec2(aspect(), 1.0);
    float r = length(p);
    float ang = atan(p.y, p.x);
    float e = ease(t);

    float coreCloud = exp(-pow(r / (0.045 + 0.13 * e), 2.0)) * pow(1.0 - t, 1.55);
    float haloCloud = exp(-r / (0.13 + 0.46 * e)) * pow(1.0 - t, 1.15);
    float rayCloud = pow(abs(sin(ang * 3.0 + seed * TAU + e * 1.7)), 5.0) * exp(-r * 1.55) * (1.0 - t);

    float shimmer = fogShimmer(r * 16.0 - uTime * 5.6 + seed * TAU);
    return fogScatter(col, (coreCloud * 0.70 + haloCloud * 0.95 + rayCloud * 0.45) * strength * fog * shimmer, 2.15, 0.48);
}

vec4 sparkFogFx(vec2 uv, vec2 c, vec3 col, float t, float seed, float strength, float fog) {
    if (fog <= 0.0005) return vec4(0.0);
    vec2 p = (uv - c) * vec2(aspect(), 1.0);
    float pr = length(p);
    float cloud = exp(-pow(pr / (0.055 + 0.25 * ease(t)), 2.0)) * pow(1.0 - t, 1.2);
    float trailCloud = 0.0;

    for (int k = 0; k < 8; k++) {
        float kf = float(k);
        float a = seed * TAU + kf * TAU / 8.0 + hash11(kf + seed * 19.0) * 0.75 + t * 1.2;
        float speed = 0.10 + hash11(kf * 4.1 + seed * 7.0) * 0.38;
        vec2 pos = vec2(cos(a), sin(a)) * t * speed;
        trailCloud += exp(-length(p - pos) / (0.028 + 0.06 * t));
    }

    float shimmer = fogShimmer(uTime * 10.5 + seed * TAU);
    return fogScatter(col, (cloud * 0.75 + trailCloud * 0.22) * strength * fog * shimmer, 3.25, 0.68);
}

vec4 tickFogFx(vec2 uv, vec2 raw, vec3 col, float t, float seed, float strength, float fog) {
    if (fog <= 0.0005) return vec4(0.0);
    float yy = 1.0 - uv.y;
    float x = abs(uv.x - raw.x);
    float fall = 1.22 * (0.12 * t + 0.88 * t * t);
    float trail = 0.12 + 0.30 * t;
    float top = max(0.0, fall - trail);
    float band = exp(-pow(x / 0.020, 2.0))
        * smoothstep(top - 0.06, top + 0.03, yy)
        * (1.0 - smoothstep(fall - 0.09, fall + 0.04, yy));
    float flick = fogShimmer(uTime * 16.0 + x * 80.0 + seed * TAU);
    return fogScatter(col, band * strength * fog * flick, 3.1, 0.58);
}

vec4 laserFogFx(vec2 uv, vec3 col, float t, float seed, float strength, vec2 origin, vec2 dir, float fog) {
    if (fog <= 0.0005) return vec4(0.0);
    float proj = dot(uv - origin, dir);
    float d = length(uv - origin - dir * proj);
    float mask = smoothstep(0.0, 0.012, proj) * (1.0 - smoothstep(0.95, 1.30, proj));
    float fade = pow(1.0 - t, 0.88);
    float scatter = exp(-pow(d / 0.037, 2.0)) * mask * fade * strength * fog;
    float shimmer = fogShimmer(proj * 8.5 - uTime * 4.2 + seed * TAU);
    return fogScatter(col, scatter * shimmer, 9.2, 0.88);
}

vec4 rippleFogFx(vec2 uv, vec2 c, vec3 col, float t, float seed, float strength, float fog) {
    if (fog <= 0.0005) return vec4(0.0);
    vec2 p = (uv - c) * vec2(aspect(), 1.0);
    float r = length(p);
    float e = ease(t);
    float wave = 0.0;

    for (int j = 0; j < 2; j++) {
        float jf = float(j);
        float rad = 0.06 + jf * 0.09 + e * (0.92 - jf * 0.06);
        wave += exp(-abs(r - rad) / (0.055 + 0.035 * t)) * (1.0 - t * 0.55) / (jf + 1.0);
    }

    float shimmer = fogShimmer(r * 11.0 - uTime * 5.5 + seed * TAU);
    return fogScatter(col, wave * strength * fog * shimmer, 1.2, 0.45);
}

vec4 waveFogFx(vec2 uv, vec2 c, vec3 col, float t, float seed, float strength, float fog) {
    if (fog <= 0.0005) return vec4(0.0);
    float phase = uv.x * 9.5 - uTime * 7.5 + seed * TAU;
    float yy = c.y + sin(phase) * (0.018 + 0.038 * strength) + 0.008 * sin(uv.x * 27.0 + uTime * 14.0 + seed * 11.0);
    float dist = abs(uv.y - yy);
    float cloud = exp(-pow(dist / 0.075, 2.0)) + 0.55 * exp(-dist / 0.16);
    float shimmer = fogShimmer(phase * 1.5 + seed * 6.0);
    return fogScatter(col, cloud * (1.0 - t) * strength * fog * shimmer, 1.85, 0.60);
}

vec4 plasmaFogFx(vec2 uv, vec2 c, vec3 col, float t, float seed, float strength, float fog) {
    if (fog <= 0.0005) return vec4(0.0);
    vec2 p = (uv - c) * vec2(aspect(), 1.0);
    float r = length(p);
    float w = 0.5 * sin(p.x * 6.0 + uTime * 1.25 + seed * TAU) + 0.5 * sin(p.y * 7.5 - uTime * 1.65 + seed * 7.0);
    float f = 0.5 + 0.5 * sin((p.x + p.y) * 7.0 + uTime * 2.05 + w * 3.1);
    float f2 = 0.5 + 0.5 * sin(r * 13.0 - uTime * 3.7 + seed * TAU);
    float mask = exp(-r * 2.1) * (1.0 - t);
    float m = (0.35 + 0.65 * f) * (0.35 + 0.65 * f2);
    return fogScatter(col, m * mask * strength * fog, 2.55, 0.70);
}

vec4 auroraFogFx(vec2 uv, vec2 c, vec3 col, float t, float seed, float strength, float fog) {
    if (fog <= 0.0005) return vec4(0.0);
    float base = c.y + 0.12 * sin(uv.x * 4.2 + uTime * 0.72 + seed * TAU) + 0.055 * sin(uv.x * 11.5 - uTime * 1.15 + seed * 7.0);
    float dist = abs(uv.y - base);
    float curtain = exp(-dist / 0.10) + 0.42 * exp(-dist / 0.28);
    float streak = 0.48 + 0.52 * sin(uv.x * 15.0 - uTime * 6.0 + seed * TAU + c.y * 11.0);
    float radial = 1.0 - smoothstep(0.20, 1.45, length((uv - vec2(0.55, 0.55)) * vec2(aspect(), 1.0)));
    float fade = pow(1.0 - t, 0.72);
    return fogScatter(col, curtain * (0.55 + streak * 0.72) * radial * fade * strength * fog, 2.15, 0.74);
}

vec4 prismFogFx(vec2 uv, vec2 c, vec3 col, float t, float seed, float strength, float fog) {
    if (fog <= 0.0005) return vec4(0.0);
    vec2 p = (uv - c) * vec2(aspect(), 1.0);
    float r = length(p);
    float ang = atan(p.y, p.x);
    float fan = pow(max(0.0, 1.0 - r / 0.85), 1.75);
    float bands = 0.55 + 0.45 * sin(ang * 5.0 + seed * TAU + ease(t) * 2.8);
    float cloud = pow(bands, 2.0) * fan;
    float shimmer = fogShimmer(r * 14.0 - uTime * 6.0 + seed * TAU);
    return fogScatter(col, cloud * (1.0 - t) * strength * fog * shimmer, 2.45, 0.70);
}

vec4 strobeFogFx(vec2 uv, vec2 c, vec3 col, float t, float seed, float strength, float fog) {
    if (fog <= 0.0005) return vec4(0.0);
    float pulseA = step(0.20, sin(t * TAU * 8.0 + seed * TAU));
    float pulseB = step(0.55, sin(t * TAU * 13.0 + seed * 5.0));
    float pulse = clamp(pulseA * 0.68 + pulseB * 0.42, 0.0, 1.0);
    float fade = pow(1.0 - t, 1.20);
    float radial = 1.0 - smoothstep(0.05, 1.35, length((uv - vec2(0.5, 0.58)) * vec2(aspect(), 1.0)));
    return fogScatter(col, (0.16 + pulse * 0.84) * fade * radial * strength * fog, 2.45, 0.80);
}

vec4 flashFx(vec2 uv, vec2 c, vec3 col, float t, float seed, float strength) {
    float fade = pow(1.0 - t, 2.0);
    vec2 center = vec2(0.5, 0.62);
    vec2 p = (uv - center) * vec2(aspect(), 1.0);
    float rad = length(p);
    float mask = 1.0 - smoothstep(0.08, 1.35, rad);
    float flick = 0.74 + 0.26 * sin(uTime * 37.0 + seed * 31.0 + t * 80.0);
    float chrom = 0.0045 * fade;
    float rr = length((uv - center + vec2(chrom, 0.0)) * vec2(aspect(), 1.0));
    float bb = length((uv - center - vec2(chrom, 0.0)) * vec2(aspect(), 1.0));
    vec3 rgb = vec3(
        1.0 - smoothstep(0.05, 1.25, rr),
        mask,
        1.0 - smoothstep(0.05, 1.25, bb)
    );
    vec3 outc = mix(rgb, col, 0.55) * (mask + 0.12) * flick;
    float a = clamp((mask * 0.48 + 0.10) * fade * strength, 0.0, 1.0);
    return vec4(outc * a, a);
}

vec4 bloomFx(vec2 uv, vec2 c, vec3 col, float t, float seed, float strength) {
    vec2 p = (uv - c) * vec2(aspect(), 1.0);
    float r = length(p);
    float ang = atan(p.y, p.x);
    float rays = pow(abs(sin(ang * 3.0 + seed * TAU + ease(t) * 1.7)), 8.0) * exp(-r * 2.8) * (1.0 - t);
    float glow = exp(-r * (6.5 + 3.0 * t)) * pow(1.0 - t, 1.55);
    float core = exp(-pow(r / 0.026, 2.0)) * (1.0 - t);
    float halo = exp(-r * 1.8) * (1.0 - t) * 0.32;
    float a = clamp((glow * 0.48 + rays * 0.62 + core * 0.45 + halo * 0.65) * strength, 0.0, 1.0);
    vec3 outc = col * (glow * 0.90 + rays * 1.45 + halo * 0.75) + vec3(1.0) * core * 0.78;
    return vec4(outc * a, a);
}

vec4 sparkFx(vec2 uv, vec2 c, vec3 col, float t, float seed, float strength) {
    vec2 p = (uv - c) * vec2(aspect(), 1.0);
    float fade = pow(1.0 - t, 1.3);
    float sum = 0.0;
    for (int k = 0; k < 8; k++) {
        float kf = float(k);
        float a = seed * TAU + kf * TAU / 8.0 + hash11(kf + seed * 19.0) * 0.75 + t * 1.2;
        vec2 dir = vec2(cos(a), sin(a));
        float speed = 0.10 + hash11(kf * 4.1 + seed * 7.0) * 0.38;
        for (int j = 0; j < 3; j++) {
            float jf = float(j);
            vec2 pp = p - dir * t * speed * (1.0 - jf * 0.33);
            sum += exp(-length(pp) * 85.0) * (1.0 - jf * 0.4);
        }
    }
    float a = clamp(sum * 0.16 * fade * strength, 0.0, 1.0);
    vec3 outc = mix(col, vec3(1.0), 0.55) * a;
    return vec4(outc, a);
}

vec4 tickFx(vec2 uv, vec2 raw, vec2 c, vec3 col, float t, float seed, float strength) {
    /* raindrop: a bright bead drips off the top edge and accelerates down
       (gravity ramp), thin wet trail above it, exits past the bottom */
    float yy = 1.0 - uv.y;
    float x = uv.x - raw.x;
    float fall = 1.22 * (0.12 * t + 0.88 * t * t);
    float trail = 0.12 + 0.30 * t;
    float top = max(0.0, fall - trail);
    float band = exp(-pow(x / 0.0038, 2.0))
        * smoothstep(top - 0.035, top + 0.02, yy)
        * (1.0 - smoothstep(fall - 0.06, fall + 0.006, yy));
    float nearHead = smoothstep(top, fall, yy);
    float head = exp(-pow(length(vec2(x * aspect(), yy - fall)) / 0.014, 2.0));
    float flick = 0.86 + 0.14 * sin(uTime * 48.0 + x * 300.0 + seed * TAU);
    float outFade = 1.0 - smoothstep(0.85, 1.0, t);
    float a = clamp((band * (0.28 + 0.62 * nearHead) + head * 1.30) * flick * strength * outFade, 0.0, 1.0);
    vec3 outc = mix(vec3(1.0), col, 0.62) * a + vec3(1.0) * head * a * 0.55;
    return vec4(outc, a);
}

vec4 laserFx(vec2 uv, vec3 col, float t, float seed, float strength, vec2 origin, vec2 dir) {
    float proj = dot(uv - origin, dir);
    float d = length(uv - origin - dir * proj);
    float core = exp(-pow(d / 0.0031, 2.0));
    float glow = exp(-pow(d / 0.0115, 2.0));
    float projMask = smoothstep(0.0, 0.012, proj) * (1.0 - smoothstep(0.95, 1.30, proj));
    float flick = 0.78 + 0.22 * sin(proj * 75.0 - uTime * 33.0 + seed * TAU);
    float fade = pow(1.0 - t, 1.05);
    float muzzle = exp(-length(uv - origin) * 72.0) * (1.0 - t) * 1.85;
    float beam = (core * 1.15 + glow * 0.45) * projMask * fade * flick * strength;
    float a = clamp(beam + muzzle * (1.0 - t) * strength * 1.10, 0.0, 1.0);
    vec3 outc = mix(col, vec3(1.0), 0.44) * (core * 1.22 + glow * 0.75)
        + vec3(1.0) * muzzle * 1.85;
    return vec4(outc * a, a);
}

vec4 rippleFx(vec2 uv, vec2 c, vec3 col, float t, float seed, float strength) {
    vec2 p = (uv - c) * vec2(aspect(), 1.0);
    float r = length(p);
    float e = ease(t);
    float wave = 0.0;
    for (int j = 0; j < 2; j++) {
        float jf = float(j);
        float rad = 0.06 + jf * 0.09 + e * (0.92 - jf * 0.06);
        float band = exp(-abs(r - rad) / (0.012 + 0.006 * t));
        wave += band * (1.0 - t * 0.72) / (jf + 1.0);
    }
    wave *= 0.65 + 0.35 * sin(r * 30.0 - uTime * 11.0 + seed * TAU);
    wave = clamp(wave, 0.0, 1.0);
    float a = clamp(wave * 0.5 * strength * (1.0 - t * 0.5), 0.0, 1.0);
    vec3 outc = mix(col, vec3(1.0), wave * 0.28) * a;
    return vec4(outc, a);
}

vec4 waveFx(vec2 uv, vec2 c, vec3 col, float t, float seed, float strength) {
    float phase = uv.x * 9.5 - uTime * 7.5 + seed * TAU;
    float yy = c.y + sin(phase) * (0.018 + 0.038 * strength) + 0.008 * sin(uv.x * 27.0 + uTime * 14.0 + seed * 11.0);
    float dist = abs(uv.y - yy);
    float core = exp(-dist * 360.0);
    float glow = exp(-dist * 80.0);
    float shimmer = 0.62 + 0.38 * sin(phase * 1.7 + seed * 6.0);
    float a = clamp((core + glow * 0.75) * shimmer * (1.0 - t) * strength, 0.0, 1.0);
    vec3 outc = mix(col, vec3(1.0), 0.35) * a;
    return vec4(outc, a);
}

vec4 plasmaFx(vec2 uv, vec2 c, vec3 col, float t, float seed, float strength) {
    vec2 p = (uv - c) * vec2(aspect(), 1.0);
    float r = length(p);
    float w = 0.5 * sin(p.x * 6.0 + uTime * 1.25 + seed * TAU) + 0.5 * sin(p.y * 7.5 - uTime * 1.65 + seed * 7.0);
    float f = 0.5 + 0.5 * sin((p.x + p.y) * 7.0 + uTime * 2.05 + w * 3.1);
    float f2 = 0.5 + 0.5 * sin(r * 13.0 - uTime * 3.7 + seed * TAU);
    float mask = exp(-r * 3.5) * (1.0 - t);
    float m = (0.45 + 0.55 * f) * (0.45 + 0.55 * f2);
    float a = clamp(m * mask * strength * 0.85, 0.0, 1.0);
    vec3 outc = mix(col, vec3(1.0), abs(f - 0.5) * 0.7) * a;
    return vec4(outc, a);
}

vec4 auroraFx(vec2 uv, vec2 c, vec3 col, float t, float seed, float strength) {
    float base = c.y + 0.12 * sin(uv.x * 4.2 + uTime * 0.72 + seed * TAU) + 0.055 * sin(uv.x * 11.5 - uTime * 1.15 + seed * 7.0);
    float dist = abs(uv.y - base);
    float curtain = exp(-dist * 68.0) + 0.45 * exp(-dist * 17.0);
    float streak = 0.55 + 0.45 * sin(uv.x * 27.0 - uTime * 15.0 + seed * TAU + c.y * 17.0);
    float fade = pow(1.0 - t, 0.9);
    float radial = 1.0 - smoothstep(0.25, 1.35, length((uv - vec2(0.55, 0.55)) * vec2(aspect(), 1.0)));
    float a = clamp(curtain * (0.48 + streak * 0.82) * radial * fade * strength, 0.0, 1.0);
    vec3 outc = mix(col, vec3(1.0), streak * 0.33) * a;
    return vec4(outc, a);
}

vec4 prismFx(vec2 uv, vec2 c, vec3 col, float t, float seed, float strength) {
    vec2 p = (uv - c) * vec2(aspect(), 1.0);
    float r = length(p);
    float ang = atan(p.y, p.x);
    float fan = pow(max(0.0, 1.0 - r / 0.48), 2.2);
    float bands = sin(ang * 5.0 + seed * TAU + ease(t) * 2.8);
    float shard = pow(abs(bands), 2.0) * fan;
    float edge = 1.0 - smoothstep(0.48, 0.53, abs(fract(ang / TAU * 6.0 + ease(t) * 0.18) - 0.5)) * fan;
    vec3 spectral = 0.5 + 0.5 * cos(TAU * (vec3(0.0, 0.33, 0.66) + ang / TAU + t * 0.22 + seed));
    float ca = 0.5 + 0.5 * sin(r * 32.0 - uTime * 9.5 + seed * TAU);
    float a = clamp((shard * 0.48 + edge * 0.75 + exp(-r * 14.0) * ca * 0.4) * (1.0 - t) * strength, 0.0, 1.0);
    vec3 outc = mix(col, spectral, 0.65) * a;
    return vec4(outc, a);
}

vec4 strobeFx(vec2 uv, vec2 c, vec3 col, float t, float seed, float strength) {
    float pulseA = step(0.20, sin(t * TAU * 8.0 + seed * TAU));
    float pulseB = step(0.55, sin(t * TAU * 13.0 + seed * 5.0));
    float bands = step(0.5, fract(uv.y * 34.0 + uTime * 22.0 + seed * TAU));
    float radial = 1.0 - smoothstep(0.05, 1.25, length((uv - vec2(0.5, 0.58)) * vec2(aspect(), 1.0)));
    float on = clamp(pulseA * 0.62 + pulseB * 0.48, 0.0, 1.0);
    float fade = 1.0 - pow(t, 1.45);
    float a = clamp((0.16 + on * 0.76 + bands * 0.10) * fade * strength * radial, 0.0, 1.0);
    vec3 outc = mix(col, vec3(1.0), 0.55 + on * 0.22) * a;
    return vec4(outc, a);
}

float sq(float x) {
    return x * x;
}

/* jsb-style slam bar: pinned to one screen edge (picked by seed), the bar
   GROWS from that edge toward the opposite side with a fast ease-out, its
   leading edge burning brightest while the body trails dimmer behind it */
vec2 pulseBand(vec2 uv, float t, float seed) {
    float edge = floor(fract(seed * 17.0) * 4.0);
    float u, v;
    if (edge < 0.5) { u = uv.x; v = uv.y; }
    else if (edge < 1.5) { u = 1.0 - uv.x; v = uv.y; }
    else if (edge < 2.5) { u = uv.y; v = uv.x; }
    else { u = 1.0 - uv.y; v = uv.x; }
    /* SLAM BEAM: travels the FULL screen (edge to opposite edge) within ~35%
       of its life, but the beam is a band only ~20% of the screen thick -
       centered across, soft-edged. Freezes at full travel with an impact
       flare on the far edge, then dies. */
    /* HARD SLAM: near-instant travel, razor edges, flat solid fill, snap kill */
    float slam = min(1.0, t / 0.16);
    float L = (1.0 - pow(1.0 - slam, 4.0)) * 1.16;
    float inside = (1.0 - smoothstep(L - 0.002, L + 0.002, u)) * step(0.0, u);
    /* solid 20% band with hard pixel edges, random lane along the spawn edge */
    float vc = 0.2 + 0.6 * fract(seed * 7.31);
    float aa = 2.0 / max(640.0, uRes.y);
    float band = 1.0 - smoothstep(0.098 - aa, 0.102 + aa, abs(v - vc));
    /* hard-edged white cap riding the front while travelling */
    float capBand = 1.0 - smoothstep(0.102 - aa, 0.108 + aa, abs(v - vc));
    float lead = step(L - 0.016, u) * step(u, L) * (1.0 - slam) * capBand;
    /* impact: hard white block hammering the far edge, snaps off fast */
    float impact = step(0.972, u) * step(0.0, 1.0 - t / 0.22) * step(0.14, t) * capBand;
    /* flat body, only slightly brighter near the launch edge */
    float trail = inside * (0.72 + 0.28 * (1.0 - min(1.0, u)));
    return vec2(clamp(trail * band + lead * 1.6 + impact * 1.4, 0.0, 1.6), inside * band);
}

vec4 pulseFx(vec2 uv, vec3 col, float t, float seed, float strength) {
    vec2 b = pulseBand(uv, t, seed);
    /* full brightness through slam + impact, then a snap kill */
    float fade = 1.0 - smoothstep(0.60, 0.82, t);
    float a = clamp(b.x * fade * strength, 0.0, 1.0);
    vec3 outc = mix(col, vec3(1.0), 0.30 + 0.55 * b.x) * a;
    return vec4(outc, a);
}

vec4 pulseFogFx(vec2 uv, vec3 col, float t, float seed, float strength, float fog) {
    if (fog <= 0.0005) return vec4(0.0);
    vec2 b = pulseBand(uv, t, seed);
    float fade = 1.0 - pow(t, 1.8);
    float shimmer = fogShimmer((uv.x + uv.y) * 18.0 - uTime * 8.0 + seed * TAU);
    return fogScatter(col, b.y * fade * strength * fog * shimmer, 2.7, 0.58);
}

vec4 wheelAmbient(vec2 uv, vec2 c, vec3 col, float energy, float master, float fog, float spin, float size,
    float s0, float s1, float s2, float s3, float s4, float s5, float s6, float s7,
    float s8, float s9, float s10, float s11, float s12, float s13, float s14, float s15,
    float s16, float s17, float s18, float s19, float s20, float s21, float s22, float s23) {
    /* segmented circle: 12 pitch-class segments (C..B, clockwise from top).
       Lit segments bloom-glow and scatter the surrounding fog. */
    /* size scales the whole wheel uniformly: map uv into unit wheel-space */
    float wsz = max(0.25, size);
    vec2 p = (uv - c) * vec2(aspect(), 1.0) / wsz;
    float dr = length(p);
    float aa = 2.2 / max(640.0, uRes.y) / wsz;
    float outR = 0.44;
    float ringW = 0.105;
    float tw = TAU / 12.0;
    /* fixed key light (top-left) shared by every part of the dial */
    vec2 lDir = normalize(vec2(-0.38, 0.92));
    /* kick-synced spin: the CPU integrates rot so each kick lands exactly one
       segment (tw) further along; between kicks it decelerates smoothly */
    float a = atan(p.x, p.y) - spin;

    /* GLSL ES 1.00: only (uniform) arrays take loop indices, so the segment
       values are packed into vec4s and picked by component compare */
    vec4 a4 = vec4(s0, s1, s2, s3);
    vec4 b4 = vec4(s4, s5, s6, s7);
    vec4 c4 = vec4(s8, s9, s10, s11);

    vec3 sum = vec3(0.0);
    float litSum = 0.0;
    /* mipmap-style detail fade: when the key gaps drop below a few screen
       pixels the segmentation (and its dome shading) turns into aliasing
       moire - an "iris" of spokes. blend the whole keyed structure out into
       a plain soft annulus as the wheel shrinks */
    /* key width in real screen pixels (0.05 rad at r=1 of wheel-space) */
    float detail = smoothstep(9.0, 22.0, 0.05 * wsz * uRes.y);
    float ringSoft = 1.0 - smoothstep(ringW * 0.55, ringW * 1.15, abs(dr - 0.385));
    float litAvg = 0.0;
    for (int i = 0; i < 12; i++) {
        float fi = float(i);
        float ca = (fi + 0.5) * tw;
        float w = atan(sin(a - ca), cos(a - ca));
        /* feather both borders by at least a screen pixel: tiny wheels have
           sub-pixel keys whose hard steps would alias into colored spokes */
        float angAA = max(0.006, aa / max(dr, 0.05));
        float seg = (1.0 - smoothstep(tw * 0.5 - 0.028 - angAA, tw * 0.5 - 0.028 + angAA, abs(w)))
            * (1.0 - smoothstep(ringW - aa, ringW + aa, abs(dr - 0.385)));
        float m0 = step(abs(fi - 0.0), 0.5) * a4.x + step(abs(fi - 1.0), 0.5) * a4.y
            + step(abs(fi - 2.0), 0.5) * a4.z + step(abs(fi - 3.0), 0.5) * a4.w;
        float m1 = step(abs(fi - 4.0), 0.5) * b4.x + step(abs(fi - 5.0), 0.5) * b4.y
            + step(abs(fi - 6.0), 0.5) * b4.z + step(abs(fi - 7.0), 0.5) * b4.w;
        float m2 = step(abs(fi - 8.0), 0.5) * c4.x + step(abs(fi - 9.0), 0.5) * c4.y
            + step(abs(fi - 10.0), 0.5) * c4.z + step(abs(fi - 11.0), 0.5) * c4.w;
        float v = m0 + m1 + m2;
        /* dome-shaded key caps: each segment is a rounded cap on the ring,
           lit from the top-left; unlit caps read as dark glossy plastic */
        vec2 cp = vec2(w * 0.385, dr - 0.385);
        vec2 cn = clamp(cp / 0.034, -1.0, 1.0);
        float cnl = length(cn);
        float onCap = seg * (1.0 - smoothstep(0.72, 1.02, cnl));
        vec2 nrm = cn * (1.0 - 0.55 * cnl);
        float lambert = max(0.0, dot(nrm, lDir));
        float keySpec = pow(lambert, 26.0) * onCap;
        /* angular soft edge weighted by the segment's energy: the lit part of
           the ring keeps a soft wedge of light past its hard segment borders */
        float aw = exp(-sq(w / (0.10 + 0.30 * v)));
        float radGlow = exp(-sq((dr - 0.385) / (ringW * (0.75 + 1.9 * v))));
        float glow = aw * radGlow * v;
        litSum += glow;
        litAvg += v;
        vec3 unlit = col * 0.22 * (0.55 + 0.75 * lambert);
        vec3 litKey = mix(vec3(1.0), col, 0.35 + 0.5 * v) * (0.88 + 0.28 * lambert);
        sum += (mix(unlit, litKey, seg * (0.055 + 0.95 * v)) * seg
            + vec3(1.0) * keySpec * (0.16 + 0.80 * v)
            + glow * 0.85 * mix(vec3(1.0), col, 0.35 + 0.5 * v)) * detail;
    }
    /* smooth lit fallback for faded wheels: the ring brightness follows the
       average key energy - no spokes, no moire, still reacts to notes */
    sum += col * ringSoft * (0.07 + 0.55 * litAvg) * (1.0 - detail);
    /* inner edge follows the ring band: inR0 = radius where the band ends */
    float inR0 = 0.385 - ringW;
    /* solid puck seen straight-on: symmetric dark casing ring (no directional
       rim - that would read as a tilt), with a soft rounded falloff outward */
    float lipW = max(0.009, 2.0 * aa);
    float casing = smoothstep(outR - aa, outR + aa, dr)
        * (1.0 - smoothstep(outR + 0.030, outR + 0.046, dr));
    sum += col * 0.06 * casing * (1.0 - 0.5 * smoothstep(outR + 0.008, outR + 0.044, dr));
    /* symmetric bevel lips: the outer edge and inner hole both get a soft
       rounded highlight all the way around (front view, no tilt) */
    float lip = exp(-sq((dr - outR) / lipW));
    float innerLip = exp(-sq((dr - inR0) / max(0.008, 2.0 * aa)));
    sum += mix(vec3(1.0), col, 0.6) * (lip * 0.16 + innerLip * 0.12) * (0.6 + 0.5 * energy);

    /* background object: heavily dimmed and fog-drowned, so the wheel reads
       as a shape far behind the stage rather than an equal-priority effect */
    vec3 outc = sum * (0.26 + 0.12 * energy + 0.08 * master);
    outc *= 1.0 - min(0.70, fog * 6.0);
    float alpha = clamp(max(outc.r, max(outc.g, outc.b)) * 0.75, 0.0, 0.42);

    /* lit segments still light the fog, but the wheel itself stays a dim
       silhouette IN that fog - the glow belongs to the mist, not the dial */
    if (fog > 0.0005) {
        float halo = litSum * 0.12 * (0.65 + 0.35 * fogShimmer(dr * 13.0 - uTime * 4.0 + uBeat * 0.35));
        vec4 sc = fogScatter(mix(col, vec3(1.0), 0.4), halo, 2.3, 0.55);
        alpha = min(0.55, alpha + sc.a * 0.7);
        return vec4(outc + sc.rgb, alpha);
    }
    return vec4(outc, alpha);
}

vec4 wheel0(vec2 uv, vec2 c, vec3 col, float energy, float master, float fog, float spin, float size) {
    return wheelAmbient(uv, c, col, energy, master, fog, spin, size, uWheelSeg[0], uWheelSeg[1], uWheelSeg[2], uWheelSeg[3], uWheelSeg[4], uWheelSeg[5], uWheelSeg[6], uWheelSeg[7], uWheelSeg[8], uWheelSeg[9], uWheelSeg[10], uWheelSeg[11], uWheelSeg[12], uWheelSeg[13], uWheelSeg[14], uWheelSeg[15], uWheelSeg[16], uWheelSeg[17], uWheelSeg[18], uWheelSeg[19], uWheelSeg[20], uWheelSeg[21], uWheelSeg[22], uWheelSeg[23]);
}
vec4 wheel1(vec2 uv, vec2 c, vec3 col, float energy, float master, float fog, float spin, float size) {
    return wheelAmbient(uv, c, col, energy, master, fog, spin, size, uWheelSeg[24], uWheelSeg[25], uWheelSeg[26], uWheelSeg[27], uWheelSeg[28], uWheelSeg[29], uWheelSeg[30], uWheelSeg[31], uWheelSeg[32], uWheelSeg[33], uWheelSeg[34], uWheelSeg[35], uWheelSeg[36], uWheelSeg[37], uWheelSeg[38], uWheelSeg[39], uWheelSeg[40], uWheelSeg[41], uWheelSeg[42], uWheelSeg[43], uWheelSeg[44], uWheelSeg[45], uWheelSeg[46], uWheelSeg[47]);
}
vec4 wheel2(vec2 uv, vec2 c, vec3 col, float energy, float master, float fog, float spin, float size) {
    return wheelAmbient(uv, c, col, energy, master, fog, spin, size, uWheelSeg[48], uWheelSeg[49], uWheelSeg[50], uWheelSeg[51], uWheelSeg[52], uWheelSeg[53], uWheelSeg[54], uWheelSeg[55], uWheelSeg[56], uWheelSeg[57], uWheelSeg[58], uWheelSeg[59], uWheelSeg[60], uWheelSeg[61], uWheelSeg[62], uWheelSeg[63], uWheelSeg[64], uWheelSeg[65], uWheelSeg[66], uWheelSeg[67], uWheelSeg[68], uWheelSeg[69], uWheelSeg[70], uWheelSeg[71]);
}
vec4 wheel3(vec2 uv, vec2 c, vec3 col, float energy, float master, float fog, float spin, float size) {
    return wheelAmbient(uv, c, col, energy, master, fog, spin, size, uWheelSeg[72], uWheelSeg[73], uWheelSeg[74], uWheelSeg[75], uWheelSeg[76], uWheelSeg[77], uWheelSeg[78], uWheelSeg[79], uWheelSeg[80], uWheelSeg[81], uWheelSeg[82], uWheelSeg[83], uWheelSeg[84], uWheelSeg[85], uWheelSeg[86], uWheelSeg[87], uWheelSeg[88], uWheelSeg[89], uWheelSeg[90], uWheelSeg[91], uWheelSeg[92], uWheelSeg[93], uWheelSeg[94], uWheelSeg[95]);
}
vec4 wheel4(vec2 uv, vec2 c, vec3 col, float energy, float master, float fog, float spin, float size) {
    return wheelAmbient(uv, c, col, energy, master, fog, spin, size, uWheelSeg[96], uWheelSeg[97], uWheelSeg[98], uWheelSeg[99], uWheelSeg[100], uWheelSeg[101], uWheelSeg[102], uWheelSeg[103], uWheelSeg[104], uWheelSeg[105], uWheelSeg[106], uWheelSeg[107], uWheelSeg[108], uWheelSeg[109], uWheelSeg[110], uWheelSeg[111], uWheelSeg[112], uWheelSeg[113], uWheelSeg[114], uWheelSeg[115], uWheelSeg[116], uWheelSeg[117], uWheelSeg[118], uWheelSeg[119]);
}
vec4 wheel5(vec2 uv, vec2 c, vec3 col, float energy, float master, float fog, float spin, float size) {
    return wheelAmbient(uv, c, col, energy, master, fog, spin, size, uWheelSeg[120], uWheelSeg[121], uWheelSeg[122], uWheelSeg[123], uWheelSeg[124], uWheelSeg[125], uWheelSeg[126], uWheelSeg[127], uWheelSeg[128], uWheelSeg[129], uWheelSeg[130], uWheelSeg[131], uWheelSeg[132], uWheelSeg[133], uWheelSeg[134], uWheelSeg[135], uWheelSeg[136], uWheelSeg[137], uWheelSeg[138], uWheelSeg[139], uWheelSeg[140], uWheelSeg[141], uWheelSeg[142], uWheelSeg[143]);
}
vec4 wheel6(vec2 uv, vec2 c, vec3 col, float energy, float master, float fog, float spin, float size) {
    return wheelAmbient(uv, c, col, energy, master, fog, spin, size, uWheelSeg[144], uWheelSeg[145], uWheelSeg[146], uWheelSeg[147], uWheelSeg[148], uWheelSeg[149], uWheelSeg[150], uWheelSeg[151], uWheelSeg[152], uWheelSeg[153], uWheelSeg[154], uWheelSeg[155], uWheelSeg[156], uWheelSeg[157], uWheelSeg[158], uWheelSeg[159], uWheelSeg[160], uWheelSeg[161], uWheelSeg[162], uWheelSeg[163], uWheelSeg[164], uWheelSeg[165], uWheelSeg[166], uWheelSeg[167]);
}
vec4 wheel7(vec2 uv, vec2 c, vec3 col, float energy, float master, float fog, float spin, float size) {
    return wheelAmbient(uv, c, col, energy, master, fog, spin, size, uWheelSeg[168], uWheelSeg[169], uWheelSeg[170], uWheelSeg[171], uWheelSeg[172], uWheelSeg[173], uWheelSeg[174], uWheelSeg[175], uWheelSeg[176], uWheelSeg[177], uWheelSeg[178], uWheelSeg[179], uWheelSeg[180], uWheelSeg[181], uWheelSeg[182], uWheelSeg[183], uWheelSeg[184], uWheelSeg[185], uWheelSeg[186], uWheelSeg[187], uWheelSeg[188], uWheelSeg[189], uWheelSeg[190], uWheelSeg[191]);
}

vec4 motesAmbient(vec2 uv, vec2 c, vec3 col, float energy, float seed, float speed) {
    float cyc = uTime * speed * 0.06;
    float v = 0.0;
    for (int i = 0; i < 7; i++) {
        float fi = float(i);
        float h = hash21(vec2(fi + seed * 17.0, seed * 5.0 + fi * 2.3));
        float py = fract(cyc + h);
        float ph = hash21(vec2(floor(cyc + h) + fi, seed * 9.0 + h * 11.0));
        float px = c.x + (ph - 0.5) * 0.24 + sin(cyc * 2.1 + h * TAU) * 0.035;
        vec2 d = vec2((uv.x - px) * aspect(), uv.y - py);
        v += exp(-dot(d, d) * 360.0) * (0.25 + h * 0.75);
    }
    float a = clamp(v * (0.10 + energy * 0.75), 0.0, 1.0);
    vec3 outc = mix(col, vec3(1.0), 0.30) * a;
    return vec4(outc, a);
}

vec4 vortexAmbient(vec2 uv, vec2 c, vec3 col, float energy, float seed, float speed) {
    float base = uTime * speed * 0.11;
    float v = 0.0;
    float rows = 18.0;
    for (int k = 0; k < 3; k++) {
        float fk = float(k);
        float cell = floor(uv.y * rows + base + fk * 5.7);
        float h = hash21(vec2(cell, seed + fk * 3.1));
        float py = (cell + h) / rows;
        float amp = 0.025 + h * 0.16;
        float px = c.x + sin(py * 6.5 + base * 2.4 + h * TAU) * amp;
        vec2 d = vec2((uv.x - px) * aspect(), uv.y - py);
        v += exp(-dot(d, d) * 300.0) * (0.22 + h * 0.78);
    }
    float colMask = 1.0 - smoothstep(0.0, 0.22, abs(uv.x - c.x));
    float a = clamp(v * colMask * (0.10 + energy * 0.85), 0.0, 1.0);
    vec3 outc = mix(col, vec3(1.0), clamp(energy * 0.45, 0.0, 0.7)) * a;
    return vec4(outc, a);
}

vec4 soundwaveAmbient(vec2 uv, vec2 c, vec3 col, float energy, float lvl,
    float b0, float b1, float b2, float b3, float b4, float b5, float b6, float b7,
    float b8, float b9, float b10, float b11, float b12, float b13, float b14, float b15) {
    /* GLSL ES 1.00 cannot index local arrays with loop variables, so the
       packed spectrum arrives as plain scalars and is summed unrolled */
    float curve = b0 * exp(-sq((uv.x - 0.03) / 0.038))
        + b1 * exp(-sq((uv.x - 0.0927) / 0.038))
        + b2 * exp(-sq((uv.x - 0.1553) / 0.038))
        + b3 * exp(-sq((uv.x - 0.218) / 0.038))
        + b4 * exp(-sq((uv.x - 0.2807) / 0.038))
        + b5 * exp(-sq((uv.x - 0.3433) / 0.038))
        + b6 * exp(-sq((uv.x - 0.406) / 0.038))
        + b7 * exp(-sq((uv.x - 0.4687) / 0.038))
        + b8 * exp(-sq((uv.x - 0.5313) / 0.038))
        + b9 * exp(-sq((uv.x - 0.594) / 0.038))
        + b10 * exp(-sq((uv.x - 0.6567) / 0.038))
        + b11 * exp(-sq((uv.x - 0.7193) / 0.038))
        + b12 * exp(-sq((uv.x - 0.782) / 0.038))
        + b13 * exp(-sq((uv.x - 0.8447) / 0.038))
        + b14 * exp(-sq((uv.x - 0.9073) / 0.038))
        + b15 * exp(-sq((uv.x - 0.97) / 0.038));
    float power = b0 + b1 + b2 + b3 + b4 + b5 + b6 + b7 + b8 + b9 + b10 + b11 + b12 + b13 + b14 + b15;
    float norm = max(0.45, power / 4.0);
    curve = curve / norm;
    /* opacity rides the instrument's live volume: silent = fully faded out,
       loud = full presence. gentle gamma so quiet passages stay readable */
    float vol = clamp(pow(max(lvl, 0.0), 0.7), 0.0, 1.0);
    float y = c.y + curve * (0.06 + 0.20 * vol);
    float d = abs(uv.y - y);
    float core = exp(-pow(d / 0.0055, 2.0));
    float glow = exp(-pow(d / 0.028, 2.0));
    float bright = 0.35 + energy * 0.55 + vol * 0.55;
    float a = clamp((core + glow * 0.55) * bright, 0.0, 1.0) * vol;
    vec3 outc = mix(col, vec3(1.0), 0.28) * a;
    return vec4(outc, a);
}

vec4 soundwave0(vec2 uv, vec2 c, vec3 col, float energy) {
    return soundwaveAmbient(uv, c, col, energy, uAmbLevel[0], uSoundBands[0], uSoundBands[1], uSoundBands[2], uSoundBands[3], uSoundBands[4], uSoundBands[5], uSoundBands[6], uSoundBands[7], uSoundBands[8], uSoundBands[9], uSoundBands[10], uSoundBands[11], uSoundBands[12], uSoundBands[13], uSoundBands[14], uSoundBands[15]);
}
vec4 soundwave1(vec2 uv, vec2 c, vec3 col, float energy) {
    return soundwaveAmbient(uv, c, col, energy, uAmbLevel[1], uSoundBands[16], uSoundBands[17], uSoundBands[18], uSoundBands[19], uSoundBands[20], uSoundBands[21], uSoundBands[22], uSoundBands[23], uSoundBands[24], uSoundBands[25], uSoundBands[26], uSoundBands[27], uSoundBands[28], uSoundBands[29], uSoundBands[30], uSoundBands[31]);
}
vec4 soundwave2(vec2 uv, vec2 c, vec3 col, float energy) {
    return soundwaveAmbient(uv, c, col, energy, uAmbLevel[2], uSoundBands[32], uSoundBands[33], uSoundBands[34], uSoundBands[35], uSoundBands[36], uSoundBands[37], uSoundBands[38], uSoundBands[39], uSoundBands[40], uSoundBands[41], uSoundBands[42], uSoundBands[43], uSoundBands[44], uSoundBands[45], uSoundBands[46], uSoundBands[47]);
}
vec4 soundwave3(vec2 uv, vec2 c, vec3 col, float energy) {
    return soundwaveAmbient(uv, c, col, energy, uAmbLevel[3], uSoundBands[48], uSoundBands[49], uSoundBands[50], uSoundBands[51], uSoundBands[52], uSoundBands[53], uSoundBands[54], uSoundBands[55], uSoundBands[56], uSoundBands[57], uSoundBands[58], uSoundBands[59], uSoundBands[60], uSoundBands[61], uSoundBands[62], uSoundBands[63]);
}
vec4 soundwave4(vec2 uv, vec2 c, vec3 col, float energy) {
    return soundwaveAmbient(uv, c, col, energy, uAmbLevel[4], uSoundBands[64], uSoundBands[65], uSoundBands[66], uSoundBands[67], uSoundBands[68], uSoundBands[69], uSoundBands[70], uSoundBands[71], uSoundBands[72], uSoundBands[73], uSoundBands[74], uSoundBands[75], uSoundBands[76], uSoundBands[77], uSoundBands[78], uSoundBands[79]);
}
vec4 soundwave5(vec2 uv, vec2 c, vec3 col, float energy) {
    return soundwaveAmbient(uv, c, col, energy, uAmbLevel[5], uSoundBands[80], uSoundBands[81], uSoundBands[82], uSoundBands[83], uSoundBands[84], uSoundBands[85], uSoundBands[86], uSoundBands[87], uSoundBands[88], uSoundBands[89], uSoundBands[90], uSoundBands[91], uSoundBands[92], uSoundBands[93], uSoundBands[94], uSoundBands[95]);
}
vec4 soundwave6(vec2 uv, vec2 c, vec3 col, float energy) {
    return soundwaveAmbient(uv, c, col, energy, uAmbLevel[6], uSoundBands[96], uSoundBands[97], uSoundBands[98], uSoundBands[99], uSoundBands[100], uSoundBands[101], uSoundBands[102], uSoundBands[103], uSoundBands[104], uSoundBands[105], uSoundBands[106], uSoundBands[107], uSoundBands[108], uSoundBands[109], uSoundBands[110], uSoundBands[111]);
}
vec4 soundwave7(vec2 uv, vec2 c, vec3 col, float energy) {
    return soundwaveAmbient(uv, c, col, energy, uAmbLevel[7], uSoundBands[112], uSoundBands[113], uSoundBands[114], uSoundBands[115], uSoundBands[116], uSoundBands[117], uSoundBands[118], uSoundBands[119], uSoundBands[120], uSoundBands[121], uSoundBands[122], uSoundBands[123], uSoundBands[124], uSoundBands[125], uSoundBands[126], uSoundBands[127]);
}



void main() {
    vec2 uv = gl_FragCoord.xy / max(uRes, vec2(1.0));
    float fog = fogDensity(uv);
    vec3 fogColor = mix(vec3(0.31, 0.34, 0.46), uAccent, 0.18);
    vec3 fogLight = fogColor * fog;
    vec3 color = fogLight;
    float alpha = fog;

    for (int i = 0; i < MAX_EVENTS; i++) {
        if (i >= uCount) break;

        float start = uLife[i].x;
        float life = max(0.06, uLife[i].y);
        float age = uTime - start;
        if (age < 0.0 || age >= life) continue;

        float t = age / life;
        float seed = uLife[i].z;
        float strength = uLife[i].w;
        vec2 raw = uCenter[i];
        vec2 c = vec2(raw.x, 1.0 - raw.y);
        vec3 col = uColor[i];
        int typ = uType[i];
        vec4 fx = vec4(0.0);
        vec4 fogFx = vec4(0.0);

        if (typ == 1) {
            fx = flashFx(uv, c, col, t, seed, strength);
            fogFx = flashFogFx(uv, col, t, seed, strength, fog);
        }
        else if (typ == 3) {
            fx = bloomFx(uv, c, col, t, seed, strength);
            fogFx = bloomFogFx(uv, c, col, t, seed, strength, fog);
        }
        else if (typ == 4) {
            fx = sparkFx(uv, c, col, t, seed, strength);
            fogFx = sparkFogFx(uv, c, col, t, seed, strength, fog);
        }
        else if (typ == 5) {
            fx = tickFx(uv, raw, c, col, t, seed, strength);
            fogFx = tickFogFx(uv, raw, col, t, seed, strength, fog);
        }
        else if (typ == 6) {
            vec2 origin = vec2(uParam[i].y, uParam[i].z);
            vec2 dir = vec2(cos(uParam[i].x), sin(uParam[i].x));
            fx = laserFx(uv, col, t, seed, strength, origin, dir);
            fogFx = laserFogFx(uv, col, t, seed, strength, origin, dir, fog);
        }
        else if (typ == 7) {
            fx = rippleFx(uv, c, col, t, seed, strength);
            fogFx = rippleFogFx(uv, c, col, t, seed, strength, fog);
        }
        else if (typ == 8) {
            fx = waveFx(uv, c, col, t, seed, strength);
            fogFx = waveFogFx(uv, c, col, t, seed, strength, fog);
        }
        else if (typ == 9) {
            fx = plasmaFx(uv, c, col, t, seed, strength);
            fogFx = plasmaFogFx(uv, c, col, t, seed, strength, fog);
        }
        else if (typ == 10) {
            fx = auroraFx(uv, c, col, t, seed, strength);
            fogFx = auroraFogFx(uv, c, col, t, seed, strength, fog);
        }
        else if (typ == 12) {
            fx = prismFx(uv, c, col, t, seed, strength);
            fogFx = prismFogFx(uv, c, col, t, seed, strength, fog);
        }
        else if (typ == 13) {
            fx = strobeFx(uv, c, col, t, seed, strength);
            fogFx = strobeFogFx(uv, c, col, t, seed, strength, fog);
        }
        else if (typ == 15) {
            fx = pulseFx(uv, col, t, seed, strength);
            fogFx = pulseFogFx(uv, col, t, seed, strength, fog);
        }

        color += fx.rgb + fogFx.rgb;
        alpha = min(1.0, alpha + fx.a + fogFx.a);
    }

    vec4 amb = vec4(0.0);
    for (int ch = 0; ch < MAX_AMBIENT; ch++) {
        if (ch >= uAmbCount) break;
        float energyMin = uAmbType[ch] == TYPE_WHEEL ? 0.10 : 0.0;
        float energy = clamp(uAmbEnergy[ch], energyMin, 1.6);
        float speed = max(0.02, uAmbSpeed[ch]);
        vec3 acol = uAmbColor[ch];
        int at = uAmbType[ch];
        if (at == TYPE_WHEEL) {
            float wm = clamp(uMasterLevel, 0.0, 1.0);
            float wsp = uWheelSpin[ch];
            float wsz = uWheelSize[ch];
            if (ch == 0) amb += wheel0(uv, uAmbPos[ch], acol, energy, wm, fog, wsp, wsz);
            else if (ch == 1) amb += wheel1(uv, uAmbPos[ch], acol, energy, wm, fog, wsp, wsz);
            else if (ch == 2) amb += wheel2(uv, uAmbPos[ch], acol, energy, wm, fog, wsp, wsz);
            else if (ch == 3) amb += wheel3(uv, uAmbPos[ch], acol, energy, wm, fog, wsp, wsz);
            else if (ch == 4) amb += wheel4(uv, uAmbPos[ch], acol, energy, wm, fog, wsp, wsz);
            else if (ch == 5) amb += wheel5(uv, uAmbPos[ch], acol, energy, wm, fog, wsp, wsz);
            else if (ch == 6) amb += wheel6(uv, uAmbPos[ch], acol, energy, wm, fog, wsp, wsz);
            else amb += wheel7(uv, uAmbPos[ch], acol, energy, wm, fog, wsp, wsz);
        }
        else if (at == TYPE_MOTES) {
            amb += motesAmbient(uv, uAmbPos[ch], acol, energy, uAmbSeed[ch], speed);
        }
        else if (at == TYPE_VORTEX) {
            amb += vortexAmbient(uv, uAmbPos[ch], acol, energy, uAmbSeed[ch], speed);
        }
        else if (at == TYPE_SOUNDWAVE) {
            if (ch == 0) amb += soundwave0(uv, uAmbPos[ch], acol, energy);
            else if (ch == 1) amb += soundwave1(uv, uAmbPos[ch], acol, energy);
            else if (ch == 2) amb += soundwave2(uv, uAmbPos[ch], acol, energy);
            else if (ch == 3) amb += soundwave3(uv, uAmbPos[ch], acol, energy);
            else if (ch == 4) amb += soundwave4(uv, uAmbPos[ch], acol, energy);
            else if (ch == 5) amb += soundwave5(uv, uAmbPos[ch], acol, energy);
            else if (ch == 6) amb += soundwave6(uv, uAmbPos[ch], acol, energy);
            else amb += soundwave7(uv, uAmbPos[ch], acol, energy);
        }

    }
    color += amb.rgb;
    alpha = min(1.0, alpha + amb.a);

    if (alpha < 0.002) {
        gl_FragColor = vec4(0.0);
        return;
    }
    gl_FragColor = vec4(color, alpha);
}
`;

    function clamp(v, a, b) {
        v = Number(v);
        if (isNaN(v)) v = a;
        return Math.max(a, Math.min(b, v));
    }

    function reducedMotion() {
        try {
            return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        } catch (e) {
            return false;
        }
    }

    function audioTime() {
        try {
            if (window.MusicSequencer && typeof window.MusicSequencer.getAudioTime === "function") {
                var t = Number(window.MusicSequencer.getAudioTime());
                if (isFinite(t)) return t;
            }
        } catch (e) {}
        return window.performance ? performance.now() / 1000 : Date.now() / 1000;
    }

    function chatHost() {
        return document.getElementById("chat-window") || document.getElementById("messages");
    }

    function hostLayer() {
        var host = chatHost();
        if (!host) return null;
        if (getComputedStyle(host).position === "static") host.style.position = "relative";
        var layers = host.querySelectorAll(".msq-viz");
        var layer = layers.length ? layers[layers.length - 1] : null;
        for (var i = 0; i < layers.length - 1; i++) {
            if (layers[i] !== layer && layers[i].parentElement === host) host.removeChild(layers[i]);
        }
        if (!layer) {
            layer = document.createElement("div");
            layer.className = "msq-viz";
            host.appendChild(layer);
        }
        return layer;
    }

    function observeLayer(layer) {
        if (!window.ResizeObserver) return;
        try {
            if (!ro) ro = new ResizeObserver(function () { resize(); });
            ro.disconnect();
            ro.observe(layer);
        } catch (e) {}
    }

    function parseHex(value) {
        var m = /^#([0-9a-f]{3})$/i.exec(value);
        if (m) {
            var h = m[1];
            return [parseInt(h[0], 16) / 15, parseInt(h[1], 16) / 15, parseInt(h[2], 16) / 15];
        }
        m = /^#([0-9a-f]{6})$/i.exec(value);
        if (!m) return null;
        var v = m[1];
        return [parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255];
    }

    function probeColor(value) {
        if (!document.body) return null;
        if (!probe) {
            probe = document.createElement("span");
            probe.style.position = "fixed";
            probe.style.visibility = "hidden";
            probe.style.pointerEvents = "none";
            document.body.appendChild(probe);
        }
        probe.style.color = "";
        probe.style.color = value;
        var computed = getComputedStyle(probe).color;
        var m = /rgba?\(([^)]+)\)/.exec(computed);
        if (!m) return null;
        var parts = m[1].split(/[,\s\/]+/).filter(function (x) { return x.length > 0; });
        if (parts.length < 3) return null;
        return [parseFloat(parts[0]) / 255, parseFloat(parts[1]) / 255, parseFloat(parts[2]) / 255];
    }

    function cssColor(value) {
        if (value == null) return null;
        var key = String(value).trim().toLowerCase();
        if (!key) return null;
        if (colorCache.has(key)) return colorCache.get(key);
        var parsed = parseHex(key) || probeColor(key);
        if (!parsed) return null;
        parsed = [clamp(parsed[0], 0, 1), clamp(parsed[1], 0, 1), clamp(parsed[2], 0, 1)];
        colorCache.set(key, parsed);
        return parsed;
    }

    function cssVar(name, fallback) {
        var val = "";
        try { val = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch (e) {}
        if (!val) {
            try { val = getComputedStyle(document.body).getPropertyValue(name).trim(); } catch (e) {}
        }
        return val || fallback;
    }

    function accentColor() {
        var now = Date.now();
        if (!accentCache || now - accentFetchedAt > 1000) {
            accentCache = cssColor(cssVar("--accent", "#f72585")) || defaultAccent;
            accentFetchedAt = now;
        }
        return accentCache;
    }

    function resolveColor(value) {
        var c = cssColor(value);
        return c || accentColor();
    }

    function resize() {
        if (!canvas) return;
        var layer = canvas.parentElement || hostLayer();
        if (!layer) return;
        var w = layer.clientWidth || chatHost().clientWidth || 0;
        var h = layer.clientHeight || chatHost().clientHeight || 0;
        if (!w || !h) {
            canvas.width = 0;
            canvas.height = 0;
            return;
        }
        var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        var cw = Math.max(1, Math.floor(w * dpr));
        var ch = Math.max(1, Math.floor(h * dpr));
        if (canvas.width !== cw || canvas.height !== ch) {
            canvas.width = cw;
            canvas.height = ch;
            canvas.style.width = "100%";
            canvas.style.height = "100%";
            if (gl) gl.viewport(0, 0, cw, ch);
        }
    }

    function compileShader(type, source) {
        var s = gl.createShader(type);
        gl.shaderSource(s, source);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            var log = gl.getShaderInfoLog(s);
            gl.deleteShader(s);
            throw new Error(log || "Shader compile failed");
        }
        return s;
    }

    function buildProgram() {
        var vertex = compileShader(gl.VERTEX_SHADER, vs);
        var fragment = compileShader(gl.FRAGMENT_SHADER, fs);
        program = gl.createProgram();
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.linkProgram(program);
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(program) || "Program link failed");
        }
        gl.useProgram(program);
        loc.position = gl.getAttribLocation(program, "aPos");
        loc.count = gl.getUniformLocation(program, "uCount");
        loc.time = gl.getUniformLocation(program, "uTime");
        loc.res = gl.getUniformLocation(program, "uRes");
        loc.life = gl.getUniformLocation(program, "uLife[0]");
        loc.center = gl.getUniformLocation(program, "uCenter[0]");
        loc.color = gl.getUniformLocation(program, "uColor[0]");
        loc.param = gl.getUniformLocation(program, "uParam[0]");
        loc.type = gl.getUniformLocation(program, "uType[0]");
        loc.accent = gl.getUniformLocation(program, "uAccent");
        loc.fogAmount = gl.getUniformLocation(program, "uFogAmount");
        loc.bpm = gl.getUniformLocation(program, "uBpm");
        loc.beat = gl.getUniformLocation(program, "uBeat");
        loc.ambCount = gl.getUniformLocation(program, "uAmbCount");
        loc.ambType = gl.getUniformLocation(program, "uAmbType[0]");
        loc.ambPos = gl.getUniformLocation(program, "uAmbPos[0]");
        loc.ambColor = gl.getUniformLocation(program, "uAmbColor[0]");
        loc.ambEnergy = gl.getUniformLocation(program, "uAmbEnergy[0]");
        loc.ambSeed = gl.getUniformLocation(program, "uAmbSeed[0]");
        loc.ambSpeed = gl.getUniformLocation(program, "uAmbSpeed[0]");
        loc.soundBands = gl.getUniformLocation(program, "uSoundBands[0]");
        loc.ambLevel = gl.getUniformLocation(program, "uAmbLevel[0]");
        loc.wheelSeg = gl.getUniformLocation(program, "uWheelSeg[0]");
        loc.wheelSpin = gl.getUniformLocation(program, "uWheelSpin[0]");
        loc.wheelSize = gl.getUniformLocation(program, "uWheelSize[0]");
        loc.masterLevel = gl.getUniformLocation(program, "uMasterLevel");
        gl.enableVertexAttribArray(loc.position);
        buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.vertexAttribPointer(loc.position, 2, gl.FLOAT, false, 0, 0);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
    }

    function ensure() {
        var layer = hostLayer();
        if (!layer) return false;
        if (canvas && canvas.parentElement !== layer) {
            if (canvas.parentElement) canvas.parentElement.removeChild(canvas);
            canvas = null;
            gl = null;
            program = null;
            ready = false;
            supported = false;
        }
        if (ready) return supported;

        if (!canvas) {
            canvas = document.createElement("canvas");
            canvas.className = "msq-shader";
            layer.appendChild(canvas);
            canvas.addEventListener("webglcontextlost", function (e) {
                e.preventDefault();
                gl = null;
                program = null;
                supported = false;
                ready = true;
                lastError = "lost";
                events = [];
                dirty = false;
            }, false);
            canvas.addEventListener("webglcontextrestored", function () {
                ready = false;
                supported = false;
                lastError = null;
                ensure();
            }, false);
        } else {
            layer.appendChild(canvas);
        }

        if (gl) return true;
        try {
            var opts = { alpha: true, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: "low-power" };
            gl = canvas.getContext("webgl", opts) || canvas.getContext("experimental-webgl", opts);
            if (!gl) throw new Error("WebGL is unavailable");
            buildProgram();
            resize();
            observeLayer(layer);
            supported = true;
            ready = true;
            lastError = null;
            return true;
        } catch (e) {
            gl = null;
            program = null;
            supported = false;
            ready = true;
            lastError = e && e.message ? String(e.message) : "WebGL init failed";
            return false;
        }
    }

    function stableSeed(value) {
        var h = 2166136261;
        var s = String(value || "");
        for (var i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0) / 4294967295;
    }

    function findAmbient(name, type) {
        var key = type + ":" + String(name || "");
        for (var i = 0; i < ambient.length; i++) {
            if (ambient[i].key === key) return i;
        }
        for (var j = 0; j < ambient.length; j++) {
            if (ambient[j].type === type) return j;
        }
        return -1;
    }

    function setAmbient(list) {
        var old = new Map();
        for (var i = 0; i < ambient.length; i++) old.set(ambient[i].key, ambient[i]);
        var next = [];
        var items = Array.isArray(list) ? list : [];
        for (var k = 0; k < items.length && next.length < MAX_AMBIENT; k++) {
            var item = items[k] || {};
            var type = AMBIENT[String(item.effect || "").toLowerCase()];
            if (!type) continue;
            var name = String(item.name || "");
            var key = type + ":" + name;
            var prev = old.get(key);
            var seed = Number(item.seed);
            if (!(seed >= 0 && seed <= 1)) seed = stableSeed(name);
            var x = Number(item.x);
            var y = Number(item.y);
            var isWheel = type === AMBIENT.wheel;
            next.push({
                key: key,
                type: type,
                name: name,
                x: isWheel ? 0.5 : (isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5),
                y: isWheel ? 0.55 : (isFinite(y) ? Math.max(0, Math.min(1, y)) : 0.55),
                color: item.color == null ? null : String(item.color),
                seed: seed,
                speed: Math.max(0.02, Math.min(8, Number(item.speed) || 1)),
                energy: prev ? prev.energy : 0.18,
                spin: prev ? prev.spin : 0,
                spinVel: prev ? prev.spinVel : 0,
                rotInit: prev ? prev.rotInit : false,
                size: 1
            });
        }
        /* wheels all sit centered, so they nest: sizes shrink by a fixed
           factor per wheel (band annuli 0.28..0.49 of the scaled radius, so a
           ratio under 1/1.75 can never touch the next ring) with a little
           name-stable jitter. random starting angle per wheel. */
        var wheelK = 0;
        for (var w = 0; w < next.length; w++) {
            if (next[w].type !== AMBIENT.wheel) continue;
            next[w].size = 0.95 * Math.pow(0.5, wheelK) * (0.93 + 0.14 * stableSeed(next[w].name + "|size"));
            if (!next[w].rotInit) {
                next[w].spin = Math.random() * Math.PI * 2;
                next[w].rotInit = true;
            }
            wheelK++;
        }
        ambient = next;
        dirty = true;
        return true;
    }

    /* host pushes each scheduled kick's exact audio-clock time here; the
       render loop turns it into the next segment step when the moment hits */
    function wheelKick(when) {
        var t = Number(when);
        if (!(t > 0)) return false;
        kickTimes.push(t);
        kickTimes.sort(function (a, b) { return a - b; });
        if (kickTimes.length > 64) kickTimes.shift();
        return true;
    }

    function wheelHit(name, midi, vel, dur) {
        var m = Math.round(Number(midi));
        if (!(m >= 0)) return false;
        var v = Number(vel);
        if (!(v >= 0)) v = 0.8;
        var hold = Number(dur);
        if (!(hold > 0)) hold = 0.25;
        var until = audioTime() + Math.min(6, hold);
        var pc = ((m % 12) + 12) % 12;
        for (var i = 0; i < ambient.length; i++) {
            if (ambient[i].type !== AMBIENT.wheel) continue;
            if (String(ambient[i].name || "") !== String(name || "")) continue;
            var base = i * WHEEL_SEGS;
            var lit = clamp(0.6 + v * 0.4, 0, 1);
            if (wheelData[base + pc] < lit) wheelData[base + pc] = lit;
            if (wheelHold[base + pc] < until) wheelHold[base + pc] = until;
            ambient[i].energy = Math.max(ambient[i].energy, 0.55);
            dirty = true;
            return true;
        }
        return false;
    }

    function flashAmbient(name, effect, vel, midi, dur) {
        if (!enabled) return false;
        var type = AMBIENT[String(effect || "").toLowerCase()];
        if (!type) return false;
        if (type === AMBIENT.wheel) return wheelHit(name, midi, vel, dur);
        var idx = findAmbient(name, type);
        if (idx < 0) return false;
        var v = Number(vel);
        if (!(v >= 0)) v = 0.75;
        ambient[idx].energy = Math.max(ambient[idx].energy, clamp(0.35 + v, 0.25, 1.45));
        dirty = true;
        return true;
    }

    function clearAmbient() {
        ambient = [];
        kickTimes.length = 0;
        for (var i = 0; i < wheelData.length; i++) { wheelData[i] = 0; wheelHold[i] = 0; }
        for (var s = 0; s < wheelSpinData.length; s++) { wheelSpinData[s] = 0; wheelSizeData[s] = 1; }
        dirty = true;
    }

    function setTempo(value) {
        var v = Number(value);
        bpm = Math.max(1, Math.min(300, v || 120));
        dirty = true;
        return bpm;
    }

    function setAudioData(payload) {
        payload = payload || {};
        var i;
        for (i = 0; i < audioBands.length; i++) audioBands[i] = 0;
        var bands = payload.bands;
        if (bands && bands.length) {
            for (i = 0; i < Math.min(audioBands.length, bands.length); i++) audioBands[i] = clamp(bands[i], 0, 1);
        }
        for (i = 0; i < audioLevels.length; i++) audioLevels[i] = 0;
        var levels = payload.levels;
        if (levels && levels.length) {
            for (i = 0; i < Math.min(audioLevels.length, levels.length); i++) audioLevels[i] = clamp(levels[i], 0, 1);
        }
        masterLevel = clamp(payload.master, 0, 1) || 0;
        dirty = true;
        return true;
    }

    function clearCanvas() {
        if (!gl || !canvas || !canvas.width || !canvas.height) return;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    function cull(now) {
        var i = events.length;
        while (i--) {
            if (now - events[i].start > events[i].dur + 0.02) events.splice(i, 1);
        }
    }

    function trigger(effect, cell, color, dur, vel, source, voice, midi) {
        var name = String(effect || "").toLowerCase();
        if (AMBIENT[name]) {
            if (!enabled) return false;
            return flashAmbient(String(voice || ""), name, vel, midi, dur);
        }
        if (!TYPES[name]) return false;
        if (!enabled) return false;
        if (reducedMotion()) return true;
        if (!ensure() || !supported) return false;

        var now = audioTime();
        cull(now);
        if (events.length >= MAX_EVENTS) events.shift();

        var cx = cell && cell.x != null ? clamp(Number(cell.x) / 100, 0, 1) : 0.5;
        var cy = cell && cell.y != null ? clamp(Number(cell.y) / 100, 0, 1) : 0.56;
        var base = DEFAULT_DUR[name] || 0.65;
        var d = Number(dur);
        var duration = d > 0 ? Math.max(0.16, Math.min(2.4, base * 0.65 + d * 0.85)) : base;
        if (name === "laser") duration = 0.11 + Math.random() * 0.07;
        if (name === "pulse") duration = Math.min(duration, 0.65);
        var v = Number(vel);
        if (!(v >= 0)) v = 0.75;
        v = clamp(v, 0, 1);
        var strength = clamp(0.28 + v * 0.88, 0.15, 1.15);
        var param = [0, 0, 0, 0];

        if (name === "laser") {
            var x0 = Math.random() < 0.5 ? 0 : 1;
            var targetBottom = 1 - cy;
            var dx = cx - x0;
            var dy = targetBottom - 1;
            param[0] = Math.atan2(dy, dx) + (Math.random() * 2 - 1) * (Math.PI / 12);
            param[1] = x0;
            param[2] = 1;
        }

        events.push({
            type: TYPES[name],
            start: now,
            dur: duration,
            seed: Math.random(),
            strength: strength,
            cx: cx,
            cy: cy,
            color: color,
            param: param,
            source: source == null ? "" : String(source)
        });
        dirty = true;
        return true;
    }

    function render() {
        if (!enabled || !gl || !program) return;
        if (reducedMotion()) {
            if (dirty) clear();
            return;
        }
        if (!canvas.width || !canvas.height) resize();
        var now = audioTime();
        var dt = Math.max(0, Math.min(0.12, now - (lastRender || now)));
        lastRender = now;
        cull(now);
        for (var ai = 0; ai < ambient.length; ai++) {
            ambient[ai].energy = Math.max(0, ambient[ai].energy - dt * 2.4);
        }
        for (var wi = 0; wi < wheelData.length; wi++) {
            if (wheelHold[wi] > now) continue;
            var wv = wheelData[wi] * (1.0 - dt * 3.2);
            wheelData[wi] = wv < 0.003 ? 0 : wv;
        }
        /* kick-synced wheel spin: each kick impulse moves the wheel exactly
           one segment (tau/12) over its decay, timed to the beat length, so
           the wheel steps along with the kick and eases to a stop when the
           kicks stop */
        var beatDur = 60 / Math.max(1, bpm);
        var spinDecay = 3.2 / beatDur;
        for (var si = 0; si < ambient.length; si++) {
            var sw = ambient[si];
            if (sw.type !== AMBIENT.wheel) continue;
            while (kickTimes.length && kickTimes[0] <= now + 0.02) {
                kickTimes.shift();
                sw.spinVel = (Math.PI / 6.0) * spinDecay;
            }
            sw.spinVel *= Math.exp(-dt * spinDecay);
            sw.spin += sw.spinVel * dt;
        }
        var fogAmount = fogEnabled ? clamp(fogIntensity, 0, 2) : 0;
        var ambN = Math.min(ambient.length, MAX_AMBIENT);
        if (!events.length && fogAmount <= 0 && ambN <= 0) {
            if (dirty) {
                clearCanvas();
                dirty = false;
            }
            return;
        }
        if (!canvas.width || !canvas.height) return;

        var n = Math.min(events.length, MAX_EVENTS);
        for (var i = 0; i < n; i++) {
            var e = events[i];
            var c = resolveColor(e.color);
            lifeData[i * 4] = e.start;
            lifeData[i * 4 + 1] = e.dur;
            lifeData[i * 4 + 2] = e.seed;
            lifeData[i * 4 + 3] = e.strength;
            centerData[i * 2] = e.cx;
            centerData[i * 2 + 1] = e.cy;
            colorData[i * 3] = c[0];
            colorData[i * 3 + 1] = c[1];
            colorData[i * 3 + 2] = c[2];
            paramData[i * 4] = e.param[0];
            paramData[i * 4 + 1] = e.param[1];
            paramData[i * 4 + 2] = e.param[2];
            paramData[i * 4 + 3] = 0;
            typeData[i] = e.type;
        }
        for (var j = 0; j < ambN; j++) {
            var a = ambient[j];
            var ac = resolveColor(a.color);
            ambTypeData[j] = a.type;
            ambPosData[j * 2] = a.x;
            ambPosData[j * 2 + 1] = 1.0 - a.y;
            ambColorData[j * 3] = ac[0];
            ambColorData[j * 3 + 1] = ac[1];
            ambColorData[j * 3 + 2] = ac[2];
            ambEnergyData[j] = a.energy;
            ambSeedData[j] = a.seed;
            ambSpeedData[j] = a.speed;
            if (a.type === AMBIENT.wheel) {
                wheelSpinData[j] = a.spin || 0;
                wheelSizeData[j] = a.size > 0 ? a.size : 1;
            } else {
                wheelSizeData[j] = 1;
            }
        }

        gl.viewport(0, 0, canvas.width, canvas.height);
        clearCanvas();
        gl.useProgram(program);
        gl.uniform1i(loc.count, n);
        gl.uniform1f(loc.time, now);
        gl.uniform2f(loc.res, canvas.width, canvas.height);
        gl.uniform3fv(loc.accent, resolveColor(null));
        gl.uniform1f(loc.fogAmount, fogAmount);
        gl.uniform4fv(loc.life, lifeData);
        gl.uniform2fv(loc.center, centerData);
        gl.uniform3fv(loc.color, colorData);
        gl.uniform4fv(loc.param, paramData);
        gl.uniform1iv(loc.type, typeData);
        gl.uniform1f(loc.bpm, bpm);
        gl.uniform1f(loc.beat, now * Math.max(1, bpm) / 60);
        gl.uniform1i(loc.ambCount, ambN);
        gl.uniform1iv(loc.ambType, ambTypeData);
        gl.uniform2fv(loc.ambPos, ambPosData);
        gl.uniform3fv(loc.ambColor, ambColorData);
        gl.uniform1fv(loc.ambEnergy, ambEnergyData);
        gl.uniform1fv(loc.ambSeed, ambSeedData);
        gl.uniform1fv(loc.ambSpeed, ambSpeedData);
        gl.uniform1fv(loc.soundBands, audioBands);
        gl.uniform1fv(loc.ambLevel, audioLevels);
        gl.uniform1fv(loc.wheelSeg, wheelData);
        gl.uniform1fv(loc.wheelSpin, wheelSpinData);
        gl.uniform1fv(loc.wheelSize, wheelSizeData);
        gl.uniform1f(loc.masterLevel, masterLevel);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        dirty = true;
    }

    function remove(source) {
        var id = String(source || "");
        if (!id) {
            clear();
            return;
        }
        var n = events.length;
        events = events.filter(function (e) { return String(e.source || "") !== id; });
        if (events.length !== n) dirty = true;
    }

    function clear() {
        events.length = 0;
        dirty = false;
        clearCanvas();
    }

    window.MusicSequencerShaderFx = {
        ensure: ensure,
        trigger: trigger,
        render: render,
        clear: clear,
        remove: remove,
        setAmbient: setAmbient,
        flashAmbient: flashAmbient,
        clearAmbient: clearAmbient,
        wheelKick: wheelKick,
        setTempo: setTempo,
        setAudioData: setAudioData,
        setEnabled: function (on) {
            enabled = !!on;
            if (!enabled) clear();
            return enabled;
        },
        isEnabled: function () { return enabled; },
        names: function () { return Object.keys(TYPES).concat(Object.keys(AMBIENT)); },
        setFogEnabled: function (on) {
            fogEnabled = !!on;
            dirty = true;
            return fogEnabled;
        },
        isFogEnabled: function () { return fogEnabled; },
        setFogIntensity: function (value) {
            fogIntensity = clamp(value, 0, 2);
            dirty = true;
            return fogIntensity;
        },
        diag: function () {
            return {
                ready: ready,
                supported: supported,
                enabled: enabled && supported,
                activeEvents: events.length,
                ambient: ambient.length,
                bpm: bpm,
                masterLevel: masterLevel,
                dirty: dirty,
                fogEnabled: fogEnabled,
                fogIntensity: fogIntensity,
                canvas: canvas ? { width: canvas.width, height: canvas.height, attached: !!canvas.parentElement } : null,
                error: lastError
            };
        }
    };
})();
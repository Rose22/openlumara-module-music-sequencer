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
        strobe: 13
    };
    var DEFAULT_DUR = {
        flash: 0.45,
        bloom: 0.80,
        spark: 0.50,
        tick: 0.26,
        laser: 0.18,
        ripple: 0.90,
        wave: 0.90,
        plasma: 1.35,
        aurora: 1.80,
        prism: 0.85,
        strobe: 0.55
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
    float len = 0.035 + 0.30 * ease(t);
    float yy = 1.0 - uv.y;
    float x = abs(uv.x - raw.x);
    float start = smoothstep(-0.06, 0.025, yy);
    float end = 1.0 - smoothstep(max(0.0, len - 0.075), len + 0.055, yy);
    float band = exp(-pow(x / 0.022, 2.0)) * start * end;
    float flick = fogShimmer(uTime * 16.0 + x * 80.0 + seed * TAU);
    return fogScatter(col, band * (1.0 - t) * strength * fog * flick, 3.1, 0.58);
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
    float len = 0.035 + 0.30 * ease(t);
    float yy = 1.0 - uv.y;
    float x = abs(uv.x - raw.x);
    float start = smoothstep(-0.02, 0.018, yy);
    float end = 1.0 - smoothstep(max(0.0, len - 0.045), len, yy);
    float ym = start * end;
    float xm = exp(-pow(x / 0.0042, 2.0));
    float flick = 0.78 + 0.22 * sin(uTime * 72.0 + x * 520.0 + seed * TAU);
    float a = clamp(xm * ym * (1.0 - t) * flick * strength * 1.15, 0.0, 1.0);
    vec3 outc = mix(vec3(1.0), col, 0.65) * a;
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

        color += fx.rgb + fogFx.rgb;
        alpha = min(1.0, alpha + fx.a + fogFx.a);
    }

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

    function trigger(effect, cell, color, dur, vel, source) {
        var name = String(effect || "").toLowerCase();
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
        cull(now);
        var fogAmount = fogEnabled ? clamp(fogIntensity, 0, 2) : 0;
        if (!events.length && fogAmount <= 0) {
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
        setEnabled: function (on) {
            enabled = !!on;
            if (!enabled) clear();
            return enabled;
        },
        isEnabled: function () { return enabled; },
        names: function () { return Object.keys(TYPES); },
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
                dirty: dirty,
                fogEnabled: fogEnabled,
                fogIntensity: fogIntensity,
                canvas: canvas ? { width: canvas.width, height: canvas.height, attached: !!canvas.parentElement } : null,
                error: lastError
            };
        }
    };
})();
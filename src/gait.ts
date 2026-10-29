// gait.ts - the one source of truth for the gecko's motion.
//
// A straight port of the geometry pass of gecko_wireframe.glsl (vertex positions, camera, projection)
// plus the event channels that the TouchDesigner project computed in the gecko_mod Text DAT.
// Everything is a pure function of time, so the audio scheduler can ask "when does the next foot
// land?" and get an exact answer instead of watching for an edge at frame rate.

import { params as P } from './params';

export const NS = 22;            // body rings
export const NV = 214;           // 0..131 body | 132,133 eyes | 134..137 pupils | 138..141 tongue | 142..213 legs
export const DUTY = 0.62;        // fraction of a gait cycle the foot is on the ground
export const LEG_OFF = [0.0, 0.5, 0.5, 0.0] as const;   // fl, fr, hl, hr: diagonal trot, FL+HR together, FR+HL together
export const LEGS = ['fl', 'fr', 'hl', 'hr'] as const;
export type Leg = typeof LEGS[number];

const SA = [0.00, 0.10, 0.24, 0.40, 0.55, 0.70, 0.90, 1.10, 1.30, 1.50, 1.70, 1.85, 2.05, 2.30, 2.55, 2.80, 3.05, 3.30, 3.55, 3.80, 4.05, 4.30];
const SW = [0.05, 0.11, 0.17, 0.20, 0.13, 0.18, 0.22, 0.23, 0.23, 0.22, 0.21, 0.18, 0.14, 0.12, 0.10, 0.085, 0.07, 0.058, 0.046, 0.035, 0.022, 0.008];
const SH = [0.04, 0.07, 0.09, 0.10, 0.08, 0.10, 0.12, 0.13, 0.13, 0.12, 0.12, 0.10, 0.09, 0.08, 0.07, 0.06, 0.05, 0.042, 0.035, 0.027, 0.018, 0.008];
const RING: [number, number][] = [[1.0, 0.0], [0.5, 0.866], [-0.5, 0.866], [-1.0, 0.0], [-0.5, -0.866], [0.5, -0.866]];
const TLEN = [0.11, 0.15, 0.17, 0.16, 0.12];

const TAU = Math.PI * 2;

// ---------------------------------------------------------------- tiny vec3
export interface V3 { x: number; y: number; z: number }
const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
const add = (a: V3, b: V3) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: V3, b: V3) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a: V3, s: number) => v3(a.x * s, a.y * s, a.z * s);
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V3, b: V3) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a: V3) => Math.sqrt(dot(a, a));
const norm = (a: V3) => { const l = len(a) || 1e-9; return v3(a.x / l, a.y / l, a.z / l); };
const clamp = (x: number, a: number, b: number) => Math.min(Math.max(x, a), b);
const fract = (x: number) => x - Math.floor(x);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export function smoothstep(e0: number, e1: number, x: number) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- clock
export interface Gait { tt: number; gait: number; ph: number }

/** The three globals of the shader (gTT, gGait, gPh) for a given animation time in seconds. */
export function gaitAt(sec: number): Gait {
  const tt = sec * P.speed;
  const gait = P.stepHz * tt;
  return { tt, gait, ph: TAU * gait };
}

// ---------------------------------------------------------------- body
function centerAt(s: number, g: Gait): V3 {
  const a = SA[s];
  const amp = P.undul * (0.03 + 0.05 * smoothstep(0.5, 1.7, a) + 0.20 * smoothstep(1.2, 3.8, a));
  let z = amp * Math.sin(TAU * (a / 2.7) - g.ph);
  z += P.undul * 0.035 * Math.sin(g.ph + 0.8) * (1.0 - smoothstep(0.0, 0.8, a));   // head counter-sway
  const y = 0.15 + 0.055 * (1.0 - smoothstep(0.0, 0.75, a))
                 - 0.115 * smoothstep(1.8, 3.4, a)
                 + 0.012 * Math.sin(2.0 * g.ph + a * 2.0);
  return v3(1.6 - a, Math.max(y, 0.035), z);
}

interface Frame { c: V3; F: V3; side: V3; up: V3 }
function frame(s: number, g: Gait): Frame {
  const c = centerAt(s, g);
  const pA = centerAt(Math.max(s - 1, 0), g);
  const pB = centerAt(Math.min(s + 1, NS - 1), g);
  const F = norm(sub(pA, pB));
  const side = norm(cross(F, v3(0, 1, 0)));
  const up = cross(side, F);
  return { c, F, side, up };
}

function legVertex(l: number, v: number, g: Gait): V3 {
  const front = l < 2;
  const sgn = (l % 2) === 0 ? 1.0 : -1.0;
  const sIdx = front ? 5 : 10;

  const fr = frame(sIdx, g);
  const R = add(add(fr.c, mul(fr.side, sgn * SW[sIdx] * 0.88)), mul(fr.up, -SH[sIdx] * 0.35));
  if (v === 0) return R;

  const off = (l === 0 || l === 3) ? 0.0 : 0.5;
  const ph = fract(g.gait + off);
  const S = P.stride * 0.22;
  let xoff = 0, lift = 0, sw = 0;
  if (ph < DUTY) {
    const u = ph / DUTY;
    xoff = S * (1.0 - 2.0 * u);
  } else {
    const u = (ph - DUTY) / (1.0 - DUTY);
    const e = u * u * (3.0 - 2.0 * u);
    xoff = -S + 2.0 * S * e;
    sw = Math.sin(Math.PI * u);
    lift = P.stepLift * 0.09 * sw;
  }
  const T = v3(1.6 - SA[sIdx] + (front ? 0.10 : 0.02) + xoff, lift, sgn * (front ? 0.62 : 0.70));

  // 2-bone IK
  const pole = norm(v3(front ? -0.4 : 0.5, 0.8, sgn * 0.9));
  const l1 = front ? 0.30 : 0.36;
  const l2 = front ? 0.30 : 0.34;
  const dl = clamp(len(sub(T, R)), Math.abs(l1 - l2) + 0.01, l1 + l2 - 0.005);
  const dir = norm(sub(T, R));
  const a = (l1 * l1 - l2 * l2 + dl * dl) / (2.0 * dl);
  const h = Math.sqrt(Math.max(l1 * l1 - a * a, 0.0));
  let pp = sub(pole, mul(dir, dot(pole, dir)));
  pp = mul(pp, 1.0 / Math.max(len(pp), 1e-4));
  const elbow = add(add(R, mul(dir, a)), mul(pp, h));
  const wrist = add(R, mul(dir, dl));
  if (v === 1) return elbow;
  if (v === 2) return wrist;

  // toes: 5 per foot, 3 vertices each (base, knuckle, sticky tip pad)
  const t = Math.floor((v - 3) / 3);
  const part = (v - 3) % 3;
  const fd = front ? norm(v3(1.0, 0.0, sgn * 0.45)) : norm(v3(0.5, 0.0, sgn * 0.9));
  const ang = (t - 2.0) * 0.42;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const td = v3(fd.x * ca + fd.z * sa, 0.0, -fd.x * sa + fd.z * ca);
  const f = part === 0 ? 0.35 : (part === 1 ? 0.7 : 1.0);
  const pos = add(wrist, mul(td, 0.04 + TLEN[t] * f));
  pos.y = Math.max(wrist.y, 0.0) + sw * 0.07 * (0.3 + 0.7 * f) + 0.012 * f;   // toes curl up in swing
  return pos;
}

/** World-space position of vertex i plus its visibility (0 hides the tongue when retracted). */
export function vertex(i: number, g: Gait): { p: V3; vis: number } {
  let p: V3;
  let vis = 1.0;
  if (i < 132) {
    const s = Math.floor(i / 6);
    const k = i % 6;
    const fr = frame(s, g);
    const br = 1.0 + 0.03 * Math.sin(2.3 * g.tt + s * 0.4);          // breathing
    const uy = RING[k][0] < 0.0 ? 0.8 : 1.0;                            // flatter belly
    p = add(add(fr.c, mul(fr.side, SW[s] * br * RING[k][1])), mul(fr.up, SH[s] * br * RING[k][0] * uy));
  } else if (i < 134) {                                                 // eyes
    const sgn = i === 132 ? 1.0 : -1.0;
    const fr = frame(2, g);
    p = add(add(add(fr.c, mul(fr.side, sgn * SW[2] * 0.93)), mul(fr.up, SH[2] * 0.9)), mul(fr.F, 0.03));
  } else if (i < 138) {                                                 // slit pupils
    const j = Math.floor((i - 134) / 2);
    const w = (i - 134) % 2;
    const sgn = j === 0 ? 1.0 : -1.0;
    const fr = frame(2, g);
    p = add(add(add(fr.c, mul(fr.side, sgn * (SW[2] * 0.93 + 0.035))), mul(fr.up, SH[2] * 0.9 + (w === 0 ? 0.035 : -0.035))), mul(fr.F, 0.03));
  } else if (i < 142) {                                                 // tongue flick
    const m = i - 138;
    const fm = m / 3.0;
    const e = tongueAtGait(g);
    const fr = frame(0, g);
    const base = add(add(fr.c, mul(fr.F, 0.03)), mul(fr.up, -0.02));
    p = add(add(add(base, mul(fr.F, 0.02 + 0.62 * e * fm)), mul(fr.up, -(0.03 * e * fm))), mul(fr.side, 0.05 * e * fm * Math.sin(fm * 6.0 + g.tt * 18.0)));
    vis = e >= 0.04 ? 1.0 : 0.0;
  } else {
    p = legVertex(Math.floor((i - 142) / 18), (i - 142) % 18, g);
  }
  return { p, vis };
}

// ---------------------------------------------------------------- camera + projection
export interface Camera { cam: V3; fwd: V3; r2: V3; u2: V3; dist: number }

/** The automatic orbit plus the user's drag offset (orbit.ts). */
function orbitYaw(tt: number): number {
  return (P.yaw0 + P.userYaw) * Math.PI / 180 + TAU * P.orbit * tt + 0.35 * Math.sin(0.13 * tt);
}

export function cameraAt(g: Gait): Camera {
  const tt = g.tt;
  const yaw = orbitYaw(tt);
  const elev = clamp((P.camElev + P.userElev) * Math.PI / 180 + 0.28 * Math.sin(0.17 * tt + 1.0), -80 * Math.PI / 180, 85 * Math.PI / 180);
  const dist = P.camDist * (1.0 + 0.12 * Math.sin(0.21 * tt + 2.0)) * P.zoom;
  const target = add(v3(0.1, 0.12, 0.0), v3(0.15 * Math.sin(0.23 * tt), 0.03 * Math.sin(0.31 * tt), 0.12 * Math.cos(0.19 * tt)));
  const shake = mul(v3(Math.sin(7.1 * tt) + 0.5 * Math.sin(13.7 * tt), Math.sin(8.3 * tt + 1.0), Math.sin(6.7 * tt + 2.0)), P.camShake * 0.012);
  const cam = add(add(target, mul(v3(Math.cos(elev) * Math.cos(yaw), Math.sin(elev), Math.cos(elev) * Math.sin(yaw)), dist)), shake);
  const fwd = norm(sub(target, cam));
  const rgt = norm(cross(fwd, v3(0, 1, 0)));
  const upv = cross(rgt, fwd);
  const roll = P.camShake * 0.04 * Math.sin(0.27 * tt + 0.5);
  const r2 = add(mul(rgt, Math.cos(roll)), mul(upv, Math.sin(roll)));
  const u2 = add(mul(rgt, -Math.sin(roll)), mul(upv, Math.cos(roll)));
  return { cam, fwd, r2, u2, dist };
}

/** Screen-space vertex: x, y in px (origin bottom-left), g = visibility * depth brightness, w = perspective scale. */
export interface Projected { x: number; y: number; g: number; w: number }

export function projectP(p: V3, vis: number, c: Camera, resW: number, resH: number): Projected {
  const rel = sub(p, c.cam);
  const pcx = dot(rel, c.r2), pcy = dot(rel, c.u2), pcz = dot(rel, c.fwd);
  const z = Math.max(pcz, 0.2);
  const sx = pcx / z * P.focal * resH * 0.5 + P.centerX * resW;
  const sy = pcy / z * P.focal * resH * 0.5 + P.centerY * resH;
  const g = mix(P.depthDim, 1.0, 1.0 - smoothstep(c.dist - 1.6, c.dist + 2.4, pcz)) * vis;
  return { x: sx, y: sy, g, w: c.dist / z };
}

/** All NV vertices projected for one frame, packed as [x, y, g, w] per vertex (the bake texture of the shader). */
export function bake(sec: number, resW: number, resH: number, out?: Float32Array): Float32Array {
  const g = gaitAt(sec);
  const cam = cameraAt(g);
  const o = out ?? new Float32Array(NV * 4);
  for (let i = 0; i < NV; i++) {
    const v = vertex(i, g);
    const s = projectP(v.p, v.vis, cam, resW, resH);
    o[i * 4] = s.x; o[i * 4 + 1] = s.y; o[i * 4 + 2] = s.g; o[i * 4 + 3] = s.w;
  }
  return o;
}

// ---------------------------------------------------------------- event channels (0..1), as in gecko_events
export function gaitPhase(sec: number, off = 0): number {
  return fract(sec * P.speed * P.stepHz + off);
}
export function contact(sec: number, leg: number): number {
  return gaitPhase(sec, LEG_OFF[leg]) < DUTY ? 1 : 0;
}
/** 0 on the ground, sine bump in the air (the 'sw' of legVertex). */
export function swing(sec: number, leg: number): number {
  const p = gaitPhase(sec, LEG_OFF[leg]);
  return p < DUTY ? 0 : Math.sin(Math.PI * (p - DUTY) / (1.0 - DUTY));
}
export function swingMax(sec: number): number {
  let m = 0;
  for (let l = 0; l < 4; l++) m = Math.max(m, swing(sec, l));
  return m;
}
function tongueAtGait(g: Gait): number {
  return P.tongue * Math.pow(Math.max(0.0, Math.sin(0.55 * g.tt + 1.0)), 12.0);
}
/** Tongue extension 0..1; out (> 0.04) for ~2.5 s every 11.4 s. */
export function tongue(sec: number): number { return tongueAtGait(gaitAt(sec)); }
export const TONGUE_GATE = 0.04;
export function breath(sec: number): number { return 0.5 + 0.5 * Math.sin(2.3 * sec * P.speed); }
export function spine(sec: number): number { return 0.5 + 0.5 * Math.sin(TAU * gaitPhase(sec)); }
/** Tail tip left..right (centerAt(21).z normalised), one swing per gait cycle. */
export function tail(sec: number): number { return 0.5 + 0.5 * Math.sin(TAU * (4.30 / 2.7) - TAU * gaitPhase(sec)); }
/** Camera dolly 0 = closest .. 1 = farthest: the 30 s sine, shifted by the user's zoom and clamped. */
export function camDist(sec: number): number {
  const d = (1.0 + 0.12 * Math.sin(0.21 * sec * P.speed + 2.0)) * P.zoom;   // actual distance / camDist
  return clamp((d - 0.88) / 0.24, 0, 1);
}
/** Camera side 0 = left .. 1 = right (sin of the orbit yaw, ~33 s). */
export function camYaw(sec: number): number {
  return 0.5 + 0.5 * Math.sin(orbitYaw(sec * P.speed));
}

// ---------------------------------------------------------------- event times (closed form, for the scheduler)
/** Times in (from, to] at which fract(rate * sec + off) wraps to 0, i.e. sec = (n - off) / rate. */
export function wrapTimes(from: number, to: number, rate: number, off: number): number[] {
  const out: number[] = [];
  if (rate <= 0) return out;
  let n = Math.floor(from * rate + off) + 1;
  for (; ; n++) {
    const t = (n - off) / rate;
    if (t > to) break;
    if (t > from) out.push(t);
  }
  return out;
}
/** Landings of the given leg in (from, to]. */
export function landings(from: number, to: number, leg: number): number[] {
  return wrapTimes(from, to, P.speed * P.stepHz, LEG_OFF[leg]);
}
/** Hat ticks in (from, to]: hatDiv per gait cycle, phase-locked to the landings. */
export function hatTicks(from: number, to: number): number[] {
  return wrapTimes(from, to, P.speed * P.stepHz * P.hatDiv, 0);
}
/** Moments the tongue crosses the gate on its way out: sin(0.55 tt + 1) rises through gate^(1/12). */
export function tongueOnsets(from: number, to: number): number[] {
  const out: number[] = [];
  if (P.tongue <= 0) return out;
  const ratio = Math.pow(TONGUE_GATE / P.tongue, 1 / 12);
  if (ratio >= 1) return out;                                             // never reaches the gate
  const thr = Math.asin(ratio);                                           // phase where e == gate on the rising side
  const rate = 0.55 * P.speed;
  let n = Math.floor((from * rate + 1.0 - thr) / TAU) + 1;
  for (; ; n++) {
    const t = (thr - 1.0 + TAU * n) / rate;
    if (t > to) break;
    if (t > from) out.push(t);
  }
  return out;
}

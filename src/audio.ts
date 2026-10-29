// audio.ts - the dark drum & bass layer, built from Web Audio nodes (OscillatorNode, BiquadFilterNode,
// GainNode, WaveShaperNode, ChannelMerger) and driven by gait.ts.
//
// Timing: landings, hat ticks and tongue onsets are closed-form functions of time (gait.ts), so a
// lookahead scheduler books them on the AudioContext clock a quarter second ahead, sample-accurate.
// Continuous controls (tongue extension, breathing, tail, camera) are pushed once per animation
// frame with setTargetAtTime, which smooths the frame steps.
//
// Node for node this mirrors build_gecko_audio.py from the TouchDesigner project (same gains, same
// cutoffs, same ranges). The audio-rate ramp envelopes of that version, (1 - u)^n over one gait
// cycle restarted by each landing, are reproduced exactly with setValueCurveAtTime.

import * as G from './gait';
import { params as P } from './params';

export const LAYERS = ['kick', 'snare', 'hat', 'reese', 'sub', 'tongue', 'riser', 'pad'] as const;
export type Layer = typeof LAYERS[number];

const PAD_NOTES = [123.47, 164.81, 196.0, 246.94];     // B2 E3 G3 B3 = Em
const LOOKAHEAD = 0.25;                                  // seconds booked ahead
const TICK_MS = 60;                                      // scheduler period
const CURVE_N = 256;                                     // samples per envelope curve
const Q = (res: number) => 0.7071 + res * 2.5;           // TouchDesigner resonance 0..1 -> biquad Q

function noiseBuffer(ctx: AudioContext, seconds = 2): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}
/** WaveShaper curve. Input outside -1..1 is clamped by the node, which is exactly the Limit CHOP's clamp. */
function shaperCurve(fn: (x: number) => number, n = 4096): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
  return c;
}
/** Envelope curve over one ramp period, u = 0..1. */
function envCurve(fn: (u: number) => number): Float32Array<ArrayBuffer> {
  const c = new Float32Array(CURVE_N);
  for (let i = 0; i < CURVE_N; i++) c[i] = fn(i / (CURVE_N - 1));
  return c;
}
const pow = (u: number, n: number) => Math.pow(1 - u, n);   // the ramp_env of the TouchDesigner build raised to n

/** TouchDesigner pan2(): a 0..1 position becomes two gains, L = soft + (1 - soft)(1 - pos), R = soft + (1 - soft) pos.
 *  A linear pan law with a floor, so the mix is never fully one-sided. Not equal-power, hence not a StereoPannerNode. */
class Pan2 {
  readonly input: GainNode;
  readonly output: ChannelMergerNode;
  private l: GainNode; private r: GainNode;
  constructor(ctx: AudioContext, private soft: number) {
    this.input = ctx.createGain();
    this.l = ctx.createGain(); this.r = ctx.createGain();
    this.output = ctx.createChannelMerger(2);
    this.input.connect(this.l).connect(this.output, 0, 0);
    this.input.connect(this.r).connect(this.output, 0, 1);
    this.set(0.5, ctx.currentTime, 0);
  }
  set(pos: number, t: number, tc: number) {
    const l = this.soft + (1 - this.soft) * (1 - pos), r = this.soft + (1 - this.soft) * pos;
    if (tc > 0) { this.l.gain.setTargetAtTime(l, t, tc); this.r.gain.setTargetAtTime(r, t, tc); }
    else { this.l.gain.value = l; this.r.gain.value = r; }
  }
}

export class GeckoAudio {
  readonly ctx: AudioContext;
  private ctxT0: number;        // ctx.currentTime that corresponds to animation second sec0
  private sec0: number;
  private scheduledUntil: number;
  private timer: number | undefined;
  private nodes: AudioNode[] = [];
  private layerGain = new Map<Layer, GainNode>();
  private muted = new Set<Layer>();

  // things the scheduler and the per-frame update touch
  private kickAmp!: GainNode; private kickOsc!: OscillatorNode;
  private snareNoiseAmp!: GainNode; private snareBodyAmp!: GainNode; private snareBodyOsc!: OscillatorNode;
  private hatAmp!: GainNode;
  private duckK!: GainNode; private duckS!: GainNode;
  private reeseLp!: BiquadFilterNode;
  private tongueOscA!: OscillatorNode; private tongueOscB!: OscillatorNode; private stutterOsc!: OscillatorNode;
  private tongueLp!: BiquadFilterNode; private tongueSwell!: GainNode; private popAmp!: GainNode;
  private riserHp!: BiquadFilterNode; private riserAmp!: GainNode;
  private padTwins: OscillatorNode[] = []; private padLp!: BiquadFilterNode; private padLevel!: GainNode; private padPan!: Pan2;
  private masterLp!: BiquadFilterNode; private masterPan!: Pan2;
  readonly master: GainNode;

  // envelope shapes (TouchDesigner: power() of the ramp envelope, pitch = base * 2^(octaves * env))
  private readonly cKick4 = envCurve(u => pow(u, 4));                                   // kick_amp     ~400 ms boom
  private readonly cKickPitch = envCurve(u => 45 * Math.pow(2, 3.0 * pow(u, 16)));       // kick_pitch   3-octave snap
  private readonly cDuckK = envCurve(u => 1 - 0.85 * pow(u, 2));                         // duck_kick    1 -> 0.15 on the kick
  private readonly cSnare8 = envCurve(u => pow(u, 8));                                   // snare_amp
  private readonly cSnare16 = envCurve(u => pow(u, 16));                                 // snare_snap   body level
  private readonly cSnarePitch = envCurve(u => 170 * Math.pow(2, 1.5 * pow(u, 16)));     // snare_body_pitch
  private readonly cDuckS = envCurve(u => 1 - 0.45 * pow(u, 4));                         // duck_snare
  private readonly cHat8 = envCurve(u => pow(u, 8));                                     // hat_amp

  /** `sec` is the animation time at the moment of construction, so the clocks line up. */
  constructor(ctx: AudioContext, sec: number) {
    this.ctx = ctx;
    this.ctxT0 = ctx.currentTime;
    this.sec0 = sec;
    this.scheduledUntil = sec;
    this.master = ctx.createGain();
    this.build();
    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
  }

  dispose() {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    for (const n of this.nodes) { try { (n as AudioScheduledSourceNode).stop?.(); } catch { /* not a source */ } n.disconnect(); }
    this.master.disconnect();
  }

  // ------------------------------------------------------------ clocks
  toCtx(sec: number) { return this.ctxT0 + (sec - this.sec0); }
  toSec(ctxTime: number) { return this.sec0 + (ctxTime - this.ctxT0); }
  get sec() { return this.toSec(this.ctx.currentTime); }

  // ------------------------------------------------------------ helpers
  private src<T extends AudioScheduledSourceNode>(n: T): T { n.start(); this.nodes.push(n); return n; }
  private osc(type: OscillatorType, freq: number, detune = 0): OscillatorNode {
    const o = this.ctx.createOscillator(); o.type = type; o.frequency.value = freq; o.detune.value = detune;
    return this.src(o);
  }
  private noise(): AudioBufferSourceNode {
    const n = this.ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true;
    return this.src(n);
  }
  private gain(v: number): GainNode { const g = this.ctx.createGain(); g.gain.value = v; return g; }
  private filter(type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; return f;
  }
  private shaper(c: Float32Array<ArrayBuffer>): WaveShaperNode { const s = this.ctx.createWaveShaper(); s.curve = c; return s; }
  /** A DC offset + a modulator oscillator summed into an AudioParam (range = base +- depth), like a Math CHOP range map. */
  private modulate(param: AudioParam, base: number, type: OscillatorType, freq: number, depth: number): OscillatorNode {
    const dc = this.ctx.createConstantSource(); dc.offset.value = base; this.src(dc);
    const o = this.osc(type, freq);
    const d = this.gain(depth);
    o.connect(d); dc.connect(param); d.connect(param);
    param.value = 0;
    return o;
  }
  private chain(...nodes: AudioNode[]): AudioNode {
    for (let i = 0; i + 1 < nodes.length; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  }
  private layerOut(layer: Layer, gain: number): GainNode {
    const g = this.gain(gain); this.layerGain.set(layer, g); return g;
  }

  private noiseBuf!: AudioBuffer;
  private clipCurve = shaperCurve(x => x);                                          // identity inside, clamp outside = Limit CHOP
  // tongue_crush_up (gain 6) / floor / tongue_crush_down (gain 1/6) = ~3 bits. The tongue sum peaks at 1.3, beyond the
  // shaper's -1..1 input range, so the signal is scaled by 1/1.3 first and the curve crushes the unscaled value.
  private crushCurve = shaperCurve(u => Math.floor(7.8 * u) / 6);

  // ------------------------------------------------------------ the graph
  private build() {
    const ctx = this.ctx;
    this.noiseBuf = noiseBuffer(ctx);
    const mix = this.gain(1);                                                 // gecko_mix

    // --- 4. pump: duck = duck_kick * duck_snare, applied to reese_out and sub_out
    this.duckK = this.gain(1); this.duckS = this.gain(1);
    const bassBus = this.gain(1);
    this.chain(bassBus, this.duckK, this.duckS, mix);

    // --- 3. drums
    // kick: osc_kick sin 45 Hz (pitch = kick_snap * 3 oct) -> kick_vca (x kick_amp, gain 2.2) -> kick_clip -> kick_lp 900 res 0.1 -> kick_out 1.0
    this.kickOsc = this.osc('sine', 45);
    this.kickAmp = this.gain(0);
    const kickOut = this.layerOut('kick', 1.0);
    this.chain(this.kickOsc, this.kickAmp, this.gain(2.2), this.shaper(this.clipCurve), this.filter('lowpass', 900, Q(0.1)), kickOut);
    const drums = this.gain(1.4);                                             // drums_sum gain 1.4
    kickOut.connect(drums);

    // snare: noise -> snare_bp 1100 res 0.45 -> x snare_amp, gain 1.6 ; osc_snare_body sin 170 (pitch = snare_snap * 1.5 oct) -> x snare_snap, gain 1.2
    //        -> snare_sum gain 2.5 -> snare_clip -> snare_out 0.9
    this.snareNoiseAmp = this.gain(0);
    const snareSum = this.gain(2.5);
    this.chain(this.noise(), this.filter('bandpass', 1100, Q(0.45)), this.snareNoiseAmp, this.gain(1.6), snareSum);
    this.snareBodyOsc = this.osc('sine', 170);
    this.snareBodyAmp = this.gain(0);
    this.chain(this.snareBodyOsc, this.snareBodyAmp, this.gain(1.2), snareSum);
    const snareOut = this.layerOut('snare', 0.9);
    this.chain(snareSum, this.shaper(this.clipCurve), snareOut, drums);

    // hats: noise -> hat_hp 6500 res 0.3 -> x hat_amp, gain 0.14
    this.hatAmp = this.gain(0);
    const hatOut = this.layerOut('hat', 0.14);
    this.chain(this.noise(), this.filter('highpass', 6500, Q(0.3)), this.hatAmp, hatOut, drums);

    // drums_clip -> drums_out 0.8
    this.chain(drums, this.shaper(this.clipCurve), this.gain(0.8), mix);

    // --- 5. reese bass: ramp bass*2 (0.4) + ramp bass*2.012 (0.4) + square bass (0.3) -> reese_wobble_lp 160..420 by breath, res 0.3
    //        -> reese_drive x8 -> reese_clip -> reese_tame lp 3500 -> reese_out 0.6 -> duck
    const reese = this.gain(1);
    this.chain(this.osc('sawtooth', P.bassHz * 2.0), this.gain(0.4), reese);
    this.chain(this.osc('sawtooth', P.bassHz * 2.012), this.gain(0.4), reese);
    this.chain(this.osc('square', P.bassHz), this.gain(0.3), reese);
    this.reeseLp = this.filter('lowpass', 300, Q(0.3));
    const reeseOut = this.layerOut('reese', 0.6);
    this.chain(reese, this.reeseLp, this.gain(8.0), this.shaper(this.clipCurve), this.filter('lowpass', 3500, Q(0)), reeseOut, bassBus);

    // sub: osc_sub sin bass_hz (1.0) -> sub_out 0.6 -> duck
    const subOut = this.layerOut('sub', 0.6);
    this.chain(this.osc('sine', P.bassHz), subOut, bassBus);

    // --- 6. tongue: osc_tongue ramp 55 (0.8) + osc_tongue_b ramp 55.7 (0.5), pitch = tongue * 1.2 oct -> crush -> tongue_lp1 180..1200 res 0.15
    //        -> tongue_lp2 2500 -> x stutter_gate01 (tri 5 Hz * 2^(2 tongue), 0.1..1) -> x wiggle_trem (sin 2.86 Hz, 0.4..1) -> x sqrt(tongue), gain 0.9
    this.tongueOscA = this.osc('sawtooth', 55.0);
    this.tongueOscB = this.osc('sawtooth', 55.7);
    const tongueSum = this.gain(1);
    this.chain(this.tongueOscA, this.gain(0.8), tongueSum);
    this.chain(this.tongueOscB, this.gain(0.5), tongueSum);
    this.tongueLp = this.filter('lowpass', 600, Q(0.15));
    const stutter = this.gain(0);
    this.stutterOsc = this.modulate(stutter.gain, 0.55, 'triangle', 5.0, 0.45);
    const wiggle = this.gain(0);
    this.modulate(wiggle.gain, 0.7, 'sine', 2.86, 0.3);
    this.tongueSwell = this.gain(0);
    const tongueOut = this.layerOut('tongue', 1.0);
    this.chain(tongueSum, this.gain(1 / 1.3), this.shaper(this.crushCurve), this.tongueLp, this.filter('lowpass', 2500, Q(0)), stutter, wiggle, this.tongueSwell, tongueOut, mix);
    // tongue_pop: Trigger CHOP on tongue_gate (attack 2 ms to 1, decay 120 ms to sustain 0) x noise -> pop_hp 2500 res 0.5, gain 0.5
    this.popAmp = this.gain(0);
    this.chain(this.noise(), this.filter('highpass', 2500, Q(0.5)), this.popAmp, this.gain(0.5), tongueOut);

    // --- 7. riser: noise (0.5) -> riser_hp 300..5000 by swing_max, res 0 -> x swing_max, gain 0.08
    this.riserHp = this.filter('highpass', 300, Q(0));
    this.riserAmp = this.gain(0);
    const riserOut = this.layerOut('riser', 0.08);
    this.chain(this.noise(), this.gain(0.5), this.riserHp, this.riserAmp, riserOut, mix);

    // --- 8. pad: tri f (0.25) + tri f*1.0007 (0.25, pitch = tail +-0.0015 oct) per note -> pad_lp 1400..500 by cam_dist, res 0
    //        -> pad_level 1..0.6 by cam_dist -> pad_pan by cam_yaw (soft 0.3) -> pad_out 0.2
    const padSum = this.gain(1);
    for (const f of PAD_NOTES) {
      this.chain(this.osc('triangle', f), this.gain(0.25), padSum);
      const twin = this.osc('triangle', f * 1.0007);
      this.padTwins.push(twin);
      this.chain(twin, this.gain(0.25), padSum);
    }
    this.padLp = this.filter('lowpass', 800, Q(0));
    this.padLevel = this.gain(1);
    this.padPan = new Pan2(ctx, 0.3);
    const padOut = this.layerOut('pad', 0.2);
    this.chain(padSum, this.padLp, this.padLevel, this.padPan.input);
    this.chain(this.padPan.output, padOut, mix);

    // --- 9. master: gecko_mix -> master_lp 18000..3000 by cam_dist -> master_pan by tail (soft 0.5), gain 0.45 -> master_limit clamp -> out 0.8
    this.masterLp = this.filter('lowpass', 12000, Q(0));
    this.masterPan = new Pan2(ctx, 0.5);
    this.master.gain.value = 0.8;
    this.chain(mix, this.masterLp, this.masterPan.input);
    this.chain(this.masterPan.output, this.gain(0.45), this.shaper(this.clipCurve), this.master, ctx.destination);
  }

  // ------------------------------------------------------------ layer control
  setMuted(layer: Layer, muted: boolean) {
    const g = this.layerGain.get(layer)!;
    if (muted) this.muted.add(layer); else this.muted.delete(layer);
    g.gain.setTargetAtTime(muted ? 0 : this.layerDefault(layer), this.ctx.currentTime, 0.02);
  }
  isMuted(layer: Layer) { return this.muted.has(layer); }
  private layerDefault(layer: Layer): number {
    return ({ kick: 1.0, snare: 0.9, hat: 0.14, reese: 0.6, sub: 0.6, tongue: 1.0, riser: 0.08, pad: 0.2 } as Record<Layer, number>)[layer];
  }

  // ------------------------------------------------------------ events (sample-accurate)
  private schedule() {
    const now = this.sec;
    const from = Math.max(this.scheduledUntil, now - 0.05);
    const to = now + LOOKAHEAD;
    if (to <= from) return;
    const cyc = 1 / (P.speed * P.stepHz);                   // one gait cycle = the ramp period of env_kick / env_snare
    for (const t of G.landings(from, to, 0)) this.kick(this.toCtx(t), cyc);        // fl (+ hr) land together
    for (const t of G.landings(from, to, 1)) this.snare(this.toCtx(t), cyc);       // fr (+ hl)
    for (const t of G.hatTicks(from, to)) this.hat(this.toCtx(t), cyc / P.hatDiv); // env_hat ramp at step_hz * hat_div
    for (const t of G.tongueOnsets(from, to)) this.pop(this.toCtx(t));
    this.scheduledUntil = to;
  }

  /** Restart a ramp envelope at T: the curve spans one period (slightly less, so back-to-back events never overlap).
   *  If the step rate changed and the previous curve still runs into T, fall back to an exponential of similar length. */
  private ramp(p: AudioParam, curve: Float32Array<ArrayBuffer>, T: number, period: number) {
    p.cancelScheduledValues(T);
    try {
      p.setValueCurveAtTime(curve, T, period * 0.98);
    } catch {
      p.setValueAtTime(curve[0], T);
      p.setTargetAtTime(curve[curve.length - 1], T, period * 0.18);
    }
  }

  private kick(T: number, cyc: number) {
    this.ramp(this.kickAmp.gain, this.cKick4, T, cyc);
    this.ramp(this.kickOsc.frequency, this.cKickPitch, T, cyc);
    this.ramp(this.duckK.gain, this.cDuckK, T, cyc);
  }
  private snare(T: number, cyc: number) {
    this.ramp(this.snareNoiseAmp.gain, this.cSnare8, T, cyc);
    this.ramp(this.snareBodyAmp.gain, this.cSnare16, T, cyc);
    this.ramp(this.snareBodyOsc.frequency, this.cSnarePitch, T, cyc);
    this.ramp(this.duckS.gain, this.cDuckS, T, cyc);
  }
  private hat(T: number, period: number) {
    this.ramp(this.hatAmp.gain, this.cHat8, T, period);
  }
  private pop(T: number) {
    const a = this.popAmp.gain;
    a.cancelScheduledValues(T);
    a.setValueAtTime(0, T); a.linearRampToValueAtTime(1, T + 0.002); a.linearRampToValueAtTime(0, T + 0.002 + 0.12);
  }

  // ------------------------------------------------------------ continuous controls, once per frame
  update(sec: number) {
    const t = this.ctx.currentTime;
    const set = (p: AudioParam, v: number, tc = 0.03) => p.setTargetAtTime(v, t, tc);

    const e = G.tongue(sec);
    const oct = Math.pow(2, 1.2 * e);                                   // tongue_pitch gain 1.2
    set(this.tongueOscA.frequency, 55.0 * oct);
    set(this.tongueOscB.frequency, 55.7 * oct);
    set(this.stutterOsc.frequency, 5.0 * Math.pow(2, 2.0 * e));         // stutter_pitch gain 2.0
    set(this.tongueLp.frequency, 180 + (1200 - 180) * e);               // tongue_cutoff
    set(this.tongueSwell.gain, Math.sqrt(e) * 0.9);                     // tongue_sqrt, tongue_swell gain 0.9

    const sw = G.swingMax(sec);
    set(this.riserHp.frequency, 300 + (5000 - 300) * sw);               // riser_cutoff
    set(this.riserAmp.gain, sw);

    set(this.reeseLp.frequency, 160 + (420 - 160) * G.breath(sec), 0.05);   // bass_breath_cutoff

    const cd = G.camDist(sec);
    set(this.padLp.frequency, 1400 + (500 - 1400) * cd, 0.1);           // pad_cutoff
    set(this.padLevel.gain, 1.0 + (0.6 - 1.0) * cd, 0.1);               // pad_level
    this.padPan.set(G.camYaw(sec), t, 0.1);                             // pad_pan
    const shimmer = (G.tail(sec) * 2 - 1) * 0.0015 * 1200;              // tail_vibrato +-0.0015 oct, in cents
    for (const o of this.padTwins) set(o.detune, shimmer, 0.05);

    set(this.masterLp.frequency, 18000 + (3000 - 18000) * cd, 0.1);     // master_cutoff
    this.masterPan.set(G.tail(sec), t, 0.05);                           // tail_pan
  }
}

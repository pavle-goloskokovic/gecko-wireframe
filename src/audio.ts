// audio.ts - the dark drum & bass layer, built from Web Audio nodes (OscillatorNode, BiquadFilterNode,
// GainNode, WaveShaperNode, StereoPannerNode, DynamicsCompressorNode) and driven by gait.ts.
//
// Timing: landings, hat ticks and tongue onsets are closed-form functions of time (gait.ts), so a
// lookahead scheduler books them on the AudioContext clock a quarter second ahead, sample-accurate.
// Continuous controls (tongue extension, breathing, tail, camera) are pushed once per animation
// frame with setTargetAtTime, which smooths the frame steps.
//
// Layer by layer this mirrors build_gecko_audio.py from the TouchDesigner project; the decaying
// ramp envelopes of that version become exponential decays here (setTargetAtTime), with time
// constants chosen to match the (1 - u)^n ramps at half a step.

import * as G from './gait';
import { params as P } from './params';

export const LAYERS = ['kick', 'snare', 'hat', 'reese', 'sub', 'tongue', 'riser', 'pad'] as const;
export type Layer = typeof LAYERS[number];

const PAD_NOTES = [123.47, 164.81, 196.0, 246.94];     // B2 E3 G3 B3 = Em
const LOOKAHEAD = 0.25;                                  // seconds booked ahead
const TICK_MS = 60;                                      // scheduler period
const Q = (res: number) => 0.7071 + res * 2.5;           // TouchDesigner resonance 0..1 -> biquad Q

function noiseBuffer(ctx: AudioContext, seconds = 2): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}
/** WaveShaper curve. Input outside -1..1 is clamped by the node, which is exactly the Limit CHOP's clamp. */
function curve(fn: (x: number) => number, n = 4096): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
  return c;
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
  private padTwins: OscillatorNode[] = []; private padLp!: BiquadFilterNode; private padLevel!: GainNode; private padPan!: StereoPannerNode;
  private masterLp!: BiquadFilterNode; private masterPan!: StereoPannerNode;
  readonly master: GainNode;

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
  /** A DC offset + a modulator oscillator summed into an AudioParam (range = base +- depth). */
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
  private clipCurve = curve(x => x);                                              // identity inside, clamp outside
  // ~3 bits, like gain 6 / floor / gain 1/6. The tongue sum peaks at 1.3, beyond the shaper's -1..1 input range, so the
  // signal is scaled by 1/1.3 first and the curve crushes the unscaled value: floor(6 * 1.3 u) / 6.
  private crushCurve = curve(u => Math.floor(7.8 * u) / 6);

  // ------------------------------------------------------------ the graph
  private build() {
    const ctx = this.ctx;
    this.noiseBuf = noiseBuffer(ctx);
    const mix = this.gain(1);

    // --- pump: the bass bus ducks on kicks (to 15 %) and a little on snares
    this.duckK = this.gain(1); this.duckS = this.gain(1);
    const bassBus = this.gain(1);
    this.chain(bassBus, this.duckK, this.duckS, mix);

    // --- kick: 45 Hz sine, pitch snap from 3 octaves up, x2.2 into a clamp, low-pass 900
    this.kickOsc = this.osc('sine', 45);
    this.kickAmp = this.gain(0);
    const kickOut = this.layerOut('kick', 1.0);
    this.chain(this.kickOsc, this.kickAmp, this.gain(2.2), this.shaper(this.clipCurve), this.filter('lowpass', 900, Q(0.1)), kickOut);
    const drums = this.gain(1.4);
    kickOut.connect(drums);

    // --- snare: band-passed noise + 170 Hz body with pitch snap, summed hot into a clamp
    this.snareNoiseAmp = this.gain(0);
    const snareSum = this.gain(2.5);
    this.chain(this.noise(), this.filter('bandpass', 1100, 1.5), this.snareNoiseAmp, this.gain(1.6), snareSum);
    this.snareBodyOsc = this.osc('sine', 170);
    this.snareBodyAmp = this.gain(0);
    this.chain(this.snareBodyOsc, this.snareBodyAmp, this.gain(1.2), snareSum);
    const snareOut = this.layerOut('snare', 0.9);
    this.chain(snareSum, this.shaper(this.clipCurve), snareOut, drums);

    // --- hats: high-passed noise ticks
    this.hatAmp = this.gain(0);
    const hatOut = this.layerOut('hat', 0.14);
    this.chain(this.noise(), this.filter('highpass', 6500, Q(0.3)), this.hatAmp, hatOut, drums);

    // drum bus crunch
    this.chain(drums, this.shaper(this.clipCurve), this.gain(0.8), mix);

    // --- reese bass: two detuned saws an octave up + square at the root, slow breath-driven low-pass, drive x8, clamp, tame
    const reese = this.gain(1);
    this.chain(this.osc('sawtooth', P.bassHz * 2.0), this.gain(0.4), reese);
    this.chain(this.osc('sawtooth', P.bassHz * 2.012), this.gain(0.4), reese);
    this.chain(this.osc('square', P.bassHz), this.gain(0.3), reese);
    this.reeseLp = this.filter('lowpass', 300, Q(0.3));
    const reeseOut = this.layerOut('reese', 0.6);
    this.chain(reese, this.reeseLp, this.gain(8.0), this.shaper(this.clipCurve), this.filter('lowpass', 3500, Q(0)), reeseOut, bassBus);

    // --- sub
    const subOut = this.layerOut('sub', 0.6);
    this.chain(this.osc('sine', P.bassHz), subOut, bassBus);

    // --- tongue: growl that follows the whole flick
    this.tongueOscA = this.osc('sawtooth', 55.0);
    this.tongueOscB = this.osc('sawtooth', 55.7);
    const tongueSum = this.gain(1);
    this.chain(this.tongueOscA, this.gain(0.8), tongueSum);
    this.chain(this.tongueOscB, this.gain(0.5), tongueSum);
    this.tongueLp = this.filter('lowpass', 600, Q(0.15));
    const stutter = this.gain(0);                                    // 0.1..1 at 5..20 Hz, triangle = soft chops
    this.stutterOsc = this.modulate(stutter.gain, 0.55, 'triangle', 5.0, 0.45);
    const wiggle = this.gain(0);                                     // 0.4..1 at the tongue wiggle rate (18 rad/s)
    this.modulate(wiggle.gain, 0.7, 'sine', 2.86, 0.3);
    this.tongueSwell = this.gain(0);
    const tongueOut = this.layerOut('tongue', 1.0);
    this.chain(tongueSum, this.gain(1 / 1.3), this.shaper(this.crushCurve), this.tongueLp, this.filter('lowpass', 2500, Q(0)), stutter, wiggle, this.tongueSwell, tongueOut, mix);
    this.popAmp = this.gain(0);                                      // noise pop on the onset
    this.chain(this.noise(), this.filter('highpass', 2500, Q(0.5)), this.popAmp, this.gain(0.5), tongueOut);

    // --- riser: high-passed noise, cutoff and level climb with the highest foot
    this.riserHp = this.filter('highpass', 300, Q(0));
    this.riserAmp = this.gain(0);
    const riserOut = this.layerOut('riser', 0.08);
    this.chain(this.noise(), this.gain(0.5), this.riserHp, this.riserAmp, riserOut, mix);

    // --- pad: Em in barely detuned triangle pairs, level and filter follow the camera dolly, panned by the orbit
    const padSum = this.gain(1);
    for (const f of PAD_NOTES) {
      this.chain(this.osc('triangle', f), this.gain(0.25), padSum);
      const twin = this.osc('triangle', f * 1.0007);                 // beats once per 6..12 s; the tail shimmers it +-1.8 cents
      this.padTwins.push(twin);
      this.chain(twin, this.gain(0.25), padSum);
    }
    this.padLp = this.filter('lowpass', 800, Q(0));
    this.padLevel = this.gain(1);
    this.padPan = ctx.createStereoPanner();
    const padOut = this.layerOut('pad', 0.2);
    this.chain(padSum, this.padLp, this.padLevel, this.padPan, padOut, mix);

    // --- master: far camera = muffled, tail pans the whole mix, clamp limiter. A clamp, not a compressor: a
    // compressor's gain reduction follows the kick and bass and pulls the quieter layers (tongue, pad) down with them.
    this.masterLp = this.filter('lowpass', 12000, Q(0));
    this.masterPan = ctx.createStereoPanner();
    this.master.gain.value = 0.8;
    this.chain(mix, this.masterLp, this.masterPan, this.gain(0.45), this.shaper(this.clipCurve), this.master, ctx.destination);
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
    const cyc = 1 / (P.speed * P.stepHz);                   // one gait cycle in seconds (the ramp length in TouchDesigner)
    for (const t of G.landings(from, to, 0)) this.kick(this.toCtx(t), cyc);        // fl (+ hr) land together
    for (const t of G.landings(from, to, 1)) this.snare(this.toCtx(t), cyc);       // fr (+ hl)
    for (const t of G.hatTicks(from, to)) this.hat(this.toCtx(t), cyc / P.hatDiv);
    for (const t of G.tongueOnsets(from, to)) this.pop(this.toCtx(t));
    this.scheduledUntil = to;
  }
  /** (1-u)^n over one cycle, matched at half a cycle by an exponential: tau = cycle * 0.5 / (n ln 2). */
  private static tau(cycle: number, n: number) { return cycle * 0.5 / (n * Math.LN2); }

  private kick(T: number, cyc: number) {
    const a = this.kickAmp.gain, f = this.kickOsc.frequency;
    a.cancelScheduledValues(T); a.setValueAtTime(1, T); a.setTargetAtTime(0, T, GeckoAudio.tau(cyc, 4));          // ~400 ms boom
    f.cancelScheduledValues(T); f.setValueAtTime(45 * 8, T); f.setTargetAtTime(45, T, GeckoAudio.tau(cyc, 16));   // 3-octave snap
    const d = this.duckK.gain;
    d.cancelScheduledValues(T); d.setValueAtTime(0.15, T); d.setTargetAtTime(1, T, GeckoAudio.tau(cyc, 2));
  }
  private snare(T: number, cyc: number) {
    const n = this.snareNoiseAmp.gain, b = this.snareBodyAmp.gain, f = this.snareBodyOsc.frequency;
    n.cancelScheduledValues(T); n.setValueAtTime(1, T); n.setTargetAtTime(0, T, GeckoAudio.tau(cyc, 8));
    b.cancelScheduledValues(T); b.setValueAtTime(1, T); b.setTargetAtTime(0, T, GeckoAudio.tau(cyc, 16));
    f.cancelScheduledValues(T); f.setValueAtTime(170 * Math.pow(2, 1.5), T); f.setTargetAtTime(170, T, GeckoAudio.tau(cyc, 16));
    const d = this.duckS.gain;
    d.cancelScheduledValues(T); d.setValueAtTime(0.55, T); d.setTargetAtTime(1, T, GeckoAudio.tau(cyc, 4));
  }
  private hat(T: number, cyc: number) {
    const a = this.hatAmp.gain;
    a.cancelScheduledValues(T); a.setValueAtTime(1, T); a.setTargetAtTime(0, T, GeckoAudio.tau(cyc, 8));
  }
  private pop(T: number) {
    const a = this.popAmp.gain;
    a.cancelScheduledValues(T); a.setValueAtTime(0, T); a.linearRampToValueAtTime(1, T + 0.002); a.setTargetAtTime(0, T + 0.002, 0.04);
  }

  // ------------------------------------------------------------ continuous controls, once per frame
  update(sec: number) {
    const t = this.ctx.currentTime;
    const set = (p: AudioParam, v: number, tc = 0.03) => p.setTargetAtTime(v, t, tc);

    const e = G.tongue(sec);
    const oct = Math.pow(2, 1.2 * e);
    set(this.tongueOscA.frequency, 55.0 * oct);
    set(this.tongueOscB.frequency, 55.7 * oct);
    set(this.stutterOsc.frequency, 5.0 * Math.pow(2, 2.0 * e));
    set(this.tongueLp.frequency, 180 + (1200 - 180) * e);
    set(this.tongueSwell.gain, Math.sqrt(e) * 0.9);

    const sw = G.swingMax(sec);
    set(this.riserHp.frequency, 300 + (5000 - 300) * sw);
    set(this.riserAmp.gain, sw);

    set(this.reeseLp.frequency, 160 + (420 - 160) * G.breath(sec), 0.05);

    const cd = G.camDist(sec);
    set(this.padLp.frequency, 1400 + (500 - 1400) * cd, 0.1);
    set(this.padLevel.gain, 1.0 + (0.6 - 1.0) * cd, 0.1);
    set(this.padPan.pan, (G.camYaw(sec) - 0.5) * 2 * 0.3, 0.1);
    const shimmer = (G.tail(sec) - 0.5) * 2 * 0.0015 * 1200;       // +-0.15 % in cents
    for (const o of this.padTwins) set(o.detune, shimmer, 0.05);

    set(this.masterLp.frequency, 18000 + (3000 - 18000) * cd, 0.1);
    set(this.masterPan.pan, (G.tail(sec) - 0.5) * 2 * 0.5, 0.05);
  }
}

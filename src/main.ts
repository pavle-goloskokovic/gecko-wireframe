// main.ts - one clock, one gait, two consumers: the renderer and the audio graph.
import { GeckoRenderer } from './render';
import { GeckoAudio, LAYERS } from './audio';
import { params as P } from './params';
import * as G from './gait';
import { attachOrbit, resetView } from './orbit';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('view');
const startBtn = $<HTMLButtonElement>('start');
const pauseBtn = $<HTMLButtonElement>('pause');
const muteToggle = $<HTMLInputElement>('mute');
const stepHzInput = $<HTMLInputElement>('stepHz');
const stepHzVal = $<HTMLSpanElement>('stepHzVal');
const wobbleInput = $<HTMLInputElement>('wobble');
const wobbleVal = $<HTMLSpanElement>('wobbleVal');
const renderToggle = $<HTMLInputElement>('render');
const bloomToggle = $<HTMLInputElement>('bloom');
const hiResToggle = $<HTMLInputElement>('hires');
const hiResLabel = $<HTMLSpanElement>('hiresLabel');
const layersBox = $<HTMLDivElement>('layers');
const stats = $<HTMLDivElement>('stats');

// ---- clock: animation seconds. While the audio runs, AudioContext.currentTime is the master clock (offset so
// there is no jump when it takes over); before audio starts and while it is paused, performance.now() carries on
// from the last known second, so the picture keeps walking with the sound suspended.
let audio: GeckoAudio | null = null;
let audioRunning = false;
let secBase = 0;
let perfBase = performance.now();
function now(): number {
  return audio && audioRunning ? audio.sec : secBase + (performance.now() - perfBase) / 1000;
}
function holdClock() {           // freeze the free-running clock at the current second
  secBase = now(); perfBase = performance.now();
}

// ---- renderer + camera input
const renderer = new GeckoRenderer(canvas);
function resize() {
  renderer.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);
resize();
attachOrbit(canvas);
$<HTMLButtonElement>('resetView').addEventListener('click', resetView);

// ---- UI
for (const layer of LAYERS) {
  const label = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = true; cb.dataset.layer = layer;
  cb.addEventListener('change', () => audio?.setMuted(layer, !cb.checked));
  label.append(cb, document.createTextNode(' ' + layer));
  layersBox.append(label);
}
stepHzInput.addEventListener('input', () => {
  P.stepHz = parseFloat(stepHzInput.value);
  stepHzVal.textContent = P.stepHz.toFixed(2);
});
wobbleInput.addEventListener('input', () => {
  P.wobble = parseFloat(wobbleInput.value);
  wobbleVal.textContent = P.wobble.toFixed(2);
});
bloomToggle.addEventListener('change', () => { renderer.bloom = bloomToggle.checked; });
hiResLabel.textContent = ` hi-res (x${(window.devicePixelRatio || 1).toFixed(2)})`;
hiResToggle.addEventListener('change', () => { renderer.hiRes = hiResToggle.checked; resize(); });

startBtn.addEventListener('click', async () => {
  if (audio) return;
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.resume();
  audio = new GeckoAudio(ctx, now());
  audioRunning = true;
  for (const cb of layersBox.querySelectorAll<HTMLInputElement>('input')) {
    audio.setMuted(cb.dataset.layer as typeof LAYERS[number], !cb.checked);
  }
  audio.setMasterMuted(muteToggle.checked);
  startBtn.disabled = true;
  startBtn.textContent = 'Audio running';
  pauseBtn.disabled = false;
});
muteToggle.addEventListener('change', () => audio?.setMasterMuted(muteToggle.checked));
pauseBtn.addEventListener('click', async () => {
  if (!audio) return;
  if (audioRunning) {
    holdClock();
    audioRunning = false;
    await audio.pause();
    pauseBtn.textContent = 'resume audio';
    startBtn.textContent = 'Audio paused';
  } else {
    const sec = now();
    await audio.resume(sec);
    audioRunning = true;
    pauseBtn.textContent = 'pause audio';
    startBtn.textContent = 'Audio running';
  }
});

// ---- loop
let frames = 0, fpsT = performance.now(), fps = 0;
function loop() {
  requestAnimationFrame(loop);
  const sec = now();
  if (renderToggle.checked) renderer.render(sec);
  if (audioRunning) audio?.update(sec);

  frames++;
  const t = performance.now();
  if (t - fpsT >= 1000) {
    fps = frames * 1000 / (t - fpsT); frames = 0; fpsT = t;
    const r = renderer.resolution;
    const feet = G.LEGS.map((l, i) => G.contact(sec, i) ? l : '--').join(' ');
    stats.textContent = [
      `${fps.toFixed(0)} fps  ${r.w}x${r.h}`,
      `t ${sec.toFixed(1)} s  feet ${feet}`,
      `tongue ${G.tongue(sec).toFixed(2)}  tail ${G.tail(sec).toFixed(2)}  cam ${G.camDist(sec).toFixed(2)}`,
      `view yaw ${P.userYaw.toFixed(0)}  elev ${P.userElev.toFixed(0)}  zoom ${P.zoom.toFixed(2)}`,
    ].join('\n');
  }
}
loop();

// handy in the console
Object.assign(window, { gecko: { params: P, gait: G, get audio() { return audio; }, renderer } });

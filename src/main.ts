// main.ts - one clock, one gait, two consumers: the renderer and the audio graph.
import { GeckoRenderer } from './render';
import { GeckoAudio, LAYERS } from './audio';
import { params as P } from './params';
import * as G from './gait';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const startBtn = document.getElementById('start') as HTMLButtonElement;
const stepHzInput = document.getElementById('stepHz') as HTMLInputElement;
const stepHzVal = document.getElementById('stepHzVal') as HTMLSpanElement;
const renderToggle = document.getElementById('render') as HTMLInputElement;
const bloomToggle = document.getElementById('bloom') as HTMLInputElement;
const layersBox = document.getElementById('layers') as HTMLDivElement;
const stats = document.getElementById('stats') as HTMLDivElement;

// ---- clock: animation seconds. Before audio starts it runs on performance.now(); once the AudioContext
// exists its currentTime takes over (same origin, so there is no jump) and stays the master clock.
const perfT0 = performance.now();
let audio: GeckoAudio | null = null;
function now(): number {
  return audio ? audio.sec : (performance.now() - perfT0) / 1000;
}

// ---- renderer
const renderer = new GeckoRenderer(canvas);
function resize() {
  renderer.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);
resize();

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
bloomToggle.addEventListener('change', () => { renderer.bloom = bloomToggle.checked; });

startBtn.addEventListener('click', async () => {
  if (audio) return;
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.resume();
  audio = new GeckoAudio(ctx, now());
  for (const cb of layersBox.querySelectorAll<HTMLInputElement>('input')) {
    audio.setMuted(cb.dataset.layer as typeof LAYERS[number], !cb.checked);
  }
  startBtn.disabled = true;
  startBtn.textContent = 'Audio running';
});

// ---- loop
let frames = 0, fpsT = performance.now(), fps = 0;
function loop() {
  requestAnimationFrame(loop);
  const sec = now();
  if (renderToggle.checked) renderer.render(sec);
  audio?.update(sec);

  frames++;
  const t = performance.now();
  if (t - fpsT >= 1000) {
    fps = frames * 1000 / (t - fpsT); frames = 0; fpsT = t;
    const r = renderer.resolution;
    const feet = G.LEGS.map((l, i) => G.contact(sec, i) ? l : '--').join(' ');
    stats.textContent = `${fps.toFixed(0)} fps  ${r.w}x${r.h}\nt ${sec.toFixed(1)} s  feet ${feet}\ntongue ${G.tongue(sec).toFixed(2)}  tail ${G.tail(sec).toFixed(2)}  cam ${G.camDist(sec).toFixed(2)}`;
  }
}
loop();

// handy in the console
Object.assign(window, { gecko: { params: P, gait: G, get audio() { return audio; }, renderer } });

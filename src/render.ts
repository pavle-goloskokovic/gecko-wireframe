// render.ts - draws the baked (already projected) vertices the way the shader's pass 1 does:
// wobbly 1 px wires with depth fade, square nodes, tracker brackets, white on black, plus an
// optional bloom. The scene lives in pixel space under an orthographic camera, so the camera
// maths (orbit, dolly, roll, handheld shake) stays in gait.ts, shared with the audio.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { NS, NV, bake, gaitAt } from './gait';
import { params as P } from './params';

interface Edge { a: number; b: number; w: number }

/** The edge list of the shader's render pass, in the same order. */
function buildEdges(): Edge[] {
  const E: Edge[] = [];
  const ow = 1.0;
  const iw = P.meshDim;
  const bw = P.meshDim + (1.0 - P.meshDim) * 0.4;
  const edge = (a: number, b: number, w: number) => { if (w >= 0.01) E.push({ a, b, w }); };

  for (let s = 0; s < NS; s++)
    for (let k = 0; k < 6; k++) edge(s * 6 + k, s * 6 + ((k + 1) % 6), bw);
  for (let s = 0; s < NS - 1; s++)
    for (let k = 0; k < 6; k++) {
      edge(s * 6 + k, (s + 1) * 6 + k, bw);
      edge(s * 6 + k, (s + 1) * 6 + ((k + 1) % 6), bw * 0.7);
    }
  for (let s = 0; s < NS - 2; s++)                                       // long stretched links
    for (let k = 0; k < 6; k++) edge(s * 6 + k, (s + 2) * 6 + k, iw * 0.45 * P.stretch);

  edge(134, 135, ow); edge(136, 137, ow);                                // pupils
  edge(138, 139, ow); edge(139, 140, ow); edge(140, 141, ow);            // tongue

  for (let l = 0; l < 4; l++) {
    const base = 142 + l * 18;
    const sgn = (l % 2) === 0 ? 1.0 : -1.0;
    const sIdx = l < 2 ? 5 : 10;
    const kA = sgn > 0 ? 1 : 4;
    const kB = sgn > 0 ? 2 : 5;
    edge(base, sIdx * 6 + kA, bw);
    edge(base, sIdx * 6 + kB, bw);
    edge(base, base + 1, ow);
    edge(base + 1, base + 2, ow);
    for (let t = 0; t < 5; t++) {
      const tb = base + 3 + t * 3;
      edge(base + 2, tb, ow); edge(tb, tb + 1, ow); edge(tb + 1, tb + 2, ow);
    }
    for (let t = 0; t < 4; t++) {                                        // toe webbing
      edge(base + 4 + t * 3, base + 7 + t * 3, iw);
      edge(base + 5 + t * 3, base + 8 + t * 3, iw);
    }
  }
  return E;
}

function boxSize(i: number): number {
  if (i < 132) {
    const s = Math.floor(i / 6);
    if (s < 12) return 0.75;
    if (s < 19) return 0.55;
    return 0.40;
  }
  if (i < 134) return 2.0;
  if (i < 138) return 0.7;
  if (i < 142) return i === 141 ? 1.1 : 0.8;
  const v = (i - 142) % 18;
  if (v === 0) return 1.4;
  if (v < 3) return 1.2;
  return ((v - 3) % 3) === 2 ? 1.1 : 0.6;
}
function isKey(i: number): boolean {
  if (i === 132 || i === 133 || i === 141) return true;
  if (i >= 142) return ((i - 142) % 18) === 2;
  return false;
}

const SEGS = 8;            // subdivisions per wire for the wobble (1 for short wires)
const MAX_BLEND = { blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor } as const;

const pointVert = /* glsl */`
  attribute float aSize;     // half-size of the filled box in px
  attribute float aBright;
  attribute float aKey;
  varying float vSize;
  varying float vBright;
  varying float vKey;
  varying float vHalf;
  void main() {
    vSize = aSize; vBright = aBright; vKey = aKey;
    float extent = (aKey > 0.5 && uBracket > 0.5) ? aSize * 2.6 + 1.5 : aSize + 1.0;
    gl_PointSize = extent * 2.0;
    vHalf = extent;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const pointFrag = /* glsl */`
  varying float vSize;
  varying float vBright;
  varying float vKey;
  varying float vHalf;
  void main() {
    if (vBright < 0.001) discard;
    vec2 d = abs(gl_PointCoord - 0.5) * vHalf * 2.0;
    float dB = max(d.x, d.y);
    float filled = 1.0 - smoothstep(vSize - 0.5, vSize + 0.5, dB);
    float ring = 0.0;
    if (uBracket > 0.5 && vKey > 0.5) ring = 1.0 - smoothstep(0.3, 1.0, abs(dB - vSize * 2.6));
    float a = max(filled, ring) * vBright;
    if (a < 0.002) discard;
    gl_FragColor = vec4(vec3(a), 1.0);
  }`;

export class GeckoRenderer {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);
  private composer: EffectComposer;
  private bloomPass: UnrealBloomPass;
  private edges = buildEdges();
  private baked = new Float32Array(NV * 4);
  private linePos: Float32Array;
  private lineCol: Float32Array;
  private lineGeo = new THREE.BufferGeometry();
  private pointPos = new Float32Array(NV * 3);
  private pointSize = new Float32Array(NV);
  private pointBright = new Float32Array(NV);
  private pointGeo = new THREE.BufferGeometry();
  private width = 1;
  private height = 1;
  bloom = true;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.scene.background = new THREE.Color(0x000000);

    const maxVerts = this.edges.length * SEGS * 2;
    this.linePos = new Float32Array(maxVerts * 3);
    this.lineCol = new Float32Array(maxVerts * 3);
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineGeo.setAttribute('color', new THREE.BufferAttribute(this.lineCol, 3).setUsage(THREE.DynamicDrawUsage));
    // the shader combines wires with max(), not a sum: overlapping wires must not get brighter
    const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, ...MAX_BLEND });
    const lines = new THREE.LineSegments(this.lineGeo, lineMat);
    lines.frustumCulled = false;
    this.scene.add(lines);

    const key = new Float32Array(NV);
    for (let i = 0; i < NV; i++) key[i] = isKey(i) ? 1 : 0;
    this.pointGeo.setAttribute('position', new THREE.BufferAttribute(this.pointPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.pointGeo.setAttribute('aSize', new THREE.BufferAttribute(this.pointSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.pointGeo.setAttribute('aBright', new THREE.BufferAttribute(this.pointBright, 1).setUsage(THREE.DynamicDrawUsage));
    this.pointGeo.setAttribute('aKey', new THREE.BufferAttribute(key, 1));
    const pointMat = new THREE.ShaderMaterial({
      uniforms: { uBracket: { value: P.bracket } },
      vertexShader: 'uniform float uBracket;\n' + pointVert,
      fragmentShader: 'uniform float uBracket;\n' + pointFrag,
      depthTest: false, depthWrite: false, transparent: true, ...MAX_BLEND,
    });
    const points = new THREE.Points(this.pointGeo, pointMat);
    points.frustumCulled = false;
    this.scene.add(points);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.35, 0.25, 0.55);   // a faint halo on the brightest wires only
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
  }

  /** Internal resolution: the window, capped at 1280 px wide (the TouchDesigner project used 640x360). */
  resize(cssW: number, cssH: number) {
    const scale = Math.min(1, 1280 / Math.max(cssW, 1));
    this.width = Math.max(2, Math.round(cssW * scale));
    this.height = Math.max(2, Math.round(cssH * scale));
    this.renderer.setSize(this.width, this.height, false);
    this.composer.setSize(this.width, this.height);
    this.bloomPass.resolution.set(Math.round(this.width / 2), Math.round(this.height / 2));
    this.camera.right = this.width; this.camera.top = this.height;
    this.camera.updateProjectionMatrix();
  }

  get resolution() { return { w: this.width, h: this.height }; }

  render(sec: number) {
    const g = gaitAt(sec);
    const V = bake(sec, this.width, this.height, this.baked);
    const tw = g.tt * P.wobbleSpeed;

    // wires
    const pos = this.linePos, col = this.lineCol;
    let n = 0;
    for (const e of this.edges) {
      const ax = V[e.a * 4], ay = V[e.a * 4 + 1], ag = V[e.a * 4 + 2];
      const bx = V[e.b * 4], by = V[e.b * 4 + 1], bg = V[e.b * 4 + 2];
      const dx = bx - ax, dy = by - ay;
      const l = Math.hypot(dx, dy);
      if (ag < 0.001 || bg < 0.001 || l < 0.5) continue;
      const bright = e.w * 0.5 * (ag + bg);
      const amp = P.wobble * Math.min(l, 120.0) * 0.08;
      const bow = P.stretch * Math.min(l, 150.0) * 0.05;
      const ph = e.a * 1.713 + e.b * 0.931;
      const bowOff = bow * Math.sin(ph * 3.1);
      const nx = -dy / l, ny = dx / l;
      const segs = l < 10 ? 1 : SEGS;
      let px = ax, py = ay;
      for (let s = 1; s <= segs; s++) {
        const h = s / segs;
        let wob = 0;
        if (s < segs) {
          const env = Math.sin(Math.PI * h);
          wob = amp * env * (0.65 * Math.sin(h * l * 0.045 + tw + ph) + 0.35 * Math.sin(h * l * 0.110 - tw * 1.7 + ph * 2.3)) + bowOff * env;
        }
        const qx = ax + dx * h + nx * wob, qy = ay + dy * h + ny * wob;
        pos[n * 3] = px; pos[n * 3 + 1] = py; pos[n * 3 + 2] = 0;
        pos[n * 3 + 3] = qx; pos[n * 3 + 4] = qy; pos[n * 3 + 5] = 0;
        for (let k = 0; k < 6; k++) col[n * 3 + k] = bright;
        n += 2;
        px = qx; py = qy;
      }
    }
    this.lineGeo.setDrawRange(0, n);
    (this.lineGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.lineGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;

    // nodes
    for (let i = 0; i < NV; i++) {
      this.pointPos[i * 3] = V[i * 4]; this.pointPos[i * 3 + 1] = V[i * 4 + 1]; this.pointPos[i * 3 + 2] = 0;
      this.pointSize[i] = boxSize(i) * P.boxPx * V[i * 4 + 3];
      this.pointBright[i] = V[i * 4 + 2];
    }
    (this.pointGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.pointGeo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    (this.pointGeo.attributes.aBright as THREE.BufferAttribute).needsUpdate = true;

    if (this.bloom) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}

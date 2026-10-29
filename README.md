# Gecko on the web

Browser port of the TouchDesigner project one folder up: the same wireframe gecko walk, drawn with
three.js, and the same dark drum & bass layer, built from Web Audio nodes and driven by the gait.

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + bundle into dist/
npm run preview    # serve dist/ on http://localhost:4173
```

Open the page, click **Start audio** (browsers only start audio after a click), listen. The panel
mutes layers individually or the whole mix, pauses the audio (the picture keeps walking), changes the
step rate (which changes the walk, the drums and the tongue together), and switches the picture, the
bloom or hi-res rendering on and off.

Drag the scene to orbit the camera around the gecko (mouse or finger), scroll or pinch to dolly,
double-click or press **reset view** to go back. The drag offsets sit on top of the automatic orbit
and feed the same camera the sound reads, so the pad pans and the far-camera muffling follow you.

## Layout

| File | What it is |
|---|---|
| `src/params.ts` | Every knob, same names and defaults as the shader uniforms and the `gecko_params` CHOP. |
| `src/gait.ts` | The one source of truth: vertex positions, camera, projection (a port of the shader's bake pass), the event channels (`contact`, `swing`, `tongue`, `breath`, `tail`, `camDist`, `camYaw`) and closed-form event times (`landings`, `hatTicks`, `tongueOnsets`). |
| `src/render.ts` | Pass 1 of the shader as geometry: the projected vertices become wobbly `LineSegments` and square `Points` in a pixel-space orthographic scene, combined with max blending like the shader, plus a faint bloom. |
| `src/audio.ts` | The audio graph, layer by layer as in `build_gecko_audio.py`, with a lookahead scheduler that books kicks, snares, hats and tongue pops on the AudioContext clock. |
| `src/orbit.ts` | Pointer-event orbit: drag = yaw / elevation offsets, wheel or pinch = zoom, written into `params`. |
| `src/main.ts` | One clock (performance.now until audio starts or while it is paused, AudioContext time otherwise), the UI, the frame loop. |

## How the timing works

Nothing in the gecko has state; every pose is a function of time. So instead of detecting foot
landings frame by frame, `gait.ts` solves for them: a foot lands when `fract(stepHz * t + offset)`
wraps, i.e. at `t = (n - offset) / stepHz`. Every 60 ms the scheduler asks for all landings in the next
250 ms and books them with `setValueAtTime` / `setTargetAtTime`, which are sample-accurate. The
decaying ramp envelopes of the TouchDesigner version become exponential decays with time constants
matched at half a step (`tau = cycle / (2 n ln 2)` for a `(1 - u)^n` ramp).

The animation clock is `performance.now()` until audio starts, then `AudioContext.currentTime`
(offset so there is no jump), so picture and sound share one time base.

## Differences from the TouchDesigner version

- White noise comes from a looped `AudioBufferSourceNode`; there is no noise oscillator in Web Audio.
- The bit-crush is a `WaveShaperNode` staircase curve; the clip stages are `WaveShaperNode`s with an
  identity curve, which clamp anything outside -1..1 exactly like the Limit CHOP.
- Continuous controls (tongue, breathing, tail, camera) are pushed once per frame with
  `setTargetAtTime`, which smooths the frame steps that TouchDesigner's CHOP network had.
- Wires are 1 px (WebGL line width is fixed); the wobble is baked into 8 sub-segments per wire.

## Console

`window.gecko` exposes `params`, `gait`, `audio` and `renderer`, e.g. `gecko.params.stepHz = 1.45`
or `gecko.audio.setMuted('pad', true)`.

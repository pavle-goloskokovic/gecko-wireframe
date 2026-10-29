// Shared parameters. Same names and defaults as the uniforms in gecko_wireframe.glsl and the
// gecko_params CHOP in the TouchDesigner project, so picture and sound can never drift apart:
// there is exactly one gait, computed in gait.ts, and both the renderer and the audio read it.

export const params = {
  // time
  speed: 1.0,          // master time scale (uSpeed)
  // gait / body
  stepHz: 0.85,        // gait cycles per second = kick..snare..kick (uStepHz). 0.85 ~ 102 BPM half-time, 1.45 ~ 174 BPM
  stride: 1.0,         // stride length multiplier (uStride)
  stepLift: 1.0,       // foot lift multiplier (uStepLift)
  undul: 1.0,          // spine undulation (uUndul)
  tongue: 1.0,         // tongue flick amount, 0 = off (uTongue)
  // camera
  orbit: 0.03,         // revolutions per second (uOrbit)
  yaw0: 20,            // start yaw, degrees (uYaw0)
  camDist: 6.5,        // camera distance (uCamDist)
  camElev: 28,         // base elevation, degrees (uCamElev)
  focal: 2.2,          // focal / zoom (uFocal)
  camShake: 1.0,       // handheld micro-shake and roll (uCamShake)
  centerX: 0.5,        // screen position of the target (uCenter)
  centerY: 0.5,
  // look
  boxPx: 2.0,          // node box half-size in px (uBoxPx)
  wirePx: 1.0,         // wire thickness in px (uWirePx; WebGL lines are always 1 px, kept for the bloom pass)
  meshDim: 0.55,       // interior line brightness (uMeshDim)
  depthDim: 0.35,      // far-side brightness, 1 = no depth fade (uDepthDim)
  bracket: 1.0,        // tracker brackets on eyes, wrists, tongue tip (uBracket)
  wobble: 1.0,         // wobbly line amount (uWobble)
  wobbleSpeed: 1.5,    // wobble speed (uWobbleSpeed)
  stretch: 1.0,        // stretched long links + slack bow, 0 = off (uStretch)
  // audio
  bassHz: 41.2,        // E1: sub and reese root
  hatDiv: 8,           // hats per gait cycle
};

export type Params = typeof params;

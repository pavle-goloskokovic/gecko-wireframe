// orbit.ts - drag to orbit the camera on a sphere around the gecko, wheel or pinch to dolly.
// Mouse and touch through pointer events. The offsets land in params (userYaw, userElev, zoom) and
// gait.ts adds them to the automatic orbit, so the picture and the camera-driven sound stay in step.

import { params as P } from './params';

const clamp = (x: number, a: number, b: number) => Math.min(Math.max(x, a), b);
export const ZOOM_MIN = 0.35, ZOOM_MAX = 3.0;
export const ELEV_MIN = -100, ELEV_MAX = 50;       // degrees of user offset; the base elevation is 28 +- 16

export function resetView() {
  P.userYaw = 0; P.userElev = 0; P.zoom = 1;
}

export function attachOrbit(el: HTMLElement) {
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  const dist = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  el.style.touchAction = 'none';                   // no scrolling or browser zoom while dragging on the canvas
  el.style.cursor = 'grab';

  el.addEventListener('pointerdown', e => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) pinchDist = dist();
    el.style.cursor = 'grabbing';
    e.preventDefault();
  });
  el.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size === 1) {
      // a full drag across the view is half a turn; dragging right swings the camera to the left (the gecko turns right)
      P.userYaw -= dx / el.clientWidth * 180;
      P.userElev = clamp(P.userElev - dy / el.clientHeight * 120, ELEV_MIN, ELEV_MAX);
    } else if (pointers.size === 2) {
      const d = dist();
      if (pinchDist > 0 && d > 0) P.zoom = clamp(P.zoom * pinchDist / d, ZOOM_MIN, ZOOM_MAX);
      pinchDist = d;
    }
  });
  const release = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) el.style.cursor = 'grab';
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('wheel', e => {
    P.zoom = clamp(P.zoom * Math.exp(e.deltaY * 0.0012), ZOOM_MIN, ZOOM_MAX);
    e.preventDefault();
  }, { passive: false });
  el.addEventListener('dblclick', resetView);
}

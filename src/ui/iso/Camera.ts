import { setAttr } from '../scene/svg';
import { lerp } from './project';

export type CameraMode = 'follow' | 'overview' | 'free';

export interface ScreenRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * A viewBox camera over screen-space (projected) coordinates. Smoothly follows a target rectangle, frames
 * the whole scene, or is driven by the user (wheel/drag/pinch).
 */
export class Camera {
  mode: CameraMode = 'overview';
  /** Pixels of the stage covered by panels, so targets are framed inside the visible part. */
  insets = { right: 0, bottom: 0 };
  private cam = { x: 0, y: 0, w: 1600 };
  private free = { x: 0, y: 0, w: 1600 };
  private bounds: ScreenRect = { x0: 0, y0: 0, x1: 1600, y1: 900 };
  private initialised = false;

  constructor(
    private readonly svg: SVGSVGElement,
    private readonly container: HTMLElement,
  ) {
    this.installControls();
  }

  setBounds(b: ScreenRect): void {
    this.bounds = b;
    if (!this.initialised) {
      this.cam = this.fit(b, 0);
      this.free = { ...this.cam };
      this.initialised = true;
    }
  }

  get sceneBounds(): ScreenRect {
    return this.bounds;
  }

  setMode(m: CameraMode): void {
    if (m === 'free') this.free = { ...this.cam };
    this.mode = m;
  }

  /** Camera that shows `f` inside the uncovered part of the stage, never narrower than minW. */
  fit(f: ScreenRect, minW: number): { x: number; y: number; w: number } {
    const r = this.container.getBoundingClientRect();
    const W = Math.max(1, r.width);
    const H = Math.max(1, r.height);
    const vw = Math.max(80, W - this.insets.right);
    const vh = Math.max(80, H - this.insets.bottom);
    const w = Math.max(((f.x1 - f.x0) * W) / vw, ((f.y1 - f.y0) * W) / vh, minW);
    const s = w / W;
    return { x: (f.x0 + f.x1) / 2 + (this.insets.right / 2) * s, y: (f.y0 + f.y1) / 2 + (this.insets.bottom / 2) * s, w };
  }

  /** Called every frame with the follow target (or undefined for the overview). */
  update(target: ScreenRect | undefined, minW: number, dt: number): void {
    const B = this.bounds;
    let t: { x: number; y: number; w: number };
    if (this.mode === 'free') t = this.free;
    else if (this.mode === 'overview' || !target) t = this.fit(B, 0);
    else {
      const f = this.fit(target, minW);
      t = { ...f, w: Math.min(f.w, this.fit(B, 0).w) };
    }
    const k = dt > 0 ? 1 - Math.exp(-dt * 3.2) : 1;
    this.cam.x = lerp(this.cam.x, t.x, k);
    this.cam.y = lerp(this.cam.y, t.y, k);
    this.cam.w = lerp(this.cam.w, t.w, k);
    this.apply();
  }

  /** Current scene-units-per-stage-width; > 1 means zoomed out relative to a 1400 px stage. */
  get zoomOut(): number {
    const r = this.container.getBoundingClientRect();
    return this.cam.w / Math.max(1, r.width);
  }

  private apply(): void {
    const rect = this.container.getBoundingClientRect();
    const aspect = rect.height > 0 && rect.width > 0 ? rect.height / rect.width : 0.56;
    const w = this.cam.w;
    const h = w * aspect;
    setAttr(this.svg, 'viewBox', `${(this.cam.x - w / 2).toFixed(1)} ${(this.cam.y - h / 2).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
  }

  toScene(clientX: number, clientY: number): { x: number; y: number } {
    const m = this.svg.getScreenCTM();
    if (!m) return { x: clientX, y: clientY };
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }

  private installControls(): void {
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    const interactive = '.gizmo, .car, .machine-hit, .url-card, .hint, .lever';
    this.svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.mode !== 'free') this.setMode('free');
        this.zoomAt(this.toScene(e.clientX, e.clientY), Math.exp(e.deltaY * 0.0015));
      },
      { passive: false },
    );
    this.svg.addEventListener('pointerdown', (e) => {
      if ((e.target as Element).closest(interactive)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.svg.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      }
    });
    this.svg.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      if (this.mode !== 'free') this.setMode('free');
      if (pointers.size === 1) {
        const a = this.toScene(prev.x, prev.y);
        const b = this.toScene(e.clientX, e.clientY);
        this.free.x -= b.x - a.x;
        this.free.y -= b.y - a.y;
        this.cam.x = this.free.x;
        this.cam.y = this.free.y;
      } else if (pointers.size === 2) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        if (pinchDist > 0) this.zoomAt(this.toScene((a!.x + b!.x) / 2, (a!.y + b!.y) / 2), pinchDist / dist);
        pinchDist = dist;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    const up = (e: PointerEvent): void => {
      pointers.delete(e.pointerId);
      pinchDist = 0;
    };
    this.svg.addEventListener('pointerup', up);
    this.svg.addEventListener('pointercancel', up);
  }

  private zoomAt(p: { x: number; y: number }, f: number): void {
    const B = this.bounds;
    const full = B.x1 - B.x0;
    const w = Math.max(full / 8, Math.min(full * 1.4, this.free.w * f));
    const real = w / this.free.w;
    this.free.x = p.x + (this.free.x - p.x) * real;
    this.free.y = p.y + (this.free.y - p.y) * real;
    this.free.w = w;
    this.cam = { ...this.free };
  }
}

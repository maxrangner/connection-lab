/** Playhead over visual time. Drives a render callback every animation frame while playing. */
export class Player {
  v = 0;
  playing = false;
  speed = 1;
  duration = 1;
  /** When set, playback pauses on reaching this v (used by "step"). */
  private stopAt: number | undefined;
  private last = 0;
  private raf = 0;
  private listeners = new Set<(v: number) => void>();
  private stateListeners = new Set<() => void>();

  constructor(private readonly onFrame: (v: number, dt: number) => void) {
    const tick = (now: number): void => {
      const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
      this.last = now;
      if (this.playing) {
        let next = this.v + dt * this.speed;
        if (this.stopAt !== undefined && next >= this.stopAt) {
          next = this.stopAt;
          this.stopAt = undefined;
          this.setPlaying(false);
        }
        if (next >= this.duration) {
          next = this.duration;
          this.setPlaying(false);
        }
        this.v = next;
        this.emit();
      }
      this.onFrame(this.v, dt);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  onChange(fn: (v: number) => void): void {
    this.listeners.add(fn);
  }

  onState(fn: () => void): void {
    this.stateListeners.add(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.v);
  }

  setPlaying(p: boolean): void {
    if (p && this.v >= this.duration) this.v = 0;
    this.playing = p;
    if (!p) this.stopAt = undefined;
    for (const fn of this.stateListeners) fn();
  }

  toggle(): void {
    this.setPlaying(!this.playing);
  }

  seek(v: number): void {
    this.v = Math.max(0, Math.min(this.duration, v));
    this.stopAt = undefined;
    this.emit();
  }

  /** Play until `v`, then pause. */
  playTo(v: number): void {
    if (v <= this.v) {
      this.seek(v);
      return;
    }
    this.stopAt = v;
    this.setPlaying(true);
    this.stopAt = v;
  }

  setSpeed(s: number): void {
    this.speed = s;
    for (const fn of this.stateListeners) fn();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
  }
}

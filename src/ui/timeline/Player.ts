/**
 * Playhead over visual time. Drives a render callback every animation frame while playing. Gates are visual
 * times playback may not cross on its own (a bubble to dismiss, a machine waiting for the operator); seeking
 * is always allowed.
 */
export class Player {
  v = 0;
  playing = false;
  speed = 1;
  duration = 1;
  gates: number[] = [];
  /** The gate playback is currently stopped at, if any. */
  blockedAt: number | undefined;
  private stopAt: number | undefined;
  private last = 0;
  private raf = 0;
  private listeners = new Set<(v: number) => void>();
  private stateListeners = new Set<() => void>();
  private gateListeners = new Set<(v: number) => void>();

  constructor(
    private readonly onFrame: (v: number, dt: number) => void,
    autoStart = true,
  ) {
    if (autoStart) this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  /** One frame of playback; public so tests can drive it with a fake clock. */
  tick(t: number): void {
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0;
    this.last = t;
    if (this.playing) {
      let next = this.v + dt * this.speed;
      // A gate counts as ahead until v has moved past it: a frame can land v a hair below a gate (6.5 vs
      // 6.500000000000001), and that gate must still stop the next frame. release() steps 1 ms past the gate.
      const g = this.gates.find((x) => x >= this.v - 1e-9 && x <= next);
      if (g !== undefined) {
        // Stop at the gate but keep any step target, so a release continues the step.
        next = g;
        this.blockedAt = g;
        this.playing = false;
        for (const fn of this.stateListeners) fn();
        for (const fn of this.gateListeners) fn(g);
      }
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
    if (this.raf) this.raf = requestAnimationFrame((tt) => this.tick(tt));
  }

  onChange(fn: (v: number) => void): void {
    this.listeners.add(fn);
  }

  onState(fn: () => void): void {
    this.stateListeners.add(fn);
  }

  onGate(fn: (v: number) => void): void {
    this.gateListeners.add(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.v);
  }

  setPlaying(p: boolean): void {
    if (p && this.v >= this.duration) this.v = 0;
    if (p && this.blockedAt !== undefined) this.release(false);
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
    this.blockedAt = undefined;
    this.emit();
  }

  /** Play until `v`, then pause (gates on the way still stop it). */
  playTo(v: number): void {
    if (v <= this.v) {
      this.seek(v);
      return;
    }
    this.setPlaying(true);
    this.stopAt = v;
  }

  /** Step past the gate playback is stopped at. */
  release(resume = true): void {
    if (this.blockedAt === undefined) return;
    this.v = Math.min(this.duration, this.blockedAt + 1e-3);
    this.blockedAt = undefined;
    this.emit();
    if (resume) {
      this.playing = true;
      for (const fn of this.stateListeners) fn();
    }
  }

  setSpeed(s: number): void {
    this.speed = s;
    for (const fn of this.stateListeners) fn();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}

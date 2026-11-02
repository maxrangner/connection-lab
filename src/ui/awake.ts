/** Keeps the screen on while a run plays: nobody touches the screen while they watch, and a run is longer than a phone waits. */
export class KeepAwake {
  private wanted = false;
  private lock: WakeLockSentinel | null = null;
  private asking = false;

  constructor() {
    // The browser lets go by itself when the page is out of sight, and it has to be asked again on the way back.
    document.addEventListener('visibilitychange', () => this.sync());
  }

  set(on: boolean): void {
    if (on === this.wanted) return;
    this.wanted = on;
    this.sync();
  }

  private sync(): void {
    if (!this.wanted && this.lock) {
      void this.lock.release();
      this.lock = null;
    }
    if (!this.wanted || this.lock || this.asking || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
    this.asking = true;
    navigator.wakeLock
      .request('screen')
      .then((lock) => {
        lock.addEventListener('release', () => {
          if (this.lock === lock) this.lock = null;
        });
        this.lock = lock;
        this.asking = false;
        this.sync();
      })
      // Not allowed here (no HTTPS, a low battery, a frame that may not): the screen just dims as it always did.
      .catch(() => {
        this.asking = false;
      });
  }
}

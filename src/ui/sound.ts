import type { Cue } from './timeline';

/**
 * Tiny synthesized sound effects (no audio files). Browsers only allow sound after the viewer has
 * interacted with the page, so the context is created lazily on the first play.
 */
export class Sound {
  private ctx: AudioContext | null = null;
  muted = false;

  play(sound: Cue['sound']): void {
    if (this.muted) return;
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      return;
    }
    const c = this.ctx;
    const t = c.currentTime;
    switch (sound) {
      case 'snap':
        this.tone(c, t, 'triangle', 1400, 700, 0.05, 0.08);
        break;
      case 'sleeve':
        this.tone(c, t, 'triangle', 700, 420, 0.07, 0.08);
        this.noise(c, t, 0.05, 0.04, 3000);
        break;
      case 'thud':
        this.tone(c, t, 'sine', 160, 70, 0.14, 0.18);
        break;
      case 'swap':
        // A quick whoosh up, a stamp coming down, a bright ding.
        this.tone(c, t, 'sine', 300, 1500, 0.11, 0.1);
        this.tone(c, t + 0.1, 'square', 190, 70, 0.1, 0.14);
        this.noise(c, t + 0.1, 0.05, 0.1, 2500);
        [1320, 1980].forEach((f, i) => this.tone(c, t + 0.13 + i * 0.05, 'triangle', f, f, 0.22, 0.09));
        break;
      case 'bonk':
        this.tone(c, t, 'sine', 420, 110, 0.25, 0.22);
        this.noise(c, t, 0.12, 0.12, 1200);
        break;
      case 'lock':
        this.tone(c, t, 'square', 1200, 900, 0.03, 0.04);
        this.tone(c, t + 0.05, 'square', 700, 500, 0.05, 0.05);
        break;
      case 'unlock':
        this.tone(c, t, 'square', 500, 700, 0.04, 0.04);
        this.tone(c, t + 0.05, 'triangle', 900, 1400, 0.08, 0.06);
        break;
      case 'key':
        [1320, 1760, 2640].forEach((f, i) => this.tone(c, t + i * 0.06, 'triangle', f, f, 0.12, 0.05));
        break;
      case 'snip':
        this.noise(c, t, 0.05, 0.14, 7000);
        this.noise(c, t + 0.09, 0.05, 0.14, 7000);
        break;
      case 'surprise':
        this.tone(c, t, 'square', 880, 1320, 0.07, 0.05);
        this.tone(c, t + 0.09, 'square', 1320, 1760, 0.09, 0.05);
        break;
      case 'pop':
        this.tone(c, t, 'sine', 520, 880, 0.08, 0.1);
        break;
      case 'flip':
        // A page turning.
        this.noise(c, t, 0.09, 0.09, 3500);
        break;
      case 'found':
        [1040, 1560].forEach((f, i) => this.tone(c, t + i * 0.07, 'sine', f, f, 0.16, 0.09));
        break;
      case 'chime':
        [660, 830, 990].forEach((f, i) => this.tone(c, t + i * 0.09, 'sine', f, f, 0.35, 0.08));
        break;
    }
  }

  /** What a call's receiver heard: one second of 8 kHz samples, with silence where a packet never came. */
  playVoice(heard: (Int16Array | number[] | null)[], perPacket: number): void {
    if (this.muted) return;
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      return;
    }
    const c = this.ctx;
    const buf = c.createBuffer(1, heard.length * perPacket, 8000);
    const data = buf.getChannelData(0);
    heard.forEach((pcm, i) => {
      if (!pcm) return;
      for (let k = 0; k < perPacket; k++) data[i * perPacket + k] = (pcm[k] ?? 0) / 32768;
    });
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.value = 0.9;
    src.connect(g).connect(c.destination);
    src.start(c.currentTime + 0.1);
  }

  private tone(c: AudioContext, t: number, type: OscillatorType, f0: number, f1: number, dur: number, gain: number): void {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** One buffer of fading noise per length, made the first time it is needed. */
  private readonly noises = new Map<number, AudioBuffer>();

  private noise(c: AudioContext, t: number, dur: number, gain: number, cutoff: number): void {
    let buf = this.noises.get(dur);
    if (!buf) {
      buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      this.noises.set(dur, buf);
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(filter).connect(g).connect(c.destination);
    src.start(t);
  }
}

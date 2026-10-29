import { fmtTime } from '../content/narration';
import type { Player } from '../timeline/Player';
import type { Schedule } from '../timeline/schedule';
import { button, h } from './dom';

export interface ControlsHost {
  stepNext(): void;
  stepPrev(): void;
  restart(): void;
}

/** Bottom bar: caption, transport buttons, speed, scrubber with event ticks, sim clock. */
export class Controls {
  readonly el: HTMLElement;
  private caption: HTMLElement;
  private playBtn: HTMLButtonElement;
  private range: HTMLInputElement;
  private ticks: HTMLElement;
  private clock: HTMLElement;
  private speedSel: HTMLSelectElement;
  private schedule: Schedule | undefined;
  private lastCaption = -2;

  constructor(
    player: Player,
    host: ControlsHost,
  ) {
    this.caption = h('div', { class: 'caption', attrs: { 'aria-live': 'polite' } });
    this.playBtn = button('▶', () => player.toggle(), 'play', 'Play / pause (Space)');
    this.range = h('input', { class: 'scrub', attrs: { type: 'range', min: '0', max: '1', step: '0.01', value: '0', 'aria-label': 'Timeline' } });
    this.range.addEventListener('input', () => {
      player.setPlaying(false);
      player.seek(Number(this.range.value));
    });
    this.ticks = h('div', { class: 'ticks' });
    this.clock = h('div', { class: 'clock', title: 'Simulated time since the click' });
    this.speedSel = h('select', { class: 'speed', attrs: { 'aria-label': 'Speed' } });
    for (const s of [0.25, 0.5, 1, 1.5, 2, 4]) this.speedSel.append(h('option', { text: `${s}×`, attrs: { value: String(s) } }));
    this.speedSel.value = String(player.speed);
    this.speedSel.addEventListener('change', () => player.setSpeed(Number(this.speedSel.value)));
    player.onState(() => {
      this.playBtn.textContent = player.playing ? '❚❚' : '▶';
      this.speedSel.value = String(player.speed);
    });
    const transport = h(
      'div',
      { class: 'transport' },
      button('⏮', () => host.restart(), 'icon-btn', 'Restart'),
      button('◀', () => host.stepPrev(), 'icon-btn', 'Previous step (←)'),
      this.playBtn,
      button('▶|', () => host.stepNext(), 'icon-btn', 'Next step (→)'),
      this.speedSel,
      h('div', { class: 'scrub-wrap' }, this.ticks, this.range),
      this.clock,
    );
    this.el = h('div', { class: 'controls' }, this.caption, transport);
  }

  setSchedule(s: Schedule): void {
    this.schedule = s;
    this.range.max = String(s.duration);
    this.lastCaption = -2;
    this.ticks.replaceChildren();
    const mark = (v: number, cls: string, title: string): void => {
      this.ticks.append(h('span', { class: `tick ${cls}`, title, attrs: { style: `left:${((v / s.duration) * 100).toFixed(3)}%` } }));
    };
    for (const f of s.flights) mark(f.v0, f.lostAt !== undefined ? 'lost' : 'flight', s.result.packets.get(f.packetId)?.label ?? '');
    for (const e of s.result.events) {
      if (e.type === 'tcp:retransmit') mark(s.eventV[e.seq]!, 'retx', 'retransmission');
      if (e.type === 'app' && (e.action === 'http-response-received' || e.action === 'dns-answer')) mark(s.eventV[e.seq]!, 'milestone', e.action);
    }
  }

  update(v: number, started: boolean): void {
    const s = this.schedule;
    if (!s) return;
    if (document.activeElement !== this.range) this.range.value = String(v);
    this.clock.textContent = `t = ${fmtTime(s.simTimeAt(v))}`;
    let idx = -1;
    if (started) {
      for (let i = 0; i < s.beats.length; i++) {
        if (s.beats[i]!.v <= v) idx = i;
        else break;
      }
    }
    if (idx !== this.lastCaption) {
      this.lastCaption = idx;
      const b = s.beats[idx];
      this.caption.textContent = b ? b.caption : 'Drag the URL card into the laptop to load the page, or press Space.';
      this.caption.classList.remove('fresh');
      void this.caption.offsetWidth;
      this.caption.classList.add('fresh');
    }
  }
}

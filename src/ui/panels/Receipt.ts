import { MACHINE_NAME } from '../iso/machines/Machine';
import type { Bubble, Schedule } from '../timeline/schedule';
import { button, h } from './dom';

/** The receipt: everything the machines have said so far. Click a line to go back to that moment. */
export class Receipt {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private live: HTMLElement;
  private schedule: Schedule | undefined;
  private rendered = 0;
  private lastSeq = -1;

  constructor(private readonly onSeek: (b: Bubble) => void) {
    this.list = h('ol', { class: 'receipt-list' });
    this.live = h('div', { class: 'sr-only', attrs: { 'aria-live': 'polite' } });
    this.el = h('aside', { class: 'receipt', attrs: { 'aria-label': 'What the machines said' } }, h('div', { class: 'receipt-head' }, h('b', { text: 'Receipt' }), button('✕', () => this.close(), 'icon-btn', 'Close')), this.list, this.live);
  }

  get open(): boolean {
    return this.el.classList.contains('open');
  }

  toggle(): void {
    this.el.classList.toggle('open');
  }

  close(): void {
    this.el.classList.remove('open');
  }

  setSchedule(s: Schedule): void {
    this.schedule = s;
    this.list.replaceChildren();
    this.rendered = 0;
    this.lastSeq = -1;
  }

  update(v: number): void {
    const s = this.schedule;
    if (!s) return;
    const dev = (id: string): string => s.result.scenario.devices.find((d) => d.id === id)?.label ?? id;
    // Append newly reached bubbles; remove ones we scrubbed back past.
    while (this.rendered < s.bubbles.length && s.bubbles[this.rendered]!.v0 <= v) {
      const b = s.bubbles[this.rendered]!;
      const li = h('li', { class: `receipt-line tone-${b.tone}${b.important ? ' important' : ''}`, attrs: { 'data-seq': String(b.seq) } }, h('span', { class: 'receipt-who', text: `${dev(b.deviceId)} · ${MACHINE_NAME[b.machine]}` }), h('span', { class: 'receipt-text', text: b.text }));
      li.addEventListener('click', () => this.onSeek(b));
      this.list.appendChild(li);
      this.rendered++;
    }
    while (this.rendered > 0 && s.bubbles[this.rendered - 1]!.v0 > v) {
      this.list.lastElementChild?.remove();
      this.rendered--;
    }
    const cur = this.rendered ? s.bubbles[this.rendered - 1]! : undefined;
    if (cur && cur.seq !== this.lastSeq) {
      this.lastSeq = cur.seq;
      this.live.textContent = `${dev(cur.deviceId)}: ${cur.text}`;
      for (const li of Array.from(this.list.children)) li.classList.toggle('current', li.getAttribute('data-seq') === String(cur.seq));
      if (this.open) (this.list.lastElementChild as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
    }
  }
}

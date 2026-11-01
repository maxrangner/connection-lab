import { drawSpyglass } from './icons';
import type { Seen } from './story';
import { el, setText } from './svg';

/**
 * Which read to look at after stepping `by` from `picked` (null: following the newest) through `count` reads:
 * stepping onto the newest goes back to following it.
 */
export function stepRead(picked: number | null, count: number, by: number): number | null {
  const i = Math.min(picked ?? Infinity, count - 1) + by;
  return i >= count - 1 ? null : Math.max(0, i);
}

/**
 * The popup above the bar with what the spyglass has read. It stays until dismissed and follows the newest read, unless
 * you step back to an older one.
 */
export class SpyCard {
  private readonly panel = document.createElement('div');
  private readonly older = document.createElement('button');
  private readonly newer = document.createElement('button');
  private readonly count = document.createElement('span');
  private readonly body = document.createElement('div');
  private log: readonly Seen[] = [];
  /** The read being looked at; null follows the newest. */
  private picked: number | null = null;
  private drawn: Seen | null = null;

  constructor(root: HTMLElement, onClose: () => void) {
    this.panel.className = 'spy-card';
    this.panel.hidden = true;
    const top = document.createElement('div');
    top.className = 'spy-top';
    const icon = el('svg', { viewBox: '-24 -24 60 60', width: 24, height: 24, 'aria-hidden': 'true' });
    drawSpyglass(el('g', {}, icon));
    top.appendChild(icon);
    const button = (b: HTMLButtonElement, text: string, label: string, onClick: () => void): void => {
      b.textContent = text;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', onClick);
    };
    button(this.older, '‹', 'Older read', () => this.step(-1));
    button(this.newer, '›', 'Newer read', () => this.step(1));
    const close = document.createElement('button');
    button(close, '×', 'Put the spyglass away', onClose);
    close.className = 'spy-close';
    this.count.className = 'spy-count';
    top.append(this.older, this.count, this.newer, close);
    this.panel.append(top, this.body);
    root.appendChild(this.panel);
  }

  /** A new line or a new run: back to following the newest. */
  reset(): void {
    this.picked = null;
  }

  update(log: readonly Seen[]): void {
    this.log = log;
    this.draw();
  }

  /** Keeps the popup above the bar. */
  /** Where its top edge is on the screen, while it is up. */
  get top(): number | null {
    return this.panel.hidden ? null : this.panel.getBoundingClientRect().top;
  }

  place(bar: HTMLElement): void {
    this.panel.style.bottom = `${(window.innerHeight - bar.getBoundingClientRect().top + 10).toFixed(0)}px`;
  }

  private get index(): number {
    return Math.min(this.picked ?? Infinity, this.log.length - 1);
  }

  private step(by: number): void {
    this.picked = stepRead(this.picked, this.log.length, by);
    this.draw();
  }

  private draw(): void {
    this.panel.hidden = !this.log.length;
    const i = this.index;
    const seen = this.log[i];
    if (!seen) return;
    this.older.disabled = i === 0;
    this.newer.disabled = i === this.log.length - 1;
    setText(this.count, `${i + 1} / ${this.log.length}`);
    if (seen === this.drawn) return;
    this.drawn = seen;
    this.panel.className = `spy-card spy-${seen.kind}`;
    const row = (cls: string, text: string): void => {
      const d = document.createElement('div');
      d.className = cls;
      d.textContent = text;
      this.body.appendChild(d);
    };
    this.body.replaceChildren();
    row('spy-addr', `${seen.from} → ${seen.to}`);
    seen.lines.forEach((l, n) => row(n === 0 ? 'spy-text' : 'spy-text spy-more', l));
  }
}

import { el } from './svg';

/** A button in the bar with a small popup above it. */
export interface MenuItem<T extends string> {
  id: T;
  label: string;
  /** Icon; drawn around the origin. */
  draw?: (g: SVGGElement) => void;
  /** How much of the drawing's space shows, around the origin. */
  span?: number;
}

export class Menu<T extends string> {
  readonly button = document.createElement('button');
  private readonly panel = document.createElement('div');
  private readonly items = new Map<T, HTMLButtonElement>();

  constructor(
    bar: HTMLElement,
    root: HTMLElement,
    text: string,
    label: string,
    items: MenuItem<T>[],
    private readonly onPick: (id: T) => void,
  ) {
    this.button.textContent = text;
    this.button.className = 'menu-button';
    this.button.setAttribute('aria-label', label);
    this.button.setAttribute('aria-haspopup', 'true');
    this.button.setAttribute('aria-expanded', 'false');
    this.button.addEventListener('click', () => this.setOpen(!this.isOpen));
    bar.appendChild(this.button);
    this.panel.className = 'menu-panel';
    this.panel.hidden = true;
    for (const item of items) {
      const b = document.createElement('button');
      b.className = 'menu-item';
      b.setAttribute('aria-pressed', 'false');
      if (item.draw) {
        const span = item.span ?? 40;
        const svg = el('svg', { viewBox: `${-span} ${-span} ${span * 2} ${span * 2}`, width: 44, height: 44, 'aria-hidden': 'true' });
        item.draw(el('g', {}, svg));
        b.appendChild(svg);
      }
      const name = document.createElement('span');
      name.textContent = item.label;
      b.appendChild(name);
      b.addEventListener('click', () => this.onPick(item.id));
      this.items.set(item.id, b);
      this.panel.appendChild(b);
    }
    root.appendChild(this.panel);
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  setOpen(open: boolean): void {
    if (open === this.isOpen) return;
    // Focus goes into the popup and back out with it: the popups sit outside the bar, away from its tab order.
    if (!open && this.panel.contains(document.activeElement)) this.button.focus();
    this.panel.hidden = !open;
    this.button.setAttribute('aria-expanded', String(open));
    if (open) {
      this.place();
      this.items.values().next().value?.focus();
    }
  }

  setOn(id: T, on: boolean): void {
    const b = this.items.get(id);
    b?.classList.toggle('on', on);
    b?.setAttribute('aria-pressed', String(on));
  }

  /** Keeps the popup above its button, inside the screen. */
  place(): void {
    if (!this.isOpen) return;
    const r = this.button.getBoundingClientRect();
    const w = this.panel.offsetWidth;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    this.panel.style.left = `${left.toFixed(0)}px`;
    this.panel.style.bottom = `${(window.innerHeight - r.top + 10).toFixed(0)}px`;
  }
}

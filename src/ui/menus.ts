import { el } from './svg';

/** A button, in the bar or on the table, with a small popup by it. */
export interface MenuItem<T extends string> {
  id: T;
  label: string;
  /** What it does, in a few words. Items with one make the popup a list. */
  hint?: string;
  /** Icon; drawn around the origin. */
  draw?: (g: SVGGElement) => void;
  /** How much of the drawing's space shows, around the origin. */
  span?: number;
}

export class Menu<T extends string> {
  readonly button = document.createElement('button');
  private readonly panel = document.createElement('div');
  private readonly items = new Map<T, HTMLButtonElement>();
  /** A popup that hangs off this one, and closes with it. */
  private inner?: { setOpen(open: boolean): void };

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
      if (item.hint) {
        this.panel.classList.add('menu-list');
        const hint = document.createElement('span');
        hint.className = 'menu-hint';
        hint.textContent = item.hint;
        b.appendChild(hint);
      }
      b.addEventListener('click', () => this.onPick(item.id));
      this.items.set(item.id, b);
      this.panel.appendChild(b);
    }
    if (this.isList) {
      for (const end of ['up', 'down']) {
        const more = document.createElement('div');
        more.className = `menu-more ${end}`;
        more.setAttribute('aria-hidden', 'true');
        if (end === 'up') this.panel.prepend(more);
        else this.panel.append(more);
      }
      this.panel.addEventListener('scroll', () => this.showMore(), { passive: true });
    }
    root.appendChild(this.panel);
  }

  /** Sets the button and its popup apart with a class of their own. */
  mark(name: string): void {
    this.button.classList.add(name);
    this.panel.classList.add(name);
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  private get isList(): boolean {
    return this.panel.classList.contains('menu-list');
  }

  /** A phone shows no scroll bar, so a list says itself when there is more of it, and which way. */
  private showMore(): void {
    const { scrollTop, scrollHeight, clientHeight } = this.panel;
    this.panel.classList.toggle('more-up', scrollTop > 2);
    this.panel.classList.toggle('more-down', scrollTop + clientHeight < scrollHeight - 2);
  }

  setOpen(open: boolean): void {
    if (open === this.isOpen) return;
    if (!open) this.inner?.setOpen(false);
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

  /** Hangs a popup off this one. */
  hold(inner: { setOpen(open: boolean): void }): void {
    this.inner = inner;
  }

  /** Gives an item a row of its own in the popup, for something else to go beside it. */
  row(id: T): HTMLElement {
    const b = this.items.get(id)!;
    const row = document.createElement('div');
    row.className = 'menu-row';
    b.replaceWith(row);
    row.appendChild(b);
    return row;
  }

  /** Keeps the popup by its button, inside the screen: above it, unless only below fits. */
  place(): void {
    if (!this.isOpen) return;
    const r = this.button.getBoundingClientRect();
    const w = this.panel.offsetWidth;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    this.panel.style.left = `${left.toFixed(0)}px`;
    // A bar in two rows leaves less room than a full screen: a long list stops at what is really there.
    if (this.isList) this.panel.style.maxHeight = `${(Math.max(r.top, window.innerHeight - r.bottom) - 18).toFixed(0)}px`;
    const h = this.panel.offsetHeight;
    const above = r.top - h - 18 >= 0 || r.bottom + 10 + h > window.innerHeight;
    this.panel.style.bottom = above ? `${(window.innerHeight - r.top + 10).toFixed(0)}px` : 'auto';
    this.panel.style.top = above ? 'auto' : `${(r.bottom + 10).toFixed(0)}px`;
    if (this.isList) this.showMore();
  }
}

import { h } from '../panels/dom';
import type { Bubble } from '../timeline/schedule';
import type { Vec3 } from './project';
import { iso } from './project';

export interface BubbleAnchor {
  world: Vec3;
}

/**
 * HTML speech bubbles over the stage. Positioned every frame from a world anchor through the SVG's screen
 * matrix, so text wraps and scales like any UI text.
 */
export class Bubbles {
  readonly el: HTMLElement;
  private pool: HTMLElement[] = [];
  private onDismiss: ((b: Bubble) => void) | undefined;

  constructor(
    private readonly stage: HTMLElement,
    private readonly svg: SVGSVGElement,
  ) {
    this.el = h('div', { class: 'bubbles' });
    stage.appendChild(this.el);
  }

  setDismiss(fn: (b: Bubble) => void): void {
    this.onDismiss = fn;
  }

  /**
   * @param active bubbles to show with their anchors and whether each is a gate waiting to be dismissed.
   */
  render(active: { b: Bubble; anchor: Vec3; gate: boolean; age: number; left: number }[]): void {
    const m = this.svg.getScreenCTM();
    const stageRect = this.stage.getBoundingClientRect();
    active.forEach((a, i) => {
      let node = this.pool[i];
      if (!node) {
        node = h('div', { class: 'bubble' }, h('div', { class: 'bubble-text' }), h('div', { class: 'bubble-tail' }), h('button', { class: 'bubble-ok', text: 'Got it →', attrs: { type: 'button' } }));
        this.el.appendChild(node);
        this.pool[i] = node;
      }
      const text = node.querySelector('.bubble-text') as HTMLElement;
      if (node.dataset.seq !== String(a.b.seq)) {
        node.dataset.seq = String(a.b.seq);
        text.textContent = a.b.text;
        node.className = `bubble tone-${a.b.tone}${a.b.important ? ' important' : ''}`;
        const ok = node.querySelector('.bubble-ok') as HTMLButtonElement;
        ok.onclick = (e) => {
          e.stopPropagation();
          this.onDismiss?.(a.b);
        };
      }
      node.classList.toggle('gate', a.gate);
      const s = iso(a.anchor.x, a.anchor.y, a.anchor.z);
      let x = s.sx;
      let y = s.sy;
      if (m) {
        const p = new DOMPoint(s.sx, s.sy).matrixTransform(m);
        x = p.x - stageRect.left;
        y = p.y - stageRect.top;
      }
      const fade = Math.min(1, a.age / 0.18, a.gate ? 1 : Math.max(0, a.left / 0.3));
      node.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-22%, -100%) translateY(${(-(1 - Math.min(1, a.age / 0.18)) * 8).toFixed(1)}px)`;
      node.style.opacity = fade.toFixed(3);
      node.style.display = '';
    });
    for (let i = active.length; i < this.pool.length; i++) this.pool[i]!.style.display = 'none';
  }
}

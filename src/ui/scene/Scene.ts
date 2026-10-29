import type { DeviceSpec, LinkSpec } from '../../sim';
import { LAYER_COLOR, type LayerModel } from '../content/layers';
import { fmtTime } from '../content/narration';
import type { Flight, Schedule, Track } from '../timeline/schedule';
import {
  CARD_W,
  cardGeom,
  clamp01,
  easeInOut,
  easeOut,
  exitPoint,
  HEAD_H,
  LABEL_W,
  lerp,
  nodeRect,
  rowCenter,
  stripLeft,
  type CardGeom,
} from './geometry';
import { drawIcon } from './icons';
import { applyGrow, buildStrip, grownWidth, setDiff, STRIP_H, type StripEl } from './strip';
import { el, setAttr, show, text } from './svg';
import { buildTrain, type Train } from './wire';

export interface SceneHandlers {
  onPickPdu(pduId: string, ctx: { flight?: Flight; track?: Track }): void;
  onPickDevice(deviceId: string): void;
}

export type CameraMode = 'follow' | 'overview' | 'free';

interface DeviceView {
  spec: DeviceSpec;
  geom: CardGeom;
  g: SVGGElement;
  node: SVGGElement;
  card: SVGGElement;
  cardBg: SVGRectElement;
  cardBody: SVGGElement;
  title: SVGTextElement;
  stateText: SVGTextElement;
  timerG: SVGGElement;
  timerArc: SVGPathElement;
  timerText: SVGTextElement;
  rowEls: SVGGElement[];
  openness: number;
  /** Current outer rectangle (node or card, depending on openness). */
  rect: { x: number; y: number; w: number; h: number };
  badgePool: SVGGElement[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const BADGE_H = 17;

export class Scene {
  readonly svg: SVGSVGElement;
  readonly world: SVGGElement;
  private gLinks: SVGGElement;
  private gDevices: SVGGElement;
  private gStrips: SVGGElement;
  private gFlights: SVGGElement;
  private gBadges: SVGGElement;
  readonly gOverlay: SVGGElement;
  private devices = new Map<string, DeviceView>();
  private strips = new Map<string, StripEl>();
  private trains = new Map<string, Train>();
  private sparks = new Map<string, SVGGElement>();
  private visibleStrips = new Set<string>();
  private visibleTrains = new Set<string>();
  private schedule!: Schedule;
  private model: LayerModel = 'tcpip';
  private textWidth = new Map<string, number>();
  private measure: SVGTextElement;
  // camera
  cameraMode: CameraMode = 'follow';
  private cam = { x: 0, y: 0, w: 1600 };
  private freeCam = { x: 0, y: 0, w: 1600 };
  private bounds: Rect = { x: 0, y: 0, w: 1600, h: 900 };
  private lastV = 0;
  /** Packets/flights to emphasise (selected in the inspector). */
  selectedPdu: string | undefined;

  constructor(
    private readonly container: HTMLElement,
    private readonly handlers: SceneHandlers,
  ) {
    this.svg = el('svg', { class: 'scene', preserveAspectRatio: 'xMidYMid meet' });
    container.appendChild(this.svg);
    const defs = el('defs', {}, this.svg);
    const glow = el('filter', { id: 'glow', x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs);
    el('feGaussianBlur', { stdDeviation: 2.2, result: 'b' }, glow);
    const merge = el('feMerge', {}, glow);
    el('feMergeNode', { in: 'b' }, merge);
    el('feMergeNode', { in: 'SourceGraphic' }, merge);
    this.world = el('g', { class: 'world' }, this.svg);
    this.gLinks = el('g', { class: 'links' }, this.world);
    this.gDevices = el('g', { class: 'devices' }, this.world);
    this.gStrips = el('g', { class: 'strips' }, this.world);
    this.gFlights = el('g', { class: 'flights' }, this.world);
    this.gBadges = el('g', { class: 'badges' }, this.world);
    this.gOverlay = el('g', { class: 'overlay' }, this.world);
    this.measure = el('text', { class: 'badge-text', x: -9999, y: -9999 }, this.svg);
    this.installCameraControls();
  }

  setSchedule(s: Schedule, model: LayerModel): void {
    this.schedule = s;
    this.model = model;
    this.gLinks.replaceChildren();
    this.gDevices.replaceChildren();
    this.gStrips.replaceChildren();
    this.gFlights.replaceChildren();
    this.gBadges.replaceChildren();
    this.devices.clear();
    this.strips.clear();
    this.trains.clear();
    this.sparks.clear();
    this.visibleStrips.clear();
    this.visibleTrains.clear();
    const sc = s.result.scenario;
    for (const d of sc.devices) this.buildDevice(d);
    for (const l of sc.links) this.buildLink(l);
    // Bounds: every card fully open, plus room for badges.
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const d of this.devices.values()) {
      x0 = Math.min(x0, d.geom.x);
      y0 = Math.min(y0, d.geom.y - 3 * (BADGE_H + 4));
      x1 = Math.max(x1, d.geom.x + d.geom.w);
      y1 = Math.max(y1, d.geom.y + d.geom.h + 30);
    }
    this.bounds = { x: x0 - 30, y: y0 - 10, w: x1 - x0 + 60, h: y1 - y0 + 20 };
    if (this.cam.w === 1600 && this.cam.x === 0) this.cam = { x: this.bounds.x + this.bounds.w / 2, y: this.bounds.y + this.bounds.h / 2, w: this.bounds.w };
  }

  get sceneBounds(): Rect {
    return this.bounds;
  }

  deviceCenter(id: string): { x: number; y: number } {
    const d = this.devices.get(id)!;
    return { x: d.spec.layout.x, y: d.spec.layout.y };
  }

  private buildDevice(spec: DeviceSpec): void {
    const geom = cardGeom(spec, this.model);
    const g = el('g', { class: `device dev-${spec.kind}`, 'data-id': spec.id }, this.gDevices);
    const card = el('g', { class: 'card' }, g);
    const cardBg = el('rect', { class: 'card-bg', rx: 10 }, card);
    const cardBody = el('g', { class: 'card-body' }, card);
    const title = text(cardBody, geom.x + 12, geom.y + 22, spec.label, 'card-title');
    text(cardBody, geom.x + 12 + spec.label.length * 7.6 + 8, geom.y + 22, spec.sublabel ?? '', 'card-sub');
    const rowEls: SVGGElement[] = [];
    for (const r of geom.rows) {
      const rg = el('g', { class: `row ${r.def.thin ? 'thin' : ''} ${r.def.peek ? 'peek' : ''}` }, cardBody);
      const color = r.def.layer ? LAYER_COLOR[r.def.layer] : '#64748b';
      el('rect', { class: 'row-bg', x: geom.x + 6, y: r.y + 1, width: geom.w - 12, height: r.h - 2, rx: 4 }, rg);
      el('rect', { class: 'row-tab', x: geom.x + 6, y: r.y + 1, width: 4, height: r.h - 2, rx: 2, fill: color }, rg);
      text(rg, geom.x + 15, r.y + r.h / 2 + (r.def.thin ? 3 : 4), `${r.def.number} ${r.def.name}`, r.def.thin ? 'row-label thin' : 'row-label', { fill: color });
      if (r.def.thin) text(rg, geom.x + LABEL_W + 6, r.y + r.h / 2 + 3, '(handled inside HTTP / the app)', 'row-note');
      rowEls.push(rg);
    }
    // TCP state lives in the transport row, right-aligned (drawn after the rows so it is on top).
    const l4 = geom.rows.find((r) => r.def.layer === 4);
    const stateText = text(cardBody, geom.x + geom.w - 14, l4 ? l4.y + 12 : geom.y + 22, '', 'card-state', { 'text-anchor': 'end' });
    const node = el('g', { class: 'node' }, g);
    const nr = nodeRect(spec);
    el('rect', { class: 'node-bg', x: nr.x, y: nr.y, width: nr.w, height: nr.h, rx: 14 }, node);
    const icon = drawIcon(spec.kind, node);
    icon.setAttribute('transform', `translate(${spec.layout.x},${spec.layout.y - 4})`);
    text(node, spec.layout.x, nr.y + nr.h + 16, spec.label, 'node-label', { 'text-anchor': 'middle' });
    text(node, spec.layout.x, nr.y + nr.h + 30, spec.sublabel ?? '', 'node-sub', { 'text-anchor': 'middle' });
    const timerG = el('g', { class: 'timer' }, g);
    el('circle', { class: 'timer-ring', r: 9 }, timerG);
    const timerArc = el('path', { class: 'timer-arc' }, timerG);
    const timerText = text(timerG, 14, 4, '', 'timer-text');
    const hit = el('rect', { class: 'device-hit', x: nr.x, y: nr.y, width: nr.w, height: nr.h, fill: 'transparent' }, g);
    const pick = (ev: Event): void => {
      ev.stopPropagation();
      this.handlers.onPickDevice(spec.id);
    };
    hit.addEventListener('click', pick);
    title.addEventListener('click', pick);
    this.devices.set(spec.id, {
      spec,
      geom,
      g,
      node,
      card,
      cardBg,
      cardBody,
      title,
      stateText,
      timerG,
      timerArc,
      timerText,
      rowEls,
      openness: 0,
      rect: nr,
      badgePool: [],
    });
  }

  private buildLink(l: LinkSpec): void {
    const a = this.ownerOf(l.a);
    const b = this.ownerOf(l.b);
    if (!a || !b) return;
    const g = el('g', { class: 'link', 'data-id': l.id }, this.gLinks);
    el('line', { class: 'link-line', x1: a.layout.x, y1: a.layout.y, x2: b.layout.x, y2: b.layout.y }, g);
    const mx = (a.layout.x + b.layout.x) / 2;
    const my = (a.layout.y + b.layout.y) / 2;
    const ang = (Math.atan2(b.layout.y - a.layout.y, b.layout.x - a.layout.x) * 180) / Math.PI;
    const flip = ang > 90 || ang < -90 ? 180 : 0;
    const t = text(g, 0, -24, l.label, 'link-label', { 'text-anchor': 'middle' });
    t.setAttribute('transform', `translate(${mx},${my}) rotate(${ang + flip})`);
  }

  private ownerOf(ifaceId: string): DeviceSpec | undefined {
    return this.schedule.result.scenario.devices.find((d) => d.ifaces.some((i) => i.id === ifaceId));
  }

  // ─────────────────────────── per-frame rendering ───────────────────────────

  render(v: number, dt: number): void {
    const s = this.schedule;
    if (!s) return;
    this.lastV = v;
    for (const d of this.devices.values()) this.renderDevice(d, v);
    this.renderTracks(v);
    this.renderFlights(v);
    this.renderBadges(v);
    this.renderCamera(v, dt);
  }

  private openness(id: string, v: number): number {
    const spans = this.schedule.cardSpans.get(id) ?? [];
    let o = 0;
    for (const [a, b] of spans) {
      if (v < a || v > b) continue;
      o = Math.max(o, Math.min(clamp01((v - a) / 0.45), clamp01((b - v) / 0.45)));
    }
    return easeInOut(o);
  }

  private renderDevice(d: DeviceView, v: number): void {
    const o = this.openness(d.spec.id, v);
    d.openness = o;
    const nr = nodeRect(d.spec);
    const g = d.geom;
    const r = { x: lerp(nr.x, g.x, o), y: lerp(nr.y, g.y, o), w: lerp(nr.w, g.w, o), h: lerp(nr.h, g.h, o) };
    d.rect = o > 0.001 ? r : nr;
    show(d.card, o > 0.001);
    if (o > 0.001) {
      setAttr(d.cardBg, 'x', r.x.toFixed(1));
      setAttr(d.cardBg, 'y', r.y.toFixed(1));
      setAttr(d.cardBg, 'width', r.w.toFixed(1));
      setAttr(d.cardBg, 'height', r.h.toFixed(1));
      d.cardBody.style.opacity = clamp01((o - 0.55) / 0.45).toFixed(3);
    }
    d.node.style.opacity = (1 - clamp01(o / 0.5)).toFixed(3);
    // TCP state (latest at v).
    let state = '';
    for (const st of this.schedule.tcpStates) if (st.deviceId === d.spec.id && st.v <= v) state = st.state;
    d.stateText.textContent = state ? `TCP ${state}` : '';
    // Timers.
    const active = this.schedule.timers.filter((t) => t.deviceId === d.spec.id && t.v0 <= v && v < t.v1);
    const t = active[active.length - 1];
    show(d.timerG, !!t);
    if (t) {
      const elapsed = this.schedule.simTimeAt(v) - this.schedule.simTimeAt(t.v0);
      const frac = clamp01(elapsed / t.seconds);
      const a = frac * Math.PI * 2;
      const big = a > Math.PI ? 1 : 0;
      d.timerArc.setAttribute('d', frac >= 0.999 ? 'M0 -9A9 9 0 1 1 -0.01 -9Z' : `M0 0L0 -9A9 9 0 ${big} 1 ${(9 * Math.sin(a)).toFixed(2)} ${(-9 * Math.cos(a)).toFixed(2)}Z`);
      const label = t.kind === 'tcp-rto' ? 'RTO' : t.kind === 'dns-retry' ? 'DNS' : t.kind === 'arp-retry' ? 'ARP' : 'TIME_WAIT';
      d.timerText.textContent = `${label} ${fmtTime(Math.max(0, t.seconds - elapsed))}`;
      // Just outside the top-right corner of the node/card.
      d.timerG.setAttribute('transform', `translate(${(d.rect.x + d.rect.w + 14).toFixed(1)},${(d.rect.y + 10).toFixed(1)})`);
    }
  }

  private strip(track: Track, pduId: string): StripEl {
    const key = `${track.id}:${pduId}`;
    let s = this.strips.get(key);
    if (!s) {
      const pdu = this.schedule.result.pdus.get(pduId)!;
      const pk = this.schedule.result.packets.get(track.packetId);
      s = buildStrip(pdu, pk?.label ?? '');
      s.g.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.handlers.onPickPdu(pduId, { track });
      });
      this.gStrips.appendChild(s.g);
      this.strips.set(key, s);
    }
    return s;
  }

  private renderTracks(v: number): void {
    const now = new Set<string>();
    for (const tr of this.schedule.tracks) {
      const first = tr.kfs[0];
      if (!first || v < first.v0 || v >= tr.end) continue;
      const d = this.devices.get(tr.deviceId);
      if (!d) continue;
      let kf = first;
      for (const k of tr.kfs) if (k.v0 <= v) kf = k;
      const u = clamp01((v - kf.v0) / Math.max(1e-6, kf.v1 - kf.v0));
      const e = easeInOut(u);
      const yFrom = rowCenter(d.geom, kf.fromRow);
      const yTo = rowCenter(d.geom, kf.row);
      let y = lerp(yFrom, yTo, e);
      let pduId = kf.pduId;
      let grow = 1;
      let opacity = 1;
      let diff = 0;
      switch (kf.mode) {
        case 'appear':
          opacity = e;
          break;
        case 'encap':
          grow = e;
          break;
        case 'decap':
          if (u < 1 && kf.fromPduId) {
            pduId = kf.fromPduId;
            grow = 1 - e;
          }
          break;
        case 'change':
          diff = Math.sin(Math.PI * Math.min(1, u * 1.2));
          if (u >= 1) diff = 0.35;
          break;
        case 'rx':
          opacity = clamp01(u * 2);
          break;
        case 'tx':
          if (kf.fromPduId) pduId = kf.fromPduId;
          opacity = 1 - clamp01((u - 0.55) / 0.45);
          break;
      }
      // End-of-life animations.
      const left = tr.end - v;
      if (left < 0.4) {
        const k = clamp01(left / 0.4);
        opacity *= k;
        if (tr.endKind === 'absorb') y -= (1 - k) * 12;
      }
      opacity *= clamp01((d.openness - 0.6) / 0.4);
      const s = this.strip(tr, pduId);
      const key = `${tr.id}:${pduId}`;
      now.add(key);
      applyGrow(s, grow);
      setDiff(s, kf.mode === 'change' ? kf.diff : undefined, diff);
      if (tr.isStream && tr.consumed?.length) {
        let bytes = 0;
        for (const c of tr.consumed) if (c.v <= v) bytes = c.bytes;
        const total = this.schedule.result.pdus.get(pduId)?.bytes.length ?? 1;
        const frac = clamp01(bytes / total);
        const w = s.layout.width;
        s.inner.setAttribute('transform', `translate(${(w * frac).toFixed(2)},0) scale(${(1 - frac).toFixed(4)},1)`);
      }
      const x = stripLeft(d.geom);
      const maxW = d.geom.x + CARD_W - 10 - x;
      const w = grownWidth(s, grow);
      const sc = w > maxW ? maxW / w : 1;
      s.g.setAttribute('transform', `translate(${x.toFixed(1)},${(y - STRIP_H / 2).toFixed(1)}) scale(${sc.toFixed(3)},1)`);
      s.g.style.opacity = opacity.toFixed(3);
      s.g.classList.toggle('dropped', tr.endKind === 'drop' && left < 1.0);
      s.g.classList.toggle('selected', this.selectedPdu === pduId);
      show(s.g, true);
    }
    for (const key of this.visibleStrips) if (!now.has(key)) show(this.strips.get(key)!.g, false);
    this.visibleStrips = now;
    this.renderPage(v);
  }

  private page?: { g: SVGGElement; rows: SVGGElement[]; pduId: string; title: string };

  /**
   * The payoff: the reassembled HTTP response, one cell per byte, coloured by what the bytes are. Shown under the
   * device that received it once the browser has the whole message.
   */
  private renderPage(v: number): void {
    const tr = this.schedule.tracks.find((t) => t.endKind === 'final');
    const first = tr?.kfs[0];
    if (!tr || !first || v < first.v0) {
      if (this.page) show(this.page.g, false);
      return;
    }
    const d = this.devices.get(tr.deviceId)!;
    if (!this.page || this.page.pduId !== first.pduId) {
      this.page?.g.remove();
      const pdu = this.schedule.result.pdus.get(first.pduId)!;
      const http = pdu.layers[0];
      const kind = new Uint8Array(pdu.bytes.length); // 0 head, 1 framing, 2 body
      for (const f of http?.fields ?? []) {
        const k = f.key === 'http.body' ? 2 : f.key.startsWith('http.chunk') ? 1 : 0;
        for (let i = f.offset; i < f.offset + f.length; i++) kind[i] = k;
      }
      const html = new TextDecoder().decode(pdu.bytes);
      const title = /<title>(.*?)<\/title>/i.exec(html)?.[1] ?? '';
      const COLS = 40;
      const C = 4.6;
      const g = el('g', { class: 'page' }, this.gStrips);
      const rowsN = Math.ceil(pdu.bytes.length / COLS);
      const W = COLS * C + 16;
      const H = rowsN * C + 46;
      el('path', { class: 'page-bg', d: `M0 0h${W - 14}l14 14v${H - 14}h-${W}z` }, g);
      el('path', { class: 'page-fold', d: `M${W - 14} 0v14h14` }, g);
      text(g, 8, 15, `${pdu.bytes.length} bytes, in order`, 'page-title');
      const colors = ['#86efac', '#64748b', '#22c55e'];
      const rows: SVGGElement[] = [];
      for (let r = 0; r < rowsN; r++) {
        const rg = el('g', {}, g);
        const paths = ['', '', ''];
        for (let c = 0; c < COLS; c++) {
          const i = r * COLS + c;
          if (i >= pdu.bytes.length) break;
          paths[kind[i]!] += `M${8 + c * C} 0h${C - 1}v${C - 1}h-${C - 1}z`;
        }
        paths.forEach((p, k) => p && el('path', { d: p, fill: colors[k]!, 'fill-opacity': k === 0 ? 0.55 : 0.95 }, rg));
        rows.push(rg);
      }
      const legendY = 24 + rowsN * C + 14;
      text(g, 8, legendY, 'status line + headers', 'page-legend', { fill: colors[0]! });
      text(g, 112, legendY, 'chunk sizes', 'page-legend', { fill: colors[1]! });
      text(g, 172, legendY, 'HTML', 'page-legend', { fill: colors[2]! });
      if (title) text(g, 0, H + 18, `→ the browser renders “${title}”`, 'page-caption');
      this.page = { g, rows, pduId: first.pduId, title };
    }
    const p = this.page;
    const x = d.geom.x + 8;
    const y = d.geom.y + d.geom.h + 18;
    p.g.setAttribute('transform', `translate(${x},${y})`);
    const age = v - first.v0;
    p.rows.forEach((rg, r) => {
      const k = easeOut(clamp01((age - r * 0.03) / 0.5));
      rg.setAttribute('transform', `translate(${((1 - k) * 60).toFixed(1)},${(24 + r * 4.6 - (1 - k) * 40).toFixed(1)})`);
      rg.style.opacity = k.toFixed(2);
    });
    p.g.style.opacity = clamp01(age / 0.3).toFixed(2);
    show(p.g, true);
  }

  /** Port where a link meets the device's current outline. */
  private port(fromId: string, toId: string): { x: number; y: number } {
    const a = this.devices.get(fromId)!;
    const b = this.devices.get(toId)!;
    return exitPoint(a.rect, a.spec.layout.x, a.spec.layout.y, b.spec.layout.x, b.spec.layout.y);
  }

  flightHead(f: Flight, v: number): { x: number; y: number } {
    const p0 = this.port(f.from, f.to);
    const p1 = this.port(f.to, f.from);
    const end = f.lostAt ?? f.v1;
    const u = clamp01((v - f.v0) / Math.max(1e-6, f.v1 - f.v0));
    const uu = f.lostAt !== undefined ? Math.min(u, (end - f.v0) / (f.v1 - f.v0)) : u;
    return { x: lerp(p0.x, p1.x, uu), y: lerp(p0.y, p1.y, uu) };
  }

  private renderFlights(v: number): void {
    const now = new Set<string>();
    for (const f of this.schedule.flights) {
      if (v < f.v0 || v >= f.v1) continue;
      const p0 = this.port(f.from, f.to);
      const p1 = this.port(f.to, f.from);
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const D = Math.hypot(dx, dy) || 1;
      const ux = dx / D;
      const uy = dy / D;
      const side = f.from < f.to ? 1 : -1;
      const off = 7 * side;
      let train = this.trains.get(f.id);
      if (!train) {
        const pdu = this.schedule.result.pdus.get(f.frameId)!;
        train = buildTrain(pdu, f.wireBytes);
        const tr = train;
        tr.g.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.handlers.onPickPdu(f.frameId, { flight: f });
        });
        el('rect', { class: 'train-hit', x: -tr.length - 6, y: -14, width: tr.length + 12, height: 28 }, tr.wave);
        this.gFlights.appendChild(tr.g);
        this.trains.set(f.id, tr);
      }
      const lost = f.lostAt !== undefined && v >= f.lostAt;
      const travelEnd = f.lostAt ?? f.v1;
      const total = f.lostAt !== undefined ? (f.lostAt - f.v0) * 2 : f.v1 - f.v0;
      const u = clamp01((Math.min(v, travelEnd) - f.v0) / total);
      // The head travels the whole link plus the train length, so the tail also arrives.
      const s = lerp(0, D + train.length, f.lostAt !== undefined ? u : easeInOut(u) * 0.15 + u * 0.85);
      const headX = p0.x + ux * Math.min(s, D) + -uy * off;
      const headY = p0.y + uy * Math.min(s, D) + ux * off;
      const ang = (Math.atan2(uy, ux) * 180) / Math.PI;
      // Clip the visible part to the link: shrink the train while entering/leaving.
      const visible = Math.min(s, train.length, D + train.length - s);
      const scale = clamp01(visible / train.length);
      train.wave.setAttribute('transform', `translate(${headX.toFixed(1)},${headY.toFixed(1)}) rotate(${ang.toFixed(2)}) scale(${scale.toFixed(3)},1)`);
      // Label sits beside the train on its own side of the link (the link's name is on the other side).
      const mid = Math.max(0, Math.min(s, D) - (train.length * scale) / 2);
      const lo = side * 24;
      train.label.setAttribute('x', (p0.x + ux * mid - uy * lo).toFixed(1));
      train.label.setAttribute('y', (p0.y + uy * mid + ux * lo + 3).toFixed(1));
      train.label.style.opacity = scale.toFixed(2);
      train.g.classList.toggle('selected', this.selectedPdu === f.frameId);
      show(train.wave, !lost);
      show(train.label, !lost);
      train.g.style.opacity = '1';
      if (lost) this.renderSparks(f, train, headX, headY, ang, v - f.lostAt!);
      else if (this.sparks.has(f.id)) show(this.sparks.get(f.id)!, false);
      show(train.g, true);
      now.add(f.id);
    }
    // Dim a link's name while frames travel on it, so the frame labels stay readable.
    const busy = new Set(this.schedule.flights.filter((f) => now.has(f.id)).map((f) => f.linkId));
    for (const lg of Array.from(this.gLinks.children)) lg.classList.toggle('busy', busy.has(lg.getAttribute('data-id') ?? ''));
    for (const id of this.visibleTrains) {
      if (!now.has(id)) {
        show(this.trains.get(id)!.g, false);
        const sp = this.sparks.get(id);
        if (sp) show(sp, false);
      }
    }
    this.visibleTrains = now;
  }

  private renderSparks(f: Flight, train: Train, x: number, y: number, ang: number, age: number): void {
    let g = this.sparks.get(f.id);
    if (!g) {
      g = el('g', { class: 'sparks' }, this.gFlights);
      let seed = f.seq * 9301 + 49297;
      const rnd = (): number => ((seed = (seed * 233280 + 49297) % 233280) / 233280);
      for (const c of train.cells.filter((_, i) => i % 2 === 0)) {
        const p = el('rect', { width: 2.6, height: 2.6, fill: c.color, 'data-x': c.x, 'data-y': c.y, 'data-vx': (rnd() - 0.5) * 70, 'data-vy': (rnd() - 0.7) * 70 }, g);
        void p;
      }
      el('text', { class: 'lost-mark', x: 0, y: 4, 'text-anchor': 'middle' }, g).textContent = '✕ lost';
      this.sparks.set(f.id, g);
    }
    show(g, true);
    const k = clamp01(age / 1.0);
    const rad = (ang * Math.PI) / 180;
    for (const p of Array.from(g.querySelectorAll('rect'))) {
      const cx = Number(p.getAttribute('data-x'));
      const cy = Number(p.getAttribute('data-y'));
      const px = x + cx * Math.cos(rad) - cy * Math.sin(rad) + Number(p.getAttribute('data-vx')) * easeOut(k);
      const py = y + cx * Math.sin(rad) + cy * Math.cos(rad) + Number(p.getAttribute('data-vy')) * easeOut(k) + 40 * k * k;
      p.setAttribute('x', px.toFixed(1));
      p.setAttribute('y', py.toFixed(1));
    }
    g.style.opacity = (1 - k * 0.85).toFixed(3);
    const mark = g.querySelector('text')!;
    mark.setAttribute('x', (x - 20 * Math.cos(rad)).toFixed(1));
    mark.setAttribute('y', (y - 14).toFixed(1));
  }

  private badgeWidth(s: string): number {
    let w = this.textWidth.get(s);
    if (w === undefined) {
      this.measure.textContent = s;
      w = this.measure.getComputedTextLength() || s.length * 5.6;
      this.textWidth.set(s, w);
    }
    return w;
  }

  private renderBadges(v: number): void {
    for (const d of this.devices.values()) {
      const active = this.schedule.badges.filter((b) => b.deviceId === d.spec.id && b.v0 <= v && v < b.v1).slice(-3);
      const above = d.geom.y - 3 * (BADGE_H + 4) > this.bounds.y + 4;
      active.forEach((b, i) => {
        let g = d.badgePool[i];
        if (!g) {
          g = el('g', { class: 'badge' }, this.gBadges);
          el('rect', { class: 'badge-bg', rx: 8, height: BADGE_H }, g);
          el('text', { class: 'badge-text', x: 8, y: 12 }, g);
          d.badgePool[i] = g;
        }
        const t = g.querySelector('text')!;
        if (t.textContent !== b.text) t.textContent = b.text;
        const w = this.badgeWidth(b.text) + 16;
        g.querySelector('rect')!.setAttribute('width', w.toFixed(1));
        g.setAttribute('class', `badge tone-${b.tone}`);
        const age = v - b.v0;
        const fade = Math.min(clamp01(age / 0.2), clamp01((b.v1 - v) / 0.3));
        const slot = active.length - 1 - i;
        const x = d.rect.x + d.rect.w / 2 - w / 2;
        const y = above ? d.rect.y - 8 - (slot + 1) * (BADGE_H + 4) : d.rect.y + d.rect.h + 8 + slot * (BADGE_H + 4) + (d.openness < 0.5 ? 34 : 0);
        g.setAttribute('transform', `translate(${x.toFixed(1)},${(y + (1 - fade) * 6).toFixed(1)})`);
        g.style.opacity = fade.toFixed(3);
        show(g, true);
      });
      for (let i = active.length; i < d.badgePool.length; i++) show(d.badgePool[i]!, false);
    }
  }

  // ─────────────────────────── camera ───────────────────────────

  /** What the follow camera should frame: the device doing something, or both ends of a link in use. */
  private focusFrame(v: number): { x0: number; y0: number; x1: number; y1: number } | undefined {
    let bestV = -Infinity;
    let ids: string[] | undefined;
    for (const b of this.schedule.beats) {
      if (b.v > v) break;
      if (b.v >= bestV && b.deviceId) {
        bestV = b.v;
        ids = [b.deviceId];
      }
    }
    for (const f of this.schedule.flights) {
      if (f.v0 > v || f.v0 < bestV) continue;
      bestV = f.v0;
      ids = v < f.v1 ? [f.from, f.to] : [f.to];
    }
    if (!ids) return undefined;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const final = this.schedule.tracks.find((t) => t.endKind === 'final');
    for (const id of ids) {
      const g = this.devices.get(id)!.geom;
      x0 = Math.min(x0, g.x - 40);
      y0 = Math.min(y0, g.y - 80);
      x1 = Math.max(x1, g.x + g.w + 120);
      // Make room for the reassembled page under the receiving device.
      const pageShown = final && final.deviceId === id && v >= (final.kfs[0]?.v0 ?? Infinity);
      y1 = Math.max(y1, g.y + g.h + (pageShown ? 200 : 30));
    }
    return { x0, y0, x1, y1 };
  }

  /** Pixels of the stage covered by panels (inspector), so the camera frames the visible part. */
  insets = { right: 0, bottom: 0 };

  /** Camera that shows the frame rectangle inside the visible (uncovered) part of the stage. */
  private fit(f: { x0: number; y0: number; x1: number; y1: number }, minW: number): { x: number; y: number; w: number } {
    const r = this.container.getBoundingClientRect();
    const W = Math.max(1, r.width);
    const H = Math.max(1, r.height);
    const vw = Math.max(80, W - this.insets.right);
    const vh = Math.max(80, H - this.insets.bottom);
    const w = Math.max(((f.x1 - f.x0) * W) / vw, ((f.y1 - f.y0) * W) / vh, minW);
    const s = w / W;
    return { x: (f.x0 + f.x1) / 2 + (this.insets.right / 2) * s, y: (f.y0 + f.y1) / 2 + (this.insets.bottom / 2) * s, w };
  }

  private renderCamera(v: number, dt: number): void {
    const B = this.bounds;
    const all = { x0: B.x, y0: B.y, x1: B.x + B.w, y1: B.y + B.h };
    let target: { x: number; y: number; w: number };
    if (this.cameraMode === 'free') target = this.freeCam;
    else if (this.cameraMode === 'overview') target = this.fit(all, 0);
    else {
      // Follow the action; pull back to the whole map at the very end.
      const f = v < this.schedule.duration - 1.6 ? this.focusFrame(v) : undefined;
      target = f ? this.fit(f, B.w / 2.2) : this.fit(all, 0);
    }
    const k = dt > 0 ? 1 - Math.exp(-dt * 3.2) : 1;
    this.cam.x = lerp(this.cam.x, target.x, k);
    this.cam.y = lerp(this.cam.y, target.y, k);
    this.cam.w = lerp(this.cam.w, target.w, k);
    this.applyCamera();
  }

  private applyCamera(): void {
    const rect = this.container.getBoundingClientRect();
    const aspect = rect.height > 0 && rect.width > 0 ? rect.height / rect.width : 0.56;
    const w = this.cam.w;
    const h = w * aspect;
    setAttr(this.svg, 'viewBox', `${(this.cam.x - w / 2).toFixed(1)} ${(this.cam.y - h / 2).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
  }

  setCameraMode(m: CameraMode): void {
    if (m === 'free') this.freeCam = { ...this.cam };
    this.cameraMode = m;
  }

  /** Converts a client (screen) point to scene coordinates. */
  toScene(clientX: number, clientY: number): { x: number; y: number } {
    const m = this.svg.getScreenCTM();
    if (!m) return { x: clientX, y: clientY };
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }

  private installCameraControls(): void {
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    this.svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.cameraMode !== 'free') this.setCameraMode('free');
        const p = this.toScene(e.clientX, e.clientY);
        const f = Math.exp(e.deltaY * 0.0015);
        this.zoomAt(p, f);
      },
      { passive: false },
    );
    this.svg.addEventListener('pointerdown', (e) => {
      if ((e.target as Element).closest('.strip, .train, .device-hit, .card-title, .url-card')) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.svg.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      }
    });
    this.svg.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      if (this.cameraMode !== 'free') this.setCameraMode('free');
      if (pointers.size === 1) {
        const a = this.toScene(prev.x, prev.y);
        const b = this.toScene(e.clientX, e.clientY);
        this.freeCam.x -= b.x - a.x;
        this.freeCam.y -= b.y - a.y;
        this.cam.x = this.freeCam.x;
        this.cam.y = this.freeCam.y;
      } else if (pointers.size === 2) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        if (pinchDist > 0) this.zoomAt(this.toScene((a!.x + b!.x) / 2, (a!.y + b!.y) / 2), pinchDist / dist);
        pinchDist = dist;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    const up = (e: PointerEvent): void => {
      pointers.delete(e.pointerId);
      pinchDist = 0;
    };
    this.svg.addEventListener('pointerup', up);
    this.svg.addEventListener('pointercancel', up);
  }

  private zoomAt(p: { x: number; y: number }, f: number): void {
    const B = this.bounds;
    const w = Math.max(B.w / 6, Math.min(B.w * 1.4, this.freeCam.w * f));
    const real = w / this.freeCam.w;
    this.freeCam.x = p.x + (this.freeCam.x - p.x) * real;
    this.freeCam.y = p.y + (this.freeCam.y - p.y) * real;
    this.freeCam.w = w;
    this.cam = { ...this.freeCam };
  }

  get currentV(): number {
    return this.lastV;
  }

  /** Card rect of a device in scene coords (for the URL card drop target). */
  deviceRect(id: string): Rect {
    return this.devices.get(id)?.rect ?? { x: 0, y: 0, w: 0, h: 0 };
  }

  headerHeight(): number {
    return HEAD_H;
  }
}

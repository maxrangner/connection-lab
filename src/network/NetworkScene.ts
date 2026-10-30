import { el } from '../ui/scene/svg';
import { box, cylinder, line, tile } from '../ui/iso/prims';
import { clamp01, easeIn, easeInOut, easeOutBack, iso, lerp, U, v3, type Vec3 } from '../ui/iso/project';
import { shade } from '../ui/iso/shade';
import type { Story, Trip, Wrap } from './story';
import { addressBefore, DEVICE_TOP, LEVEL, packetPos, segAt, trayOpacity, wrapsBefore, type Seg, type Timeline } from './timeline';

export const COLOR = { app: '#4f9d69', tcp: '#8b6fd0', ip: '#4a84d4', eth: '#e08b33' } as const;
const DEVICE = '#d9d0c2';

/** Header bytes → tiles along the packet. The data card is not to scale (it would dwarf the headers). */
const TILES_PER_BYTE = 0.04;
const SECTION = { app: { d: 1.0, h: 0.72 }, tcp: { d: 1.18, h: 0.88 }, ip: { d: 1.34, h: 1.02 }, eth: { d: 1.62, h: 1.18 } };
const LAYER_NAME: Record<Wrap | 'app', string> = { app: 'App', tcp: 'TCP', ip: 'IP', eth: 'Ethernet' };

const cardLen = (bytes: number): number => 1.3 + 0.42 * Math.log2(Math.max(bytes, 64) / 64);

type PartKey = 'ethH' | 'ip' | 'tcp' | 'card' | 'ethT';

interface Part {
  key: PartKey;
  layer: Wrap | 'app';
  len: number;
  /** Share of its length the part takes up right now (it is snapping on or coming off). */
  f: number;
  /** Lift above the packet while snapping on or coming off, in tiles. */
  lift: number;
  /** Slide along the packet (Ethernet sleeve), in tiles. */
  slide: number;
  op: number;
  scale: number;
  bytes: number;
}

interface DeviceView {
  id: string;
  g: SVGGElement;
  trays: SVGGElement;
}

export interface Camera {
  /** Centre of the view, in SVG units. */
  cx: number;
  cy: number;
  /** Screen pixels per SVG unit. */
  scale: number;
}

const tf = (p: { sx: number; sy: number }): string => `matrix(1 0.5 0 1 ${p.sx.toFixed(1)} ${p.sy.toFixed(1)})`;

export class NetworkScene {
  readonly svg: SVGSVGElement;
  readonly packet: SVGGElement;
  private readonly devices: DeviceView[] = [];
  private readonly page: SVGGElement;
  private readonly tags: SVGGElement;
  private readonly laptopX: number;

  constructor(
    host: HTMLElement,
    private readonly story: Story,
    private readonly tl: Timeline,
  ) {
    this.svg = el('svg', { class: 'net-stage', preserveAspectRatio: 'xMidYMid meet' });
    host.appendChild(this.svg);
    const world = el('g', {}, this.svg);
    const cables = el('g', { class: 'cables' }, world);
    const devs = el('g', {}, world);
    this.packet = el('g', { class: 'packet' }, world);
    this.tags = el('g', { class: 'tags' }, world);
    this.laptopX = tl.deviceX.get(story.devices[0]!.id) ?? 0;

    const xs = story.devices.map((d) => tl.deviceX.get(d.id) ?? 0);
    for (let i = 0; i + 1 < xs.length; i++) {
      line(cables, v3(xs[i]!, 0, 0), v3(xs[i + 1]!, 0, 0), { class: 'cable' });
    }
    let page: SVGGElement | null = null;
    for (const d of story.devices) {
      const x = tl.deviceX.get(d.id) ?? 0;
      const trays = el('g', { class: 'trays', opacity: 0 }, devs);
      const g = el('g', { class: 'device' }, devs);
      const p = this.buildDevice(g, d.kind, x);
      if (p) page = p;
      this.buildTrays(trays, d.id, x);
      const name = el('text', { class: 'device-name', 'text-anchor': 'middle' }, g);
      const s = iso(x, 1.9, 0);
      name.setAttribute('x', s.sx.toFixed(1));
      name.setAttribute('y', (s.sy + 26).toFixed(1));
      name.textContent = d.label;
      this.devices.push({ id: d.id, g, trays });
    }
    // Trays draw behind the devices' own fronts but above cables; the packet always draws on top.
    this.page = page ?? el('g');
    this.fit(Math.max(...xs));
  }

  /** Screen point (in SVG units) where the laptop accepts a dropped card. */
  laptopDropPoint(): { sx: number; sy: number } {
    return iso(this.laptopX, -0.3, 1.0);
  }

  private fit(lastX: number): void {
    const pts: { sx: number; sy: number }[] = [];
    for (const x of [-6.5, lastX + 2]) for (const y of [-1.5, 2]) for (const z of [0, 3.5]) pts.push(iso(x, y, z));
    const minX = Math.min(...pts.map((p) => p.sx)) - 20;
    const maxX = Math.max(...pts.map((p) => p.sx)) + 20;
    const minY = Math.min(...pts.map((p) => p.sy)) - 10;
    const maxY = Math.max(...pts.map((p) => p.sy)) + 40;
    this.overview = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  private overview = { x: 0, y: 0, w: 1, h: 1 };

  /** Screen pixels per SVG unit that fit the whole network. */
  private baseScale(): number {
    const o = this.overview;
    return Math.min((this.svg.clientWidth || 1) / o.w, (this.svg.clientHeight || 1) / o.h);
  }

  /** Following shows about 460–800 units across, so the packet stays big on a phone too. */
  private followScale(): number {
    const cw = this.svg.clientWidth || 1;
    return Math.max(this.baseScale() * 1.4, cw / Math.min(800, Math.max(460, cw * 0.55)));
  }

  /** How far a viewer may zoom out and in by hand. */
  scaleLimits(): { min: number; max: number } {
    return { min: this.baseScale() * 0.6, max: this.followScale() * 4 };
  }

  /** Whole network in view. */
  overviewCamera(): Camera {
    const o = this.overview;
    return { cx: o.x + o.w / 2, cy: o.y + o.h / 2, scale: this.baseScale() };
  }

  /** Close on the packet (or the device it is at) at visual time v. */
  followCamera(v: number): Camera {
    const hit = segAt(this.tl, v);
    let p: Vec3;
    if (hit) {
      p = packetPos(this.tl, hit.seg, hit.k);
      if (hit.seg.step.kind === 'read' && this.tl.deviceKind.get(hit.seg.step.device) === 'laptop') p = v3(p.x, 0, lerp(p.z, 1.2, hit.k));
    } else {
      // Between the trips the camera rests on the server; after the end, on the laptop and its page.
      const server = this.tl.deviceX.get(this.story.devices[this.story.devices.length - 1]!.id) ?? 0;
      const lastSeg = this.tl.segs[this.tl.segs.length - 1];
      p = !lastSeg || v >= lastSeg.t1 ? v3(this.laptopX, 0, 1.6) : v3(server, 0, 4);
    }
    // Aim a little below the packet so the device it hovers over stays in view.
    const s = iso(p.x, 0, p.z * 0.65);
    return { cx: s.sx, cy: s.sy, scale: this.followScale() };
  }

  /** Sets the viewBox so it matches the element's aspect ratio. */
  applyCamera(c: Camera): void {
    const w = (this.svg.clientWidth || 1) / c.scale;
    const h = (this.svg.clientHeight || 1) / c.scale;
    this.svg.setAttribute('viewBox', `${(c.cx - w / 2).toFixed(1)} ${(c.cy - h / 2).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
  }

  private buildDevice(g: SVGGElement, kind: string, x: number): SVGGElement | null {
    const neutral = { color: DEVICE, cls: 'dev-body' };
    switch (kind) {
      case 'laptop': {
        box(g, { x: x - 1.3, y: -0.9, z: 0, w: 2.6, d: 1.8, h: 0.14, ...neutral });
        box(g, { x: x - 1.3, y: -1.05, z: 0.14, w: 2.6, d: 0.1, h: 1.56, ...neutral });
        // Screen glass on the face towards the viewer, and the page that appears on it at the end.
        const face = (x0: number, z0: number, w: number, h: number): string => {
          const a = iso(x0, -0.95, z0);
          const b = iso(x0 + w, -0.95, z0);
          const c = iso(x0 + w, -0.95, z0 - h);
          const d = iso(x0, -0.95, z0 - h);
          return `M${a.sx} ${a.sy}L${b.sx} ${b.sy}L${c.sx} ${c.sy}L${d.sx} ${d.sy}Z`;
        };
        el('path', { d: face(x - 1.18, 1.6, 2.36, 1.32), fill: '#3b4049' }, g);
        const page = el('g', { class: 'page', opacity: 0, transform: tf(iso(x - 1.18, -0.95, 1.6)) }, g);
        const w = 2.36 * U;
        el('rect', { x: 0, y: 0, width: w, height: 1.32 * U, fill: '#fbf8f2' }, page);
        const title = el('text', { x: w / 2, y: 0.5 * U, class: 'page-title', 'text-anchor': 'middle' }, page);
        title.textContent = this.story.pageTitle;
        for (const [i, lw] of [0.8, 0.62, 0.7].entries()) {
          el('rect', { x: (w - w * lw) / 2, y: 0.72 * U + i * 6, width: w * lw, height: 2.4, rx: 1.2, fill: '#c9c1b5' }, page);
        }
        return page;
      }
      case 'home-router': {
        box(g, { x: x - 1.1, y: -0.7, z: 0, w: 2.2, d: 1.4, h: 0.55, ...neutral });
        for (const ax of [x - 0.8, x + 0.8]) line(g, v3(ax, -0.55, 0.55), v3(ax, -0.55, 1.6), { class: 'antenna' });
        for (let i = 0; i < 4; i++) {
          const p = iso(x - 0.6 + i * 0.4, 0.7, 0.3);
          el('circle', { cx: p.sx, cy: p.sy, r: 2.2, fill: '#6fb37f' }, g);
        }
        return null;
      }
      case 'router':
        cylinder(g, { x, y: 0, z: 0, r: 1.15, h: 0.8, ...neutral });
        return null;
      default: {
        box(g, { x: x - 0.8, y: -0.8, z: 0, w: 1.6, d: 1.6, h: 2.6, ...neutral });
        for (let i = 0; i < 4; i++) line(g, v3(x - 0.55, 0.8, 2.25 - i * 0.5), v3(x + 0.55, 0.8, 2.25 - i * 0.5), { class: 'slot' });
        return null;
      }
    }
  }

  private buildTrays(g: SVGGElement, device: string, x: number): void {
    const layers: (Wrap | 'app')[] = this.tl.isRouter(device) ? ['eth', 'ip'] : ['eth', 'ip', 'tcp', 'app'];
    for (const layer of layers) {
      const z = this.tl.trayZ(device, LEVEL[layer]) - SECTION.eth.h / 2 - 0.12;
      tile(g, x - 2.9, -1.15, 5.8, 2.3, z, { class: 'tray', fill: COLOR[layer], stroke: COLOR[layer] });
      const p = iso(x + 2.9, -1.15, z);
      const t = el('text', { x: p.sx + 8, y: p.sy + 4, class: 'tray-name', 'text-anchor': 'start', fill: shade(COLOR[layer], 0.75) }, g);
      t.textContent = LAYER_NAME[layer];
    }
  }

  /** Devices, trays and the laptop screen at visual time v. */
  render(v: number): void {
    const tl = this.tl;
    for (const d of this.devices) {
      d.trays.setAttribute('opacity', trayOpacity(tl, d.id, v).toFixed(3));
      d.g.setAttribute('transform', `translate(0 ${(-this.hop(d.id, v) * U).toFixed(2)})`);
    }
    this.page.setAttribute('opacity', this.pageShown(v).toFixed(3));
  }

  /** Little hop when a packet lands on a device. */
  private hop(device: string, v: number): number {
    for (const s of this.tl.segs) {
      if (s.step.kind !== 'travel' || s.step.to !== device) continue;
      const dt = v - s.t1;
      if (dt >= 0 && dt < 0.35) return Math.sin((Math.PI * dt) / 0.35) * 0.12;
    }
    return 0;
  }

  private pageShown(v: number): number {
    const last = this.tl.segs[this.tl.segs.length - 1];
    if (!last) return 0;
    return clamp01((v - lerp(last.t0, last.t1, 0.8)) / 0.4);
  }

  /** The packet at visual time v. `peek` (0..1) pulls its pieces apart and shows their sizes. */
  drawPacket(v: number, peek: number): void {
    this.packet.replaceChildren();
    this.tags.replaceChildren();
    const hit = segAt(this.tl, v);
    if (!hit) return;
    const { seg, k } = hit;
    const trip = seg.trip;
    const dir = trip === this.story.request ? 1 : -1;
    let pos = packetPos(this.tl, seg, k);
    const parts = this.parts(seg, k);

    // Reading at the destination: the card wiggles, then drops into the device (or onto the laptop screen).
    let cardOp = 1;
    let cardScale = 1;
    let wiggle = 0;
    if (seg.step.kind === 'read') {
      const w = clamp01((k - 0.4) / 0.2);
      wiggle = Math.sin(w * Math.PI * 3) * 0.12 * (1 - w);
      const sink = easeIn(clamp01((k - 0.6) / 0.4));
      const x = this.tl.deviceX.get(seg.step.device) ?? 0;
      const target = this.tl.deviceKind.get(seg.step.device) === 'laptop' ? v3(x, -0.6, 0.95) : v3(x, 0, DEVICE_TOP[this.tl.deviceKind.get(seg.step.device) ?? ''] ?? 1);
      pos = v3(lerp(pos.x, target.x, sink), lerp(pos.y, target.y, sink), lerp(pos.z, target.z, sink));
      cardScale = 1 - 0.7 * sink;
      cardOp = 1 - sink;
    }
    for (const p of parts) {
      if (p.key === 'card') {
        p.scale *= cardScale;
        p.op *= cardOp;
      }
    }

    // Lay the parts out from the front (byte 0) backwards; peek opens gaps between them.
    const gap = peek * 0.7;
    const visible = parts.filter((p) => p.op > 0.01);
    const lengths = visible.map((p) => p.len * p.f * p.scale);
    const total = lengths.reduce((a, b) => a + b, 0) + gap * Math.max(0, visible.length - 1);
    let u = total / 2;
    const placed: { p: Part; u0: number; u1: number }[] = [];
    visible.forEach((p, i) => {
      const len = lengths[i]!;
      placed.push({ p, u0: u - len, u1: u });
      u -= len + gap;
    });

    const toX = (uu: number): number => pos.x + dir * uu;
    const sleeve = parts.find((p) => p.key === 'ethH');
    const drawOrder = [...placed].sort((a, b) => toX((a.u0 + a.u1) / 2) - toX((b.u0 + b.u1) / 2));
    for (const { p, u0, u1 } of drawOrder) {
      const sec = SECTION[p.layer];
      const d = sec.d * p.scale;
      const h = sec.h * p.scale;
      const slide = dir * p.slide;
      const xa = Math.min(toX(u0), toX(u1)) + slide;
      const w = Math.abs(toX(u1) - toX(u0));
      const z = pos.z - h / 2 + p.lift + (p.key === 'card' ? wiggle : 0);
      if (w < 0.005) continue;
      const g = el('g', { opacity: p.op.toFixed(3), class: `part part-${p.layer}` }, this.packet);
      box(g, { x: xa, y: -d / 2, z, w, d, h, color: COLOR[p.layer] });
      // Name printed on the side facing the viewer, if there is room for it.
      const label = p.key === 'card' ? trip.card : p.key === 'ip' || p.key === 'tcp' ? LAYER_NAME[p.layer] : '';
      if (label && w * U > label.length * (p.key === 'card' ? 8 : 6.5) + 4 && p.f > 0.6) {
        const t = el('text', { class: p.key === 'card' ? 'face-label card-label' : 'face-label', 'text-anchor': 'middle', transform: tf(iso(xa + w / 2, d / 2, z + h / 2)) }, g);
        t.setAttribute('dy', '0.35em');
        t.textContent = label;
      }
      // "Ethernet" on the end cap that faces the viewer (the header going out, the trailer coming back).
      if (p.key === (dir === 1 ? 'ethH' : 'ethT') && peek < 0.5) {
        const t = el('text', { class: 'face-label eth-label', 'text-anchor': 'middle', transform: `matrix(1 -0.5 0 1 ${iso(xa + w, 0, z + h / 2).sx.toFixed(1)} ${iso(xa + w, 0, z + h / 2).sy.toFixed(1)})` }, g);
        t.setAttribute('dy', '0.35em');
        t.textContent = 'Ethernet';
      }
    }

    // Peeking: one chip per piece with its real size, in a row above the packet with a line down to it.
    if (peek > 0.02) this.sizeChips(placed.map(({ p, u0, u1 }) => ({ p, top: v3(toX((u0 + u1) / 2), 0, pos.z + SECTION[p.layer].h / 2) })), trip, peek);

    // The Ethernet sleeve: a see-through wrap from the header cap to the trailer cap, with a tab.
    if (sleeve && sleeve.op > 0.01) {
      const front = placed.find((x) => x.p.key === 'ethH');
      const back = placed.find((x) => x.p.key === 'ethT');
      if (front && back) {
        const sec = SECTION.eth;
        const slide = dir * sleeve.slide;
        const xa = Math.min(toX(front.u1), toX(back.u0)) + slide;
        const w = Math.abs(toX(front.u1) - toX(back.u0));
        const z = pos.z - sec.h / 2;
        const g = el('g', { opacity: (sleeve.op * (1 - peek)).toFixed(3), class: 'sleeve' }, this.packet);
        box(g, { x: xa, y: -sec.d / 2 - 0.02, z: z - 0.02, w, d: sec.d + 0.04, h: sec.h + 0.04, color: COLOR.eth });
      }
    }

    const ip = parts.find((p) => p.key === 'ip');
    if (ip && ip.op > 0.5 && ip.f > 0.5 && peek < 0.5) this.addressTag(seg, k, v3(pos.x - dir * 0.6, 0, pos.z + 2.35), 1 - peek * 2);
  }

  /** Each layer piece's state at progress k of a segment. */
  private parts(seg: Seg, k: number): Part[] {
    const trip: Trip = seg.trip;
    const on = wrapsBefore(seg);
    const step = seg.step;
    const work = clamp01((k - 0.35) / 0.65);
    const mk = (key: PartKey, layer: Wrap | 'app', bytes: number, len: number): Part => {
      const wrap = layer === 'app' ? null : layer;
      const p: Part = { key, layer, bytes, len, f: wrap && !on.has(wrap) ? 0 : 1, lift: 0, slide: 0, op: wrap && !on.has(wrap) ? 0 : 1, scale: 1 };
      if (wrap && (step.kind === 'wrap' || step.kind === 'unwrap') && step.layer === wrap) {
        const going = step.kind === 'unwrap';
        const e = going ? easeIn(work) : easeOutBack(work);
        p.f = going ? 1 - easeInOut(work) : easeInOut(work);
        p.op = going ? 1 - work : clamp01(work * 3);
        if (wrap === 'eth') p.slide = going ? -e * 2.2 : (1 - e) * 2.2;
        else p.lift = going ? e * 1.8 : (1 - e) * 1.8;
      }
      if (layer === 'app' && step.kind === 'appear') {
        p.scale = Math.max(0.01, easeOutBack(clamp01(k / 0.7)));
        p.op = clamp01(k * 4);
      }
      return p;
    };
    const L = TILES_PER_BYTE;
    return [
      mk('ethH', 'eth', trip.header.eth, trip.header.eth * L),
      mk('ip', 'ip', trip.header.ip, trip.header.ip * L),
      mk('tcp', 'tcp', trip.header.tcp, trip.header.tcp * L),
      mk('card', 'app', trip.dataBytes, cardLen(trip.dataBytes)),
      mk('ethT', 'eth', trip.trailer, Math.max(trip.trailer * L, 0.12)),
    ];
  }

  private sizeChips(items: { p: Part; top: Vec3 }[], trip: Trip, op: number): void {
    const chips = items
      .map(({ p, top }) => {
        const name = p.key === 'card' ? trip.card : p.key === 'ethT' ? '' : LAYER_NAME[p.layer];
        const text = name ? `${name} · ${p.bytes} B` : `${p.bytes} B`;
        return { p, a: iso(top.x, top.y, top.z), text, w: text.length * 6.6 + 14, x: 0 };
      })
      .sort((m, n) => m.a.sx - n.a.sx);
    if (!chips.length) return;
    // Centre the row over the packet, then push chips apart so none overlap.
    const total = chips.reduce((s, c) => s + c.w + 6, -6);
    const mid = (chips[0]!.a.sx + chips[chips.length - 1]!.a.sx) / 2;
    let x = mid - total / 2;
    for (const c of chips) {
      c.x = x + c.w / 2;
      x += c.w + 6;
    }
    const y = Math.min(...chips.map((c) => c.a.sy)) - 30 - 20 * op;
    for (const c of chips) {
      const color = COLOR[c.p.layer];
      const g = el('g', { class: 'size-tag', opacity: op.toFixed(3) }, this.tags);
      el('path', { d: `M${c.a.sx.toFixed(1)} ${c.a.sy.toFixed(1)}L${c.x.toFixed(1)} ${y.toFixed(1)}`, stroke: color, fill: 'none' }, g);
      el('rect', { x: c.x - c.w / 2, y: y - 18, width: c.w, height: 18, rx: 9, fill: color }, g);
      const t = el('text', { x: c.x.toFixed(1), y: (y - 9).toFixed(1), dy: '0.35em', 'text-anchor': 'middle' }, g);
      t.textContent = c.text;
    }
  }

  /** "from → to" on the IP piece. At the home router one side flips (NAT). */
  private addressTag(seg: Seg, k: number, p: Vec3, op: number): void {
    const a = addressBefore(seg);
    let flipScale = 1;
    let changed: 'from' | 'to' | null = null;
    if (seg.step.kind === 'nat') {
      const w = clamp01((k - 0.3) / 0.4);
      changed = seg.step.which;
      if (w >= 0.5) a[seg.step.which] = seg.step.after;
      flipScale = Math.abs(1 - 2 * w);
    }
    const s = iso(p.x, p.y, p.z);
    const pop = changed ? 1.25 : 1;
    const back = seg.trip !== this.story.request;
    const g = el('g', { class: `addr ${back ? 'addr-back' : 'addr-out'}`, opacity: op.toFixed(3), transform: `translate(${s.sx.toFixed(1)} ${s.sy.toFixed(1)}) scale(${pop})` }, this.tags);
    const fromW = a.from.length * 7.2;
    const toW = a.to.length * 7.2;
    const width = fromW + toW + 44;
    // Small "from" / "to" captions sit above the addresses; the numbers sit on the lower line.
    const NUM_Y = 7;
    el('rect', { x: -width / 2, y: -19, width, height: 38, rx: 7, class: 'addr-bg' }, g);
    const part = (caption: string, text: string, x: number, w: number, hot: boolean): void => {
      const cap = el('text', { x: (x + w / 2).toFixed(1), y: -8, 'text-anchor': 'middle', dy: '0.35em', class: 'addr-cap' }, g);
      cap.textContent = caption;
      const pg = el('g', { transform: `translate(${(x + w / 2).toFixed(1)} ${NUM_Y}) scale(1 ${hot ? flipScale.toFixed(3) : 1})` }, g);
      if (hot) el('rect', { x: -w / 2 - 4, y: -9, width: w + 8, height: 18, rx: 4, class: 'addr-hot' }, pg);
      const t = el('text', { 'text-anchor': 'middle', dy: '0.35em', class: hot ? 'addr-text hot' : 'addr-text' }, pg);
      t.textContent = text;
    };
    part('from', a.from, -width / 2 + 10, fromW, changed === 'from');
    const arrow = el('text', { x: -width / 2 + 22 + fromW, y: NUM_Y, 'text-anchor': 'middle', dy: '0.35em', class: 'addr-arrow' }, g);
    arrow.textContent = '→';
    part('to', a.to, -width / 2 + 34 + fromW, toW, changed === 'to');
  }
}

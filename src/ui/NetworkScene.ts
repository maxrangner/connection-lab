import { el } from './svg';
import { box, cylinder, line, tile } from './prims';
import { clamp01, easeIn, easeInOut, easeOut, easeOutBack, iso, lerp, U, v3, type Vec3 } from './project';
import { shade } from './shade';
import type { Story, Trip, Wrap } from './story';
import { addressBefore, DEVICE_TOP, LEVEL, packetPos, segAt, trayOpacity, wrapsBefore, type Axis, type Seg, type Timeline } from './timeline';

export const COLOR = { app: '#4f9d69', tcp: '#8b6fd0', udp: '#b8609f', ip: '#4a84d4', eth: '#e08b33' } as const;
const DEVICE = '#d9d0c2';
const BURST = '#ffd84a';
const WAIT = '#c2562f';

/** Header bytes → tiles along the packet. The data card is not to scale (it would dwarf the headers). */
const TILES_PER_BYTE = 0.04;
type Layer = Wrap | 'app';
const SECTION: Record<Layer, { d: number; h: number }> = { app: { d: 1.0, h: 0.72 }, l4: { d: 1.18, h: 0.88 }, ip: { d: 1.34, h: 1.02 }, eth: { d: 1.62, h: 1.18 } };

const colorOf = (layer: Layer, trip: Trip): string => (layer === 'l4' ? COLOR[trip.l4] : COLOR[layer]);
const layerName = (layer: Layer, trip: Trip): string => ({ app: 'App', l4: trip.l4 === 'udp' ? 'UDP' : 'TCP', ip: 'IP', eth: 'Ethernet' })[layer];
const cardFont = (label: string): number => (label.length <= 7 ? 13 : 10.5);
const cardLen = (trip: Trip): number => {
  const label = trip.card ?? '';
  return Math.max(1.3 + 0.42 * Math.log2(Math.max(trip.dataBytes, 64) / 64), (label.length * cardFont(label) * 0.62 + 18) / U);
};

/** Text printed on a box face: `+y` faces run along +x on screen, `+x` faces along −y. */
const faceTf = (p: { sx: number; sy: number }, face: '+y' | '+x'): string =>
  `matrix(1 ${face === '+y' ? 0.5 : -0.5} 0 1 ${p.sx.toFixed(1)} ${p.sy.toFixed(1)})`;

const easeOutBounce = (t: number): number => {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};

type PartKey = 'ethH' | 'ip' | 'l4' | 'card' | 'ethT';

interface Part {
  key: PartKey;
  layer: Layer;
  len: number;
  /** Share of its length the part takes up right now (it is snapping on or coming off). */
  f: number;
  /** Height above the packet while snapping on or coming off, in tiles (negative: falling). */
  lift: number;
  /** Slide along the packet (Ethernet sleeve), in tiles. */
  slide: number;
  op: number;
  scale: number;
  bytes: number;
}

/** How the packet is drawn this frame. */
interface Pose {
  pos: Vec3;
  axis: Axis;
  /** Squeezes every piece along the packet (the hop-and-turn at a router). */
  lenScale: number;
  gap: number;
  /** Degrees of screen-space spin (tumbling off a cable) and a landing squash. */
  spin: number;
  squash: number;
  op: number;
  sleeve: number;
  tag: boolean;
  chips: number;
}

interface DeviceView {
  id: string;
  g: SVGGElement;
  trays: SVGGElement;
  l4Name: SVGTextElement | null;
}

export interface Camera {
  /** Centre of the view, in SVG units. */
  cx: number;
  cy: number;
  /** Screen pixels per SVG unit. */
  scale: number;
}

export class NetworkScene {
  readonly svg: SVGSVGElement;
  readonly packet: SVGGElement;
  private readonly devices: DeviceView[] = [];
  private readonly tags: SVGGElement;
  private readonly fx: SVGGElement;
  private readonly screen: { page: SVGGElement; title: SVGTextElement; dns: SVGGElement; dnsAddr: SVGTextElement; fail: SVGTextElement } | null = null;
  private overview = { x: 0, y: 0, w: 1, h: 1 };

  constructor(
    host: HTMLElement,
    private story: Story,
    private tl: Timeline,
  ) {
    this.svg = el('svg', { class: 'net-stage', preserveAspectRatio: 'xMidYMid meet' });
    host.appendChild(this.svg);
    const world = el('g', {}, this.svg);
    const cables = el('g', { class: 'cables' }, world);
    const devs = el('g', {}, world);
    // Effects (impact bursts, timers) sit behind the packet, the way an anime impact star does.
    this.fx = el('g', { class: 'fx' }, world);
    this.packet = el('g', { class: 'packet' }, world);
    this.tags = el('g', { class: 'tags' }, world);

    for (const l of story.links) {
      const a = tl.pos.get(l.a);
      const b = tl.pos.get(l.b);
      if (a && b) line(cables, v3(a.x, a.y, 0), v3(b.x, b.y, 0), { class: 'cable' });
    }
    // Draw far devices first: a larger x + y is nearer the viewer.
    const order = [...story.devices].sort((m, n) => this.depthOf(m.id) - this.depthOf(n.id));
    for (const d of order) {
      const p = tl.pos.get(d.id) ?? { x: 0, y: 0 };
      const trays = el('g', { class: 'trays', opacity: 0 }, devs);
      const g = el('g', { class: 'device' }, devs);
      const screen = this.buildDevice(g, d.kind, p.x, p.y);
      if (screen) this.screen = screen;
      const l4Name = this.buildTrays(trays, d.id, p.x, p.y);
      const s = iso(p.x, p.y + 1.9, 0);
      const name = el('text', { class: 'device-name', 'text-anchor': 'middle', x: s.sx.toFixed(1), y: (s.sy + 26).toFixed(1) }, g);
      name.textContent = d.label;
      this.devices.push({ id: d.id, g, trays, l4Name });
    }
    this.fit();
    this.setStory(story, tl);
  }

  /** Swap in a re-simulated story (after a knock). Devices and cables stay; what's on the laptop screen may change. */
  setStory(story: Story, tl: Timeline): void {
    this.story = story;
    this.tl = tl;
    if (this.screen) {
      this.screen.title.textContent = story.pageTitle ?? '';
      this.screen.dnsAddr.textContent = story.dnsAnswer ?? '';
    }
  }

  private depthOf(id: string): number {
    const p = this.tl.pos.get(id) ?? { x: 0, y: 0 };
    return p.x + p.y;
  }

  /** Screen point (in SVG units) where the laptop accepts a dropped card. */
  laptopDropPoint(): { sx: number; sy: number } {
    const p = this.tl.pos.get('laptop') ?? { x: 0, y: 0 };
    return iso(p.x, p.y - 0.3, 1.0);
  }

  private fit(): void {
    const pts: { sx: number; sy: number }[] = [];
    for (const p of this.tl.pos.values()) for (const [dx, dy] of [[-2, -2], [2, 2.4], [-2, 2.4], [2, -2]] as const) for (const z of [0, 3.2]) pts.push(iso(p.x + dx, p.y + dy, z));
    // Room for the site card waiting left of the laptop.
    pts.push(iso(-8.6, 0.4, 3.6));
    const minX = Math.min(...pts.map((p) => p.sx)) - 20;
    const maxX = Math.max(...pts.map((p) => p.sx)) + 20;
    const minY = Math.min(...pts.map((p) => p.sy)) - 10;
    const maxY = Math.max(...pts.map((p) => p.sy)) + 40;
    this.overview = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

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

  /** Whole network in view; on a tall phone screen, closer on the laptop and the card so they are big enough to drag. */
  overviewCamera(): Camera {
    const o = this.overview;
    const cw = this.svg.clientWidth || 1;
    const ch = this.svg.clientHeight || 1;
    if (ch > cw * 1.2) {
      const c = iso(-2.2, 0, 1.8);
      return { cx: c.sx, cy: c.sy, scale: Math.max(this.baseScale(), cw / 520) };
    }
    return { cx: o.x + o.w / 2, cy: o.y + o.h / 2, scale: this.baseScale() };
  }

  /** Close on the packet (or the device it is at) at visual time v. */
  followCamera(v: number): Camera {
    const hit = segAt(this.tl, v);
    let p: Vec3;
    const laptop = this.tl.pos.get('laptop') ?? { x: 0, y: 0 };
    if (hit?.seg.step.kind === 'wait') {
      const d = this.tl.pos.get(hit.seg.step.device) ?? { x: 0, y: 0 };
      p = v3(d.x, d.y, (DEVICE_TOP[this.tl.kind.get(hit.seg.step.device) ?? ''] ?? 1) + 1.5);
    } else if (hit) {
      p = packetPos(this.tl, hit.seg, hit.k);
      if (hit.seg.step.kind === 'read' && this.tl.kind.get(hit.seg.step.device) === 'laptop') p = v3(p.x, p.y, lerp(p.z, 1.2, hit.k));
    } else {
      p = v3(laptop.x, laptop.y, 1.6);
    }
    // Aim a little below the packet so the device it hovers over stays in view.
    const s = iso(p.x, p.y, p.z * 0.65);
    return { cx: s.sx, cy: s.sy, scale: this.followScale() };
  }

  /** Sets the viewBox so it matches the element's aspect ratio. */
  applyCamera(c: Camera): void {
    const w = (this.svg.clientWidth || 1) / c.scale;
    const h = (this.svg.clientHeight || 1) / c.scale;
    this.svg.setAttribute('viewBox', `${(c.cx - w / 2).toFixed(1)} ${(c.cy - h / 2).toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
  }

  private buildDevice(g: SVGGElement, kind: string, x: number, y: number): NetworkScene['screen'] {
    const neutral = { color: DEVICE, cls: 'dev-body' };
    switch (kind) {
      case 'laptop': {
        box(g, { x: x - 1.3, y: y - 0.9, z: 0, w: 2.6, d: 1.8, h: 0.14, ...neutral });
        box(g, { x: x - 1.3, y: y - 1.05, z: 0.14, w: 2.6, d: 0.1, h: 1.56, ...neutral });
        // Screen glass on the face towards the viewer; what it shows changes as the story goes on.
        const a = iso(x - 1.18, y - 0.95, 1.6);
        const b = iso(x + 1.18, y - 0.95, 1.6);
        const c = iso(x + 1.18, y - 0.95, 0.28);
        const d = iso(x - 1.18, y - 0.95, 0.28);
        el('path', { d: `M${a.sx} ${a.sy}L${b.sx} ${b.sy}L${c.sx} ${c.sy}L${d.sx} ${d.sy}Z`, fill: '#3b4049' }, g);
        const w = 2.36 * U;
        const h = 1.32 * U;
        const face = el('g', { transform: faceTf(a, '+y') }, g);
        const dns = el('g', { class: 'screen-dns', opacity: 0 }, face);
        const name = el('text', { x: w / 2, y: h * 0.38, class: 'screen-small', 'text-anchor': 'middle' }, dns);
        name.textContent = 'example.com';
        const dnsAddr = el('text', { x: w / 2, y: h * 0.62, class: 'screen-addr', 'text-anchor': 'middle' }, dns);
        const page = el('g', { class: 'page', opacity: 0 }, face);
        el('rect', { x: 0, y: 0, width: w, height: h, fill: '#fbf8f2' }, page);
        const title = el('text', { x: w / 2, y: 0.5 * U, class: 'page-title', 'text-anchor': 'middle' }, page);
        for (const [i, lw] of [0.8, 0.62, 0.7].entries()) {
          el('rect', { x: (w - w * lw) / 2, y: 0.72 * U + i * 6, width: w * lw, height: 2.4, rx: 1.2, fill: '#c9c1b5' }, page);
        }
        const fail = el('text', { x: w / 2, y: h / 2, dy: '0.35em', class: 'screen-fail', 'text-anchor': 'middle', opacity: 0 }, face);
        fail.textContent = '✗';
        return { page, title, dns, dnsAddr, fail };
      }
      case 'home-router': {
        box(g, { x: x - 1.1, y: y - 0.7, z: 0, w: 2.2, d: 1.4, h: 0.55, ...neutral });
        for (const ax of [x - 0.8, x + 0.8]) line(g, v3(ax, y - 0.55, 0.55), v3(ax, y - 0.55, 1.6), { class: 'antenna' });
        for (let i = 0; i < 4; i++) {
          const p = iso(x - 0.6 + i * 0.4, y + 0.7, 0.3);
          el('circle', { cx: p.sx, cy: p.sy, r: 2.2, fill: '#6fb37f' }, g);
        }
        return null;
      }
      case 'router':
        cylinder(g, { x, y, z: 0, r: 1.15, h: 0.8, ...neutral });
        return null;
      case 'dns-resolver': {
        // A squat cabinet with a fat address book on top.
        box(g, { x: x - 1.0, y: y - 0.8, z: 0, w: 2.0, d: 1.6, h: 0.75, ...neutral });
        box(g, { x: x - 0.7, y: y - 0.55, z: 0.75, w: 1.4, d: 1.1, h: 0.35, color: '#c9b79c', cls: 'dev-body' });
        return null;
      }
      default: {
        box(g, { x: x - 0.8, y: y - 0.8, z: 0, w: 1.6, d: 1.6, h: 2.6, ...neutral });
        for (let i = 0; i < 4; i++) line(g, v3(x - 0.55, y + 0.8, 2.25 - i * 0.5), v3(x + 0.55, y + 0.8, 2.25 - i * 0.5), { class: 'slot' });
        return null;
      }
    }
  }

  /** Returns the transport tray's name, which says TCP or UDP depending on the packet. */
  private buildTrays(g: SVGGElement, device: string, x: number, y: number): SVGTextElement | null {
    const layers: Layer[] = this.tl.isRouter(device) ? ['eth', 'ip'] : ['eth', 'ip', 'l4', 'app'];
    let l4: SVGTextElement | null = null;
    for (const layer of layers) {
      const color = layer === 'l4' ? COLOR.tcp : COLOR[layer];
      const z = this.tl.trayZ(device, LEVEL[layer]) - SECTION.eth.h / 2 - 0.12;
      tile(g, x - 2.9, y - 1.15, 5.8, 2.3, z, { class: 'tray', fill: color, stroke: color });
      const p = iso(x + 2.9, y - 1.15, z);
      const t = el('text', { x: p.sx + 8, y: p.sy + 4, class: 'tray-name', 'text-anchor': 'start', fill: shade(color, 0.75) }, g);
      t.textContent = layer === 'app' ? 'App' : layer === 'l4' ? 'TCP' : layer === 'ip' ? 'IP' : 'Ethernet';
      if (layer === 'l4') l4 = t;
    }
    return l4;
  }

  /** Devices, trays and the laptop screen at visual time v. */
  render(v: number): void {
    const tl = this.tl;
    const hit = segAt(tl, v);
    for (const d of this.devices) {
      d.trays.setAttribute('opacity', trayOpacity(tl, d.id, v).toFixed(3));
      d.g.setAttribute('transform', `translate(0 ${(-this.hop(d.id, v) * U).toFixed(2)})`);
      if (d.l4Name && hit) {
        const udp = hit.seg.trip.l4 === 'udp';
        d.l4Name.textContent = udp ? 'UDP' : 'TCP';
        d.l4Name.setAttribute('fill', shade(udp ? COLOR.udp : COLOR.tcp, 0.75));
      }
    }
    if (!this.screen) return;
    const page = this.story.pageTitle ? this.screenAfterRead(v, 'page') : 0;
    this.screen.page.setAttribute('opacity', page.toFixed(3));
    this.screen.dns.setAttribute('opacity', (this.screenAfterRead(v, 'dns') * (1 - page)).toFixed(3));
    const last = tl.segs[tl.segs.length - 1];
    const failed = !this.story.pageTitle && !!last && v >= last.t1;
    this.screen.fail.setAttribute('opacity', failed ? '1' : '0');
  }

  /** 0..1: how far the laptop has shown what a card of this chapter brought (it fades in as the card goes in). */
  private screenAfterRead(v: number, chapter: Trip['chapter']): number {
    let o = 0;
    for (const s of this.tl.segs) {
      if (s.step.kind !== 'read' || s.trip.chapter !== chapter || this.tl.kind.get(s.step.device) !== 'laptop') continue;
      o = Math.max(o, clamp01((v - lerp(s.t0, s.t1, 0.8)) / 0.4));
    }
    return o;
  }

  /** Little hop when a packet lands on a device, and a big one when a timer runs out. */
  private hop(device: string, v: number): number {
    for (const s of this.tl.segs) {
      if (s.step.kind === 'travel' && s.step.to === device) {
        const dt = v - s.t1;
        if (dt >= 0 && dt < 0.35) return Math.sin((Math.PI * dt) / 0.35) * 0.12;
      }
      if (s.step.kind === 'wait' && s.step.device === device) {
        const dt = v - (s.t1 - 0.5);
        if (dt >= 0 && dt < 0.4) return Math.sin((Math.PI * dt) / 0.4) * 0.3;
      }
    }
    return 0;
  }

  /** The travelling packet's progress along its cable, if it can be knocked off right now. */
  knockable(v: number): { trip: Trip; link: string; k: number } | null {
    const hit = segAt(this.tl, v);
    if (!hit || hit.seg.step.kind !== 'travel') return null;
    // Only while it is out on the cable, not while it is still dropping out of a tray.
    if (hit.k < 0.12 || hit.k > 0.9) return null;
    return { trip: hit.seg.trip, link: hit.seg.step.link, k: hit.k };
  }

  /** Whether there is a whole packet to pop open (not one tumbling off a cable). */
  peekable(v: number): boolean {
    const kind = segAt(this.tl, v)?.seg.step.kind;
    return !!kind && kind !== 'lost' && kind !== 'wait';
  }

  /** The packet at visual time v. `peek` (0..1) pulls its pieces apart and shows their sizes. */
  drawPacket(v: number, peek: number): void {
    this.packet.replaceChildren();
    this.tags.replaceChildren();
    this.fx.replaceChildren();
    const hit = segAt(this.tl, v);
    if (!hit) return;
    const { seg, k } = hit;
    const step = seg.step;
    if (step.kind === 'wait') {
      this.drawWait(seg, k);
      return;
    }
    const trip = seg.trip;
    const parts = this.parts(seg, k);
    const pose: Pose = { pos: packetPos(this.tl, seg, k), axis: seg.axis, lenScale: 1, gap: peek * 0.7, spin: 0, squash: 0, op: 1, sleeve: 1 - peek, tag: peek < 0.5, chips: peek };

    // Hop and turn to face the next cable.
    if (seg.turn && k < 0.4) {
      const q = k / 0.4;
      pose.axis = q < 0.5 ? seg.turn.from : seg.turn.to;
      pose.lenScale = q < 0.5 ? 1 - 1.5 * q : 0.25 + 1.5 * (q - 0.5);
      pose.pos = v3(pose.pos.x, pose.pos.y, pose.pos.z + Math.sin(Math.PI * q) * 0.6);
    }

    // Knocked off the cable: impact, tumble, bounce, fall apart.
    if (step.kind === 'lost' && seg.knock) {
      const tau = k * (seg.t1 - seg.t0) - seg.knock.k * seg.knock.travel;
      if (tau >= 0) {
        this.burst(pose.pos, tau);
        this.tumble(pose, tau);
      }
    }

    // Reading at the destination: the card wiggles, then drops into the device (or onto the laptop screen).
    let wiggle = 0;
    if (step.kind === 'read') {
      const w = clamp01((k - 0.4) / 0.2);
      wiggle = Math.sin(w * Math.PI * 3) * 0.12 * (1 - w);
      const sink = easeIn(clamp01((k - 0.6) / 0.4));
      const d = this.tl.pos.get(step.device) ?? { x: 0, y: 0 };
      const kind = this.tl.kind.get(step.device) ?? '';
      const target = kind === 'laptop' ? v3(d.x, d.y - 0.6, 0.95) : v3(d.x, d.y, DEVICE_TOP[kind] ?? 1);
      pose.pos = v3(lerp(pose.pos.x, target.x, sink), lerp(pose.pos.y, target.y, sink), lerp(pose.pos.z, target.z, sink));
      for (const p of parts) {
        if (p.key !== 'card') continue;
        p.scale *= 1 - 0.7 * sink;
        p.op *= 1 - sink;
      }
    }
    this.drawPose(seg, k, trip, parts, pose, wiggle);
  }

  private tumble(pose: Pose, tau: number): void {
    const i = pose.pos;
    // Off to the side facing the viewer, a little onward, up and down with gravity, one small bounce.
    const side = pose.axis.x !== 0 ? { x: 0, y: 1 } : { x: 1, y: 0 };
    const rest = 0.62;
    const up = 3.4;
    const g = 6;
    const land = (up + Math.sqrt(up * up + 4 * g * Math.max(0, i.z - rest))) / (2 * g);
    let z = rest;
    if (tau < land) z = i.z + up * tau - g * tau * tau;
    else if (tau - land < 0.32) {
      const q = (tau - land) / 0.32;
      z = rest + 1.1 * q * (1 - q);
    }
    const fly = easeOut(Math.min(1, tau / (land + 0.35)));
    pose.pos = v3(i.x + side.x * 1.9 * fly + pose.axis.x * 0.6 * fly, i.y + side.y * 1.9 * fly + pose.axis.y * 0.6 * fly, z);
    pose.spin = 720 * fly * (pose.axis.x + pose.axis.y >= 0 ? 1 : -1);
    const sq = tau - land;
    pose.squash = sq >= 0 && sq < 0.16 ? 1 - sq / 0.16 : 0;
    const apart = clamp01((tau - land - 0.45) / 0.7);
    pose.gap = Math.max(pose.gap, 1.2 * easeOut(apart));
    pose.op = 1 - apart;
    pose.sleeve = Math.min(pose.sleeve, 1 - clamp01(apart * 3));
    pose.tag = false;
    pose.chips = 0;
  }

  /** Anime impact: a jagged yellow star and speed lines bursting from the hit. */
  private burst(at: Vec3, tau: number): void {
    const T = 0.5;
    if (tau > T) return;
    const q = tau / T;
    const c = iso(at.x, at.y, at.z);
    const g = el('g', { class: 'burst', opacity: (1 - easeIn(q)).toFixed(3), transform: `translate(${c.sx.toFixed(1)} ${c.sy.toFixed(1)})` }, this.fx);
    const r = 22 + 34 * easeOut(q);
    const pts: string[] = [];
    for (let j = 0; j < 20; j++) {
      const a = (j / 20) * Math.PI * 2 + 0.2;
      const rr = j % 2 ? r * 0.5 : r * (j % 4 ? 1 : 1.25);
      pts.push(`${(Math.cos(a) * rr).toFixed(1)},${(Math.sin(a) * rr).toFixed(1)}`);
    }
    el('polygon', { points: pts.join(' '), fill: BURST, class: 'burst-star' }, g);
    for (let j = 0; j < 14; j++) {
      const a = (j / 14) * Math.PI * 2 + 0.11 * j;
      const r1 = r * 1.15 + 6;
      const r2 = r1 + 18 + 26 * easeOut(q) + (j % 3) * 6;
      el('line', { x1: Math.cos(a) * r1, y1: Math.sin(a) * r1, x2: Math.cos(a) * r2, y2: Math.sin(a) * r2, class: 'speed-line' }, g);
    }
  }

  /** The resender's timer above it: a ring that fills, then a surprised "!" (or a "✗" if it gives up). */
  private drawWait(seg: Seg, k: number): void {
    const step = seg.step;
    if (step.kind !== 'wait') return;
    const d = this.tl.pos.get(step.device) ?? { x: 0, y: 0 };
    const top = DEVICE_TOP[this.tl.kind.get(step.device) ?? ''] ?? 1;
    const c = iso(d.x, d.y, top + 2.4);
    const dur = seg.t1 - seg.t0;
    const fill = clamp01((k * dur) / (dur - 0.5));
    const g = el('g', { class: 'timer', transform: `translate(${c.sx.toFixed(1)} ${c.sy.toFixed(1)})` }, this.fx);
    const pop = easeOutBack(clamp01((k * dur) / 0.3));
    // It gets nervous as the ring closes.
    const jitter = fill > 0.7 && fill < 1 ? Math.sin(k * dur * 40) * 4 * (fill - 0.7) * 3 : 0;
    const ring = el('g', { transform: `rotate(${jitter.toFixed(2)}) scale(${pop.toFixed(3)})`, opacity: fill >= 1 ? '0' : '1' }, g);
    const R = 20;
    el('circle', { r: R, class: 'timer-track' }, ring);
    const circ = 2 * Math.PI * R;
    el('circle', { r: R, class: 'timer-fill', stroke: WAIT, 'stroke-dasharray': `${(circ * fill).toFixed(1)} ${circ.toFixed(1)}`, transform: 'rotate(-90)' }, ring);
    const label = el('text', { 'text-anchor': 'middle', dy: '0.35em', class: 'timer-label' }, ring);
    label.textContent = step.giveUp ? '…' : formatWait(step.seconds);

    if (fill >= 1) {
      const q = clamp01((k * dur - (dur - 0.5)) / 0.5);
      const s = easeOutBack(clamp01(q * 2.2));
      const mark = el('g', { transform: `translate(0 ${(-6 * Math.sin(Math.PI * q)).toFixed(1)}) scale(${s.toFixed(3)})` }, g);
      // Classic surprise lines fanning out above the mark.
      for (const a of [-55, -90, -125]) {
        const r = (a * Math.PI) / 180;
        el('line', { x1: Math.cos(r) * 26, y1: Math.sin(r) * 26 - 6, x2: Math.cos(r) * 40, y2: Math.sin(r) * 40 - 6, class: 'surprise-line' }, mark);
      }
      const t = el('text', { 'text-anchor': 'middle', dy: '0.35em', class: step.giveUp ? 'surprise give-up' : 'surprise' }, mark);
      t.textContent = step.giveUp ? '✗' : '!';
    }
  }

  private drawPose(seg: Seg, k: number, trip: Trip, parts: Part[], pose: Pose, wiggle: number): void {
    const visible = parts.filter((p) => p.op > 0.01);
    const lengths = visible.map((p) => p.len * p.f * p.scale * pose.lenScale);
    const total = lengths.reduce((a, b) => a + b, 0) + pose.gap * Math.max(0, visible.length - 1);
    let u = total / 2;
    const placed: { p: Part; u0: number; u1: number }[] = [];
    visible.forEach((p, i) => {
      const len = lengths[i]!;
      placed.push({ p, u0: u - len, u1: u });
      u -= len + pose.gap;
    });

    const { pos, axis } = pose;
    const alongX = axis.x !== 0;
    const at = (uu: number): Vec3 => v3(pos.x + axis.x * uu, pos.y + axis.y * uu, pos.z);
    const mid = (a: { u0: number; u1: number }): number => {
      const m = at((a.u0 + a.u1) / 2);
      return m.x + m.y;
    };
    const c = iso(pos.x, pos.y, pos.z);
    const sx = 1 + 0.25 * pose.squash;
    const sy = 1 - 0.25 * pose.squash;
    const g0 = el('g', {
      opacity: pose.op.toFixed(3),
      transform: `rotate(${pose.spin.toFixed(1)} ${c.sx.toFixed(1)} ${c.sy.toFixed(1)}) translate(${c.sx.toFixed(1)} ${c.sy.toFixed(1)}) scale(${sx.toFixed(3)} ${sy.toFixed(3)}) translate(${(-c.sx).toFixed(1)} ${(-c.sy).toFixed(1)})`,
    }, this.packet);

    // Where a piece sits in the world: along the packet's axis, centred across it.
    const footprint = (u0: number, u1: number, d: number, slide: number): { x: number; y: number; w: number; d: number } => {
      const a = at(u0 + slide);
      const b = at(u1 + slide);
      return alongX
        ? { x: Math.min(a.x, b.x), y: pos.y - d / 2, w: Math.abs(b.x - a.x), d }
        : { x: pos.x - d / 2, y: Math.min(a.y, b.y), w: d, d: Math.abs(b.y - a.y) };
    };
    // The end cap whose end face looks at the viewer carries the "Ethernet" label.
    const facingEnd: PartKey = axis.x + axis.y > 0 ? 'ethH' : 'ethT';

    for (const { p, u0, u1 } of [...placed].sort((m, n) => mid(m) - mid(n))) {
      const sec = SECTION[p.layer];
      const d = sec.d * p.scale;
      const h = sec.h * p.scale;
      const f = footprint(u0, u1, d, p.slide);
      const along = alongX ? f.w : f.d;
      if (along < 0.005) continue;
      const z = pos.z - h / 2 + p.lift + (p.key === 'card' ? wiggle : 0);
      const color = colorOf(p.layer, trip);
      const g = el('g', { opacity: p.op.toFixed(3), class: `part part-${p.layer}` }, g0);
      box(g, { x: f.x, y: f.y, z, w: f.w, d: f.d, h, color });
      // Name printed on the long side facing the viewer, if there is room for it.
      const label = p.key === 'card' ? (trip.card ?? '') : p.key === 'ip' ? 'IP' : p.key === 'l4' ? trip.l4Label : '';
      const font = p.key === 'card' ? cardFont(label) : 10;
      if (label && along * U > label.length * font * 0.62 + 4 && p.f > 0.6 && pose.lenScale > 0.95) {
        const side = alongX ? iso(f.x + f.w / 2, f.y + f.d, z + h / 2) : iso(f.x + f.w, f.y + f.d / 2, z + h / 2);
        const t = el('text', { class: p.key === 'card' ? 'face-label card-label' : 'face-label', 'text-anchor': 'middle', 'font-size': font, dy: '0.35em', transform: faceTf(side, alongX ? '+y' : '+x') }, g);
        t.textContent = label;
      }
      if (p.key === facingEnd && pose.sleeve > 0.5 && pose.lenScale > 0.95) {
        const end = alongX ? iso(f.x + f.w, f.y + f.d / 2, z + h / 2) : iso(f.x + f.w / 2, f.y + f.d, z + h / 2);
        const t = el('text', { class: 'face-label eth-label', 'text-anchor': 'middle', dy: '0.35em', transform: faceTf(end, alongX ? '+x' : '+y') }, g);
        t.textContent = 'Ethernet';
      }
    }

    // The Ethernet sleeve: a see-through wrap from the header cap to the trailer cap.
    const sleeve = parts.find((p) => p.key === 'ethH');
    const front = placed.find((x) => x.p.key === 'ethH');
    const back = placed.find((x) => x.p.key === 'ethT');
    if (sleeve && front && back && sleeve.op * pose.sleeve > 0.01) {
      const sec = SECTION.eth;
      const f = footprint(back.u0, front.u1, sec.d + 0.04, sleeve.slide);
      const g = el('g', { opacity: (sleeve.op * pose.sleeve).toFixed(3), class: 'sleeve' }, g0);
      box(g, { x: f.x, y: f.y, z: pos.z - sec.h / 2 - 0.02 + sleeve.lift, w: f.w, d: f.d, h: sec.h + 0.04, color: COLOR.eth });
    }

    const ip = parts.find((p) => p.key === 'ip');
    if (ip && ip.op > 0.5 && ip.f > 0.5 && pose.tag) {
      this.addressTag(seg, k, v3(pos.x - axis.x * 0.6, pos.y - axis.y * 0.6, pos.z + 2.35), 1 - pose.chips * 2);
    }
    if (pose.chips > 0.02) {
      const items = placed.map(({ p, u0, u1 }) => ({ p, top: v3(at((u0 + u1) / 2).x, at((u0 + u1) / 2).y, pos.z + SECTION[p.layer].h / 2) }));
      this.sizeChips(items, trip, pose.chips);
    }
  }

  /** Each layer piece's state at progress k of a segment. */
  private parts(seg: Seg, k: number): Part[] {
    const trip = seg.trip;
    const on = wrapsBefore(seg);
    const step = seg.step;
    const work = clamp01((k - 0.35) / 0.65);
    const mk = (key: PartKey, layer: Layer, bytes: number, len: number): Part => {
      const wrap = layer === 'app' ? null : layer;
      const off = !!wrap && !on.has(wrap);
      const p: Part = { key, layer, bytes, len, f: off ? 0 : 1, lift: 0, slide: 0, op: off ? 0 : 1, scale: 1 };
      if (wrap && (step.kind === 'wrap' || step.kind === 'unwrap') && step.layer === wrap) {
        if (step.kind === 'wrap') {
          const e = easeOutBack(work);
          p.f = easeInOut(work);
          p.op = clamp01(work * 3);
          if (wrap === 'eth') p.slide = (1 - e) * 2.2;
          else p.lift = (1 - e) * 1.8;
        } else if (wrap === 'eth') {
          // The old sleeve slides back a little, drops to the floor, bounces and fades.
          p.f = 1 - easeInOut(work);
          p.slide = -easeOut(clamp01(work / 0.3)) * 0.8;
          const fall = clamp01((work - 0.25) / 0.75);
          p.lift = -1.6 * easeOutBounce(fall);
          p.op = 1 - clamp01((fall - 0.65) / 0.35);
        } else {
          p.f = 1 - easeInOut(work);
          p.lift = easeIn(work) * 1.8;
          p.op = 1 - work;
        }
      }
      if (layer === 'app' && step.kind === 'appear') {
        p.scale = Math.max(0.01, easeOutBack(clamp01(k / 0.7)));
        p.op = clamp01(k * 4);
      }
      return p;
    };
    const L = TILES_PER_BYTE;
    const list = [
      mk('ethH', 'eth', trip.header.eth, trip.header.eth * L),
      mk('ip', 'ip', trip.header.ip, trip.header.ip * L),
      mk('l4', 'l4', trip.header.l4, trip.header.l4 * L),
    ];
    if (trip.card) list.push(mk('card', 'app', trip.dataBytes, cardLen(trip)));
    list.push(mk('ethT', 'eth', trip.trailer, Math.max(trip.trailer * L, 0.12)));
    // The trailer cap follows the sleeve: the same slide and fall.
    const head = list[0]!;
    const tail = list[list.length - 1]!;
    Object.assign(tail, { f: head.f, lift: head.lift, slide: head.slide, op: head.op });
    return list;
  }

  private sizeChips(items: { p: Part; top: Vec3 }[], trip: Trip, op: number): void {
    const chips = items
      .map(({ p, top }) => {
        const name = p.key === 'card' ? (trip.card ?? '') : p.key === 'ethT' ? '' : p.key === 'l4' ? trip.l4Label : layerName(p.layer, trip);
        const text = name ? `${name} · ${p.bytes} B` : `${p.bytes} B`;
        return { p, a: iso(top.x, top.y, top.z), text, w: text.length * 6.6 + 14, x: 0 };
      })
      .sort((m, n) => m.a.sx - n.a.sx);
    if (!chips.length) return;
    // Centre the row over the packet, then push chips apart so none overlap.
    const total = chips.reduce((s, c) => s + c.w + 6, -6);
    let x = (chips[0]!.a.sx + chips[chips.length - 1]!.a.sx) / 2 - total / 2;
    for (const c of chips) {
      c.x = x + c.w / 2;
      x += c.w + 6;
    }
    const y = Math.min(...chips.map((c) => c.a.sy)) - 30 - 20 * op;
    for (const c of chips) {
      const color = colorOf(c.p.layer, trip);
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
      changed = seg.step.which;
      const w = clamp01((k - 0.3) / 0.4);
      if (w >= 0.5) a[seg.step.which] = seg.step.after;
      flipScale = Math.abs(1 - 2 * w);
    }
    const s = iso(p.x, p.y, p.z);
    const pop = changed ? 1.25 : 1;
    // The arrow says which way we're going: out from the asker, or back to it.
    const back = seg.trip.origin !== 'laptop';
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

function formatWait(s: number): string {
  if (s >= 1) return `${Number(s.toFixed(1))} s`;
  return `${Math.round(s * 1000)} ms`;
}

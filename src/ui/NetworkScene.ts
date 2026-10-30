import { el } from './svg';
import { box, cylinder, line, rbox, tile } from './prims';
import { clamp01, easeIn, easeInOut, easeOut, easeOutBack, iso, lerp, U, v3, type Vec3 } from './project';
import { shade } from './shade';
import type { Story, Trip, Wrap } from './story';
import { addressBefore, DEVICE_TOP, FACE_EMOJI, frameAt, LEVEL, packetPos, packetPose, segAt, trayOpacity, wrapsBefore, type Seg, type Timeline } from './timeline';

export const COLOR = { app: '#4f9d69', tcp: '#8b6fd0', udp: '#b8609f', ip: '#4a84d4', eth: '#e08b33', wifi: '#2a9d8f' } as const;
const DEVICE = '#d9d0c2';
/** A locked (encrypted) card: dark, with a padlock instead of what it says. */
const LOCKED = '#3d4654';

/** Mix two #rrggbb colours. */
function mix(a: string, b: string, t: number): string {
  const p = (h: string, i: number): number => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const c = [0, 1, 2].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t).toString(16).padStart(2, '0'));
  return `#${c.join('')}`;
}

/** Lock state of a card: closes at the end of `appear` at the sender, opens at the start of `read` at the receiver. */
function lockAt(seg: Seg, k: number): number {
  if (!seg.trip.locked) return 0;
  if (seg.step.kind === 'appear') return clamp01((k - 0.55) / 0.2);
  if (seg.step.kind === 'read') return 1 - clamp01((k - 0.05) / 0.2);
  return 1;
}

/** 0..1 while the lock is clicking shut or springing open, else 0. */
function lockClick(seg: Seg, k: number): number {
  if (!seg.trip.locked) return 0;
  const q = seg.step.kind === 'appear' ? (k - 0.6) / 0.25 : seg.step.kind === 'read' ? (k - 0.1) / 0.25 : -1;
  return q > 0 && q < 1 ? q : 0;
}
const BURST = '#ffd84a';
const WAIT = '#c2562f';

/** Header bytes → tiles along the packet. The data card is not to scale (it would dwarf the headers). */
const TILES_PER_BYTE = 0.04;
type Layer = Wrap | 'app';
const SECTION: Record<Layer, { d: number; h: number }> = { app: { d: 1.0, h: 0.72 }, l4: { d: 1.18, h: 0.88 }, ip: { d: 1.34, h: 1.02 }, eth: { d: 1.62, h: 1.18 } };

type L2 = 'ethernet' | 'wifi';
const colorOf = (layer: Layer, trip: Trip, l2: L2 = 'ethernet'): string =>
  layer === 'l4' ? COLOR[trip.l4] : layer === 'eth' && l2 === 'wifi' ? COLOR.wifi : COLOR[layer];
const layerName = (layer: Layer, trip: Trip, l2: L2 = 'ethernet'): string =>
  ({ app: 'App', l4: trip.l4 === 'udp' ? 'UDP' : 'TCP', ip: 'IP', eth: l2 === 'wifi' ? 'Wi-Fi' : 'Ethernet' })[layer];
const cardFont = (label: string): number => (label.length <= 7 ? 13 : label.length <= 14 ? 10.5 : 9);
const cardLen = (trip: Trip): number => {
  // Room for the label as it shows (locked cards show only a padlock and maybe a number).
  const label = trip.locked ? (trip.card?.match(/\d+\/\d+$/)?.[0] ?? '') + '🔒 ' : (trip.card ?? '');
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
  /** Direction the packet's front (byte 0) faces, radians from +x towards +y. */
  angle: number;
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
  /** The frame tray (Ethernet or Wi-Fi) and its name. */
  l2Tray: SVGPathElement | null;
  l2Name: SVGTextElement | null;
}

interface Screen {
  page: SVGGElement;
  title: SVGTextElement;
  dns: SVGGElement;
  dnsName: SVGTextElement;
  dnsAddr: SVGTextElement;
  fail: SVGTextElement;
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
  /** Emoji statuses over devices; on top of everything. */
  private readonly moods: SVGGElement;
  private readonly fx: SVGGElement;
  /** What the laptop and the phone show on their screens. */
  private readonly screens = new Map<string, Screen>();
  /** Cables that crackle in stormy weather, and the layer they crackle on. */
  private stormy: { a: Vec3; b: Vec3 }[] = [];
  private readonly storm: SVGGElement;
  /** Where a page that comes in several parts is put back together, beside the laptop. */
  private readonly rack: SVGGElement;
  private overview = { x: 0, y: 0, w: 1, h: 1 };
  /** The kind of frame around the packet being drawn. */
  private l2: L2 = 'ethernet';
  /** How locked the card being drawn is (0 open, 1 locked): HTTPS cards lock at the sender and open at the receiver. */
  private lock = 0;

  private cardText(trip: Trip): string {
    return this.lock > 0.5 ? (trip.card?.match(/\d+\/\d+$/) ? `🔒 ${trip.card.match(/\d+\/\d+$/)![0]}` : '🔒') : (trip.card ?? '');
  }
  private readonly cables: SVGGElement;
  /** Each drawn cable (or satellite hop) and the devices at its ends, to grey out the unused ones. */
  private cableViews: { g: SVGGElement; a: string; b: string }[] = [];
  /** Devices that take part in this run; the rest are greyed out once it starts. */
  private used = new Set<string>();

  constructor(
    host: HTMLElement,
    private story: Story,
    private tl: Timeline,
  ) {
    this.svg = el('svg', { class: 'net-stage', preserveAspectRatio: 'xMidYMid meet' });
    host.appendChild(this.svg);
    const world = el('g', {}, this.svg);
    this.cables = el('g', { class: 'cables' }, world);
    this.storm = el('g', { class: 'storm' }, world);
    const devs = el('g', {}, world);
    this.rack = el('g', { class: 'rack' }, world);
    // Effects (impact bursts, timers) sit behind the packet, the way an anime impact star does.
    this.fx = el('g', { class: 'fx' }, world);
    this.packet = el('g', { class: 'packet' }, world);
    this.tags = el('g', { class: 'tags' }, world);
    this.moods = el('g', { class: 'moods' }, world);

    // Draw far devices first: a larger x + y is nearer the viewer.
    const order = [...story.devices].sort((m, n) => this.depthOf(m.id) - this.depthOf(n.id));
    for (const d of order) {
      const p = tl.pos.get(d.id) ?? { x: 0, y: 0 };
      const trays = el('g', { class: 'trays', opacity: 0 }, devs);
      const g = el('g', { class: 'device' }, devs);
      const screen = this.buildDevice(g, d.kind, p.x, p.y);
      if (screen) this.screens.set(d.id, screen);
      const { l4Name, l2Tray, l2Name } = this.buildTrays(trays, d.id, p.x, p.y);
      const s = iso(p.x, p.y + 1.9, 0);
      const name = el('text', { class: 'device-name', 'text-anchor': 'middle', x: s.sx.toFixed(1), y: (s.sy + 26).toFixed(1) }, g);
      name.textContent = d.label;
      this.devices.push({ id: d.id, g, trays, l4Name, l2Tray, l2Name });
    }
    this.fit();
    this.setStory(story, tl);
  }

  /** Swap in a re-simulated story (after a knock). Devices and cables stay; what's on the laptop screen may change. */
  setStory(story: Story, tl: Timeline): void {
    this.story = story;
    this.tl = tl;
    this.buildCables();
    this.used = new Set(story.trips.flatMap((t) => t.steps.flatMap((s) => ('device' in s ? [s.device] : [s.from, s.to]))));
    for (const screen of this.screens.values()) {
      // A long title wraps onto two lines at the space nearest the middle.
      const t = story.pageTitle ?? '';
      const cut = t.length > 14 ? [...t.matchAll(/ /g)].map((m) => m.index).sort((a, b) => Math.abs(a - t.length / 2) - Math.abs(b - t.length / 2))[0] : undefined;
      screen.title.replaceChildren();
      const lines = cut === undefined ? [t] : [t.slice(0, cut), t.slice(cut + 1)];
      lines.forEach((line, i) => {
        const span = el('tspan', { x: screen.title.getAttribute('x') ?? 0, dy: i ? '1.15em' : lines.length > 1 ? '-0.4em' : '0' }, screen.title);
        span.textContent = line;
      });
      screen.dnsName.textContent = story.site;
      screen.dnsAddr.textContent = story.remembered ?? story.dnsAnswer ?? '';
    }
  }

  /** Cables between devices; a slow link is a radio hop up to a satellite instead. */
  private buildCables(): void {
    this.cables.replaceChildren();
    this.cableViews = [];
    for (const l of this.story.links) {
      const a = this.tl.pos.get(l.a);
      const b = this.tl.pos.get(l.b);
      if (!a || !b) continue;
      const g = el('g', { class: 'link' }, this.cables);
      const sky = this.tl.sky.get(l.id);
      if (this.tl.air.has(l.id)) {
        const za = (DEVICE_TOP[this.tl.kind.get(l.a) ?? ''] ?? 1) + 0.2;
        const zb = (DEVICE_TOP[this.tl.kind.get(l.b) ?? ''] ?? 1) + 0.9;
        const pts: string[] = [];
        for (let i = 0; i <= 20; i++) {
          const q = i / 20;
          const p = iso(lerp(a.x, b.x, q), lerp(a.y, b.y, q), lerp(za, zb, q) + Math.sin(Math.PI * q) * 1.4);
          pts.push(`${p.sx.toFixed(1)},${p.sy.toFixed(1)}`);
        }
        el('polyline', { points: pts.join(' '), class: 'airwave' }, g);
        // Radio ripples at both ends.
        for (const [p, z] of [[a, za], [b, zb]] as const) {
          const c = iso(p.x, p.y, z + 0.3);
          for (const r of [7, 12, 17]) el('path', { d: `M${(c.sx - r).toFixed(1)} ${(c.sy - r * 0.2).toFixed(1)}A${r} ${r} 0 0 1 ${(c.sx + r).toFixed(1)} ${(c.sy - r * 0.2).toFixed(1)}`, class: 'ripple' }, g);
        }
      } else if (sky) {
        const top = v3((a.x + b.x) / 2, (a.y + b.y) / 2, sky);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const ux = (b.x - a.x) / len;
        const uy = (b.y - a.y) / len;
        // Radio beams from a dish beside each end up to the satellite.
        for (const [p, s] of [[a, 1], [b, -1]] as const) {
          const foot = v3(p.x + ux * 2.4 * s, p.y + uy * 2.4 * s, 0.3);
          line(g, foot, top, { class: 'beam' });
          cylinder(g, { x: foot.x, y: foot.y, z: 0, r: 0.35, h: 0.3, color: DEVICE });
        }
        // The satellite: a small body with a solar panel either side.
        rbox(g, { cx: top.x, cy: top.y, z: top.z - 0.35, len: 0.7, wid: 0.7, h: 0.7, angle: 0, color: '#cfc6b8' });
        for (const s of [-1, 1]) tile(g, top.x - 0.45 + s * 1.15, top.y - 0.35, 0.9, 0.7, top.z, { class: 'panel' });
      } else {
        line(g, v3(a.x, a.y, 0), v3(b.x, b.y, 0), { class: 'cable' });
      }
      this.cableViews.push({ g, a: l.a, b: l.b });
    }
  }

  /** Which cables crackle (stormy weather on the internet side), by link id; empty for calm weather. */
  setStorm(links: readonly string[]): void {
    this.stormy = this.story.links
      .filter((l) => links.includes(l.id))
      .flatMap((l) => {
        const a = this.tl.pos.get(l.a) ?? { x: 0, y: 0 };
        const b = this.tl.pos.get(l.b) ?? { x: 0, y: 0 };
        const sky = this.tl.sky.get(l.id);
        if (!sky) return [{ a: v3(a.x, a.y, 0), b: v3(b.x, b.y, 0) }];
        // A satellite hop crackles along both radio beams.
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const ux = (b.x - a.x) / len;
        const uy = (b.y - a.y) / len;
        const top = v3((a.x + b.x) / 2, (a.y + b.y) / 2, sky);
        return [
          { a: v3(a.x + ux * 2.4, a.y + uy * 2.4, 0.3), b: top },
          { a: top, b: v3(b.x - ux * 2.4, b.y - uy * 2.4, 0.3) },
        ];
      });
  }

  /**
   * Stormy cables crackle: a jittery electric line and the odd spark. This is weather, not story, so it runs on
   * the wall clock (`time`, seconds) and changes in little jumps.
   */
  renderStorm(time: number): void {
    this.storm.replaceChildren();
    if (!this.stormy.length) return;
    const tick = Math.floor(time * 12);
    const rnd = (n: number): number => {
      const x = Math.sin(n * 12.9898 + tick * 78.233) * 43758.5453;
      return x - Math.floor(x);
    };
    this.stormy.forEach(({ a, b }, li) => {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      const steps = Math.max(4, Math.round(len / 0.45));
      const pts: string[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        // Ends stay on the ports; the middle jumps around.
        const amp = Math.sin(Math.PI * t) * 0.34;
        const off = (rnd(li * 100 + i) - 0.5) * 2 * amp;
        const z = (rnd(li * 100 + i + 50) - 0.3) * amp * 1.2;
        const p = iso(a.x + ux * len * t - uy * off, a.y + uy * len * t + ux * off, Math.max(0, lerp(a.z, b.z, t) + z));
        pts.push(`${p.sx.toFixed(1)},${p.sy.toFixed(1)}`);
      }
      const flicker = (0.55 + 0.45 * rnd(li + 7)).toFixed(2);
      // A dark edge under the yellow keeps it readable on the light table.
      el('polyline', { points: pts.join(' '), class: 'crackle-edge', opacity: flicker }, this.storm);
      el('polyline', { points: pts.join(' '), class: 'crackle', opacity: flicker }, this.storm);
      // Now and then a spark jumps off the cable.
      if (rnd(li + 31) > 0.72) {
        const t = 0.15 + 0.7 * rnd(li + 3);
        const p = iso(a.x + ux * len * t, a.y + uy * len * t, 0.3);
        const r = 5 + 6 * rnd(li + 9);
        const spikes = [0, 1, 2, 3, 4, 5, 6, 7].map((j) => {
          const ang = (j / 8) * Math.PI * 2;
          const rr = j % 2 ? r * 0.4 : r;
          return `${(p.sx + Math.cos(ang) * rr).toFixed(1)},${(p.sy + Math.sin(ang) * rr).toFixed(1)}`;
        });
        el('polygon', { points: spikes.join(' '), class: 'spark' }, this.storm);
      }
    });
  }

  /** Slot n (1-based) of the reassembly rack, as a world point the arriving card flies into. */
  private rackSlot(n: number, of: number): Vec3 {
    const lap = this.tl.pos.get(this.tl.client) ?? { x: 0, y: 0 };
    // Screen-right in world units is (+0.5, −0.5) per 28 px; slots sit 52 px apart.
    const step = 52 / U;
    const o = (n - 1 - (of - 1) / 2) * step;
    return v3(lap.x - 3.0 + 0.5 * o, lap.y + 0.9 - 0.5 * o, 1.6);
  }

  /** The parts of a page that came in several packets, and when each one slotted into the rack (Infinity: not yet). */
  private partArrivals(): { of: number; filled: Map<number, number>; shownFrom: number } | null {
    let of = 0;
    let shownFrom = Infinity;
    const filled = new Map<number, number>();
    for (const s of this.tl.segs) {
      const part = s.trip.part;
      if (!part) continue;
      of = part.of;
      shownFrom = Math.min(shownFrom, s.t0);
      if (s.step.kind === 'read' && s.step.device === this.tl.client && !filled.has(part.n)) filled.set(part.n, lerp(s.t0, s.t1, 0.92));
    }
    return of > 1 ? { of, filled, shownFrom } : null;
  }

  /** The rack beside the laptop: one slot per part; each fills when its part arrives, gaps show what's missing. */
  private renderRack(v: number): void {
    this.rack.replaceChildren();
    const parts = this.partArrivals();
    if (!parts || v < parts.shownFrom) return;
    const op = clamp01((v - parts.shownFrom) / 0.4);
    const all = [...parts.filled.values()];
    const complete = all.length === parts.of ? Math.max(...all) : Infinity;
    // Once the page is whole the rack slides into the laptop and goes.
    const gone = clamp01((v - complete - 0.3) / 0.5);
    const g = el('g', { opacity: (op * (1 - gone)).toFixed(3) }, this.rack);
    for (let n = 1; n <= parts.of; n++) {
      const w = this.rackSlot(n, parts.of);
      const c = iso(w.x, w.y, w.z);
      const at = parts.filled.get(n) ?? Infinity;
      const pop = v >= at ? easeOutBack(clamp01((v - at) / 0.3)) : 0;
      el('rect', { x: c.sx - 21, y: c.sy - 14, width: 42, height: 28, rx: 6, class: 'rack-slot' }, g);
      if (pop > 0) {
        const fg = el('g', { transform: `translate(${c.sx.toFixed(1)} ${c.sy.toFixed(1)}) scale(${pop.toFixed(3)})` }, g);
        el('rect', { x: -19, y: -12, width: 38, height: 24, rx: 5, fill: COLOR.app, class: 'rack-card' }, fg);
        const t = el('text', { 'text-anchor': 'middle', dy: '0.35em', class: 'rack-num' }, fg);
        t.textContent = String(n);
      } else {
        const t = el('text', { x: c.sx.toFixed(1), y: c.sy.toFixed(1), 'text-anchor': 'middle', dy: '0.35em', class: 'rack-num empty' }, g);
        t.textContent = String(n);
      }
    }
  }

  private depthOf(id: string): number {
    const p = this.tl.pos.get(id) ?? { x: 0, y: 0 };
    return p.x + p.y;
  }

  /** Screen points (in SVG units) where the laptop and the phone accept a dropped card. */
  dropPoints(): { id: string; sx: number; sy: number }[] {
    return ['laptop', 'phone'].flatMap((id) => {
      const p = this.tl.pos.get(id);
      return p ? [{ id, ...iso(p.x, p.y - 0.3, id === 'phone' ? 1.4 : 1.0) }] : [];
    });
  }

  private fit(): void {
    const pts: { sx: number; sy: number }[] = [];
    for (const p of this.tl.pos.values()) for (const [dx, dy] of [[-2, -2], [2, 2.4], [-2, 2.4], [2, -2]] as const) for (const z of [0, 3.2]) pts.push(iso(p.x + dx, p.y + dy, z));
    // Room for the site card waiting left of the laptop.
    pts.push(iso(-8.6, 0.4, 3.6));
    // And for the sticker sheet above it.
    pts.push(iso(-4.6, 0.4, 8.2), iso(-9.4, -2.4, 6.5));
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
      const c = iso(-3.0, 0.2, 3.4);
      return { cx: c.sx, cy: c.sy, scale: Math.max(this.baseScale(), cw / 400) };
    }
    return { cx: o.x + o.w / 2, cy: o.y + o.h / 2, scale: this.baseScale() };
  }

  /** Close on the packet (or the device it is at) at visual time v. */
  followCamera(v: number): Camera {
    const hit = segAt(this.tl, v);
    let p: Vec3;
    const laptop = this.tl.pos.get(this.tl.client) ?? { x: 0, y: 0 };
    const mood = this.tl.reactions.find((r) => v >= r.t && v < r.t + 1.1);
    if (mood && (!hit || v < hit.seg.t0)) {
      // Between trips: stay on whoever is reacting.
      const d = this.tl.pos.get(mood.device) ?? { x: 0, y: 0 };
      p = v3(d.x, d.y, (DEVICE_TOP[this.tl.kind.get(mood.device) ?? ''] ?? 1) + 1.5);
    } else if (hit?.seg.step.kind === 'wait') {
      const d = this.tl.pos.get(hit.seg.step.device) ?? { x: 0, y: 0 };
      p = v3(d.x, d.y, (DEVICE_TOP[this.tl.kind.get(hit.seg.step.device) ?? ''] ?? 1) + 1.5);
    } else if (hit) {
      p = packetPos(this.tl, hit.seg, hit.k);
      if (hit.seg.step.kind === 'read' && hit.seg.step.device === this.tl.client) p = v3(p.x, p.y, lerp(p.z, 1.2, hit.k));
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

  /**
   * A screen on a vertical face at world point `a` (its top-left corner, face looking towards +y), `w` × `h` px.
   * Content is laid out for the laptop's 66 × 37 px screen and scaled to fit.
   */
  private buildScreen(g: SVGGElement, a: { sx: number; sy: number }, w: number, h: number): Screen {
    const face = el('g', { transform: faceTf(a, '+y') }, g);
    el('rect', { x: 0, y: 0, width: w, height: h, fill: '#3b4049' }, face);
    const W = 2.36 * U;
    const H = 1.32 * U;
    const k = Math.min(w / W, h / H);
    const page = el('g', { class: 'page', opacity: 0 }, face);
    el('rect', { x: 0, y: 0, width: w, height: h, fill: '#fbf8f2' }, page);
    const content = (parent: SVGGElement): SVGGElement =>
      el('g', { transform: `translate(${((w - W * k) / 2).toFixed(2)} ${((h - H * k) / 2).toFixed(2)}) scale(${k.toFixed(3)})` }, parent);
    const dns = el('g', { class: 'screen-dns', opacity: 0 }, face);
    const dc = content(dns);
    const name = el('text', { x: W / 2, y: H * 0.38, class: 'screen-small', 'text-anchor': 'middle' }, dc);
    const dnsAddr = el('text', { x: W / 2, y: H * 0.62, class: 'screen-addr', 'text-anchor': 'middle' }, dc);
    const pc = content(page);
    const title = el('text', { x: W / 2, y: 0.5 * U, class: 'page-title', 'text-anchor': 'middle' }, pc);
    for (const [i, lw] of [0.8, 0.62, 0.7].entries()) {
      el('rect', { x: (W - W * lw) / 2, y: 0.78 * U + i * 6, width: W * lw, height: 2.4, rx: 1.2, fill: '#c9c1b5' }, pc);
    }
    const fail = el('text', { x: w / 2, y: h / 2, dy: '0.35em', class: 'screen-fail', 'text-anchor': 'middle', opacity: 0 }, face);
    fail.textContent = '✗';
    return { page, title, dns, dnsName: name, dnsAddr, fail };
  }

  private buildDevice(g: SVGGElement, kind: string, x: number, y: number): Screen | null {
    const neutral = { color: DEVICE, cls: 'dev-body' };
    switch (kind) {
      case 'laptop': {
        box(g, { x: x - 1.3, y: y - 0.9, z: 0, w: 2.6, d: 1.8, h: 0.14, ...neutral });
        box(g, { x: x - 1.3, y: y - 1.05, z: 0.14, w: 2.6, d: 0.1, h: 1.56, ...neutral });
        // Screen glass on the face towards the viewer; what it shows changes as the story goes on.
        return this.buildScreen(g, iso(x - 1.18, y - 0.95, 1.6), 2.36 * U, 1.32 * U);
      }
      case 'phone': {
        // A phone standing on a little stand, screen towards the viewer.
        box(g, { x: x - 0.5, y: y - 0.6, z: 0, w: 1.0, d: 0.5, h: 0.25, ...neutral });
        box(g, { x: x - 0.7, y: y - 0.12, z: 0, w: 1.4, d: 0.22, h: 2.3, ...neutral });
        return this.buildScreen(g, iso(x - 0.6, y + 0.1, 2.18), 1.2 * U, 2.0 * U);
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

  /** Returns the trays whose names change with the packet: transport (TCP or UDP) and frame (Ethernet or Wi-Fi). */
  private buildTrays(g: SVGGElement, device: string, x: number, y: number): Pick<DeviceView, 'l4Name' | 'l2Tray' | 'l2Name'> {
    const layers: Layer[] = this.tl.isRouter(device) ? ['eth', 'ip'] : ['eth', 'ip', 'l4', 'app'];
    const out: Pick<DeviceView, 'l4Name' | 'l2Tray' | 'l2Name'> = { l4Name: null, l2Tray: null, l2Name: null };
    for (const layer of layers) {
      const color = layer === 'l4' ? COLOR.tcp : COLOR[layer];
      const z = this.tl.trayZ(device, LEVEL[layer]) - SECTION.eth.h / 2 - 0.12;
      const tray = tile(g, x - 2.9, y - 1.15, 5.8, 2.3, z, { class: 'tray', fill: color, stroke: color });
      const p = iso(x + 2.9, y - 1.15, z);
      const t = el('text', { x: p.sx + 8, y: p.sy + 4, class: 'tray-name', 'text-anchor': 'start', fill: shade(color, 0.75) }, g);
      t.textContent = layer === 'app' ? 'App' : layer === 'l4' ? 'TCP' : layer === 'ip' ? 'IP' : 'Ethernet';
      if (layer === 'l4') out.l4Name = t;
      if (layer === 'eth') {
        out.l2Tray = tray;
        out.l2Name = t;
      }
    }
    return out;
  }

  /** Devices, trays and the laptop screen at visual time v. */
  render(v: number): void {
    const tl = this.tl;
    const hit = segAt(tl, v);
    // Once a run starts, whatever it doesn't use steps back.
    const greying = v >= 0;
    for (const d of this.devices) d.g.classList.toggle('unused', greying && !this.used.has(d.id));
    for (const c of this.cableViews) c.g.classList.toggle('unused', greying && (!this.used.has(c.a) || !this.used.has(c.b)));
    for (const d of this.devices) {
      d.trays.setAttribute('opacity', trayOpacity(tl, d.id, v).toFixed(3));
      d.g.setAttribute('transform', `translate(0 ${(-this.hop(d.id, v) * U).toFixed(2)})`);
      if (d.l4Name && hit) {
        const udp = hit.seg.trip.l4 === 'udp';
        d.l4Name.textContent = udp ? 'UDP' : 'TCP';
        d.l4Name.setAttribute('fill', shade(udp ? COLOR.udp : COLOR.tcp, 0.75));
      }
      if (d.l2Tray && d.l2Name && hit) {
        const wifi = frameAt(hit.seg)?.l2 === 'wifi';
        const color = wifi ? COLOR.wifi : COLOR.eth;
        d.l2Name.textContent = wifi ? 'Wi-Fi' : 'Ethernet';
        d.l2Name.setAttribute('fill', shade(color, 0.75));
        d.l2Tray.setAttribute('fill', color);
        d.l2Tray.setAttribute('stroke', color);
      }
    }
    this.renderRack(v);
    this.renderMoods(v);
    for (const [id, screen] of this.screens) if (id !== tl.client) this.blank(screen);
    const screen = this.screens.get(tl.client);
    if (!screen) return;
    // A page in several parts shows once the last missing part has slotted into the rack.
    const parts = this.partArrivals();
    const whole = parts && parts.filled.size === parts.of ? Math.max(...parts.filled.values()) : Infinity;
    const pageAt = parts ? clamp01((v - whole - 0.3) / 0.4) : this.screenAfterRead(v, 'page');
    const page = this.story.pageTitle ? pageAt : 0;
    screen.page.setAttribute('opacity', page.toFixed(3));
    // On a second visit the laptop already knows the address from the start.
    const known = this.story.remembered ? (v >= 0 ? 1 : 0) : this.screenAfterRead(v, 'dns');
    screen.dns.setAttribute('opacity', (known * (1 - page)).toFixed(3));
    const last = tl.segs[tl.segs.length - 1];
    const failed = !this.story.pageTitle && !!last && v >= last.t1;
    screen.fail.setAttribute('opacity', failed ? '1' : '0');
  }

  private blank(screen: Screen): void {
    for (const e of [screen.page, screen.dns, screen.fail]) e.setAttribute('opacity', '0');
  }

  /** Emoji statuses: each pops up over its device, floats up a little and fades. */
  private renderMoods(v: number): void {
    this.moods.replaceChildren();
    for (const r of this.tl.reactions) {
      const dt = v - r.t;
      if (dt < 0 || dt > 1.6) continue;
      const d = this.tl.pos.get(r.device) ?? { x: 0, y: 0 };
      const top = DEVICE_TOP[this.tl.kind.get(r.device) ?? ''] ?? 1;
      this.emoji(this.moods, iso(d.x, d.y, top + 2.2 + 0.4 * dt), FACE_EMOJI[r.face], easeOutBack(clamp01(dt / 0.3)), 1 - clamp01((dt - 1.2) / 0.4));
    }
  }

  /** One emoji in a round white bubble, centred on a screen point. */
  private emoji(parent: SVGGElement, c: { sx: number; sy: number }, glyph: string, scale: number, op: number): void {
    const g = el('g', { class: 'mood', opacity: op.toFixed(3), transform: `translate(${c.sx.toFixed(1)} ${c.sy.toFixed(1)}) scale(${scale.toFixed(3)})` }, parent);
    el('circle', { r: 20, class: 'mood-bg' }, g);
    const t = el('text', { 'text-anchor': 'middle', dy: '0.36em', class: 'mood-face' }, g);
    t.textContent = glyph;
  }

  /** 0..1: how far the laptop has shown what a card of this chapter brought (it fades in as the card goes in). */
  private screenAfterRead(v: number, chapter: Trip['chapter']): number {
    let o = 0;
    for (const s of this.tl.segs) {
      if (s.step.kind !== 'read' || s.trip.chapter !== chapter || s.step.device !== this.tl.client) continue;
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
    this.l2 = frameAt(seg)?.l2 ?? 'ethernet';
    this.lock = lockAt(seg, k);
    const parts = this.parts(seg, k);
    // The lock clicks shut (or springs open) with a little bounce.
    const click = lockClick(seg, k);
    if (click > 0) for (const p of parts) if (p.key === 'card') p.scale *= 1 + 0.18 * Math.sin(Math.PI * click);
    const at = packetPose(this.tl, seg, k);
    const pose: Pose = { pos: at.pos, angle: at.angle, gap: peek * 0.7, spin: 0, squash: 0, op: 1, sleeve: 1 - peek, tag: peek < 0.5, chips: peek };

    // Knocked off the cable: impact, tumble, bounce, fall apart.
    if (step.kind === 'lost' && seg.knock) {
      const tau = k * (seg.t1 - seg.t0) - seg.knock.k * seg.knock.travel;
      if (tau >= 0) {
        this.burst(pose.pos, tau, !seg.knock.byYou);
        this.tumble(pose, tau);
        if (tau > 0.2) {
          const c = iso(pose.pos.x, pose.pos.y, pose.pos.z + 1.6);
          this.emoji(this.tags, c, FACE_EMOJI.sad, easeOutBack(clamp01((tau - 0.2) / 0.3)), pose.op);
        }
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
      const part = seg.trip.part;
      // A part of a bigger page goes into its slot in the rack; anything else into the screen or the device.
      const target =
        step.device === this.tl.client
          ? part
            ? this.rackSlot(part.n, part.of)
            : kind === 'phone'
              ? v3(d.x, d.y + 0.2, 1.3)
              : v3(d.x, d.y - 0.6, 0.95)
          : v3(d.x, d.y, DEVICE_TOP[kind] ?? 1);
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
    const ahead = { x: Math.cos(pose.angle), y: Math.sin(pose.angle) };
    const across = { x: -ahead.y, y: ahead.x };
    const side = across.x + across.y >= 0 ? across : { x: -across.x, y: -across.y };
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
    pose.pos = v3(i.x + side.x * 1.9 * fly + ahead.x * 0.6 * fly, i.y + side.y * 1.9 * fly + ahead.y * 0.6 * fly, z);
    pose.spin = 720 * fly * (ahead.x + ahead.y >= 0 ? 1 : -1);
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
  private burst(at: Vec3, tau: number, zap = false): void {
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
    // The storm did it: a lightning bolt strikes down onto the cable first.
    if (zap && q < 0.6) {
      const bolt = '0,-150 -14,-96 6,-92 -12,-40 8,-38 -4,0 22,-52 2,-56 18,-104 -2,-108 10,-150';
      el('polygon', { points: bolt, class: 'bolt', opacity: (1 - q / 0.6).toFixed(3) }, g);
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
      if (step.mood === 'surprise') {
        const t = el('text', { 'text-anchor': 'middle', dy: '0.35em', class: 'surprise' }, mark);
        t.textContent = '!';
      } else {
        // Lost again: angry. Gave up: in tears.
        this.emoji(mark, { sx: 0, sy: 0 }, FACE_EMOJI[step.mood], 1.25, 1);
      }
    }
  }

  private drawPose(seg: Seg, k: number, trip: Trip, parts: Part[], pose: Pose, wiggle: number): void {
    const visible = parts.filter((p) => p.op > 0.01);
    const lengths = visible.map((p) => p.len * p.f * p.scale);
    const total = lengths.reduce((a, b) => a + b, 0) + pose.gap * Math.max(0, visible.length - 1);
    let u = total / 2;
    const placed: { p: Part; u0: number; u1: number }[] = [];
    visible.forEach((p, i) => {
      const len = lengths[i]!;
      placed.push({ p, u0: u - len, u1: u });
      u -= len + pose.gap;
    });

    const { pos } = pose;
    const dir = { x: Math.cos(pose.angle), y: Math.sin(pose.angle) };
    const across = { x: -dir.y, y: dir.x };
    const at = (uu: number): Vec3 => v3(pos.x + dir.x * uu, pos.y + dir.y * uu, pos.z);
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

    // Text printed on a vertical face runs along the face's bottom edge, pointing right on screen.
    const faceText = (edge: { x: number; y: number }, at3: Vec3): { tf: string; ex: number } | null => {
      let ex = edge.x - edge.y;
      let ey = (edge.x + edge.y) / 2;
      if (ex < 0) {
        ex = -ex;
        ey = -ey;
      }
      if (ex < 0.55) return null;
      const s = iso(at3.x, at3.y, at3.z);
      return { tf: `matrix(${ex.toFixed(3)} ${ey.toFixed(3)} 0 1 ${s.sx.toFixed(1)} ${s.sy.toFixed(1)})`, ex };
    };
    // The long side and the end that face the viewer.
    const side = across.x + across.y >= 0 ? across : { x: -across.x, y: -across.y };
    const frontFaces = dir.x + dir.y > 0.05;
    const backFaces = dir.x + dir.y < -0.05;

    for (const { p, u0, u1 } of [...placed].sort((m, n) => mid(m) - mid(n))) {
      const sec = SECTION[p.layer];
      const d = sec.d * p.scale;
      const h = sec.h * p.scale;
      const along = u1 - u0;
      if (along < 0.005) continue;
      const centre = at((u0 + u1) / 2 + p.slide);
      const z = pos.z - h / 2 + p.lift + (p.key === 'card' ? wiggle : 0);
      const color = p.key === 'card' && this.lock > 0 ? mix(COLOR.app, LOCKED, this.lock) : colorOf(p.layer, trip, this.l2);
      const g = el('g', { opacity: p.op.toFixed(3), class: `part part-${p.layer}` }, g0);
      rbox(g, { cx: centre.x, cy: centre.y, z, len: along, wid: d, h, angle: pose.angle, color });
      // Name printed on the long side facing the viewer, if there is room for it.
      const label = p.key === 'card' ? this.cardText(trip) : p.key === 'ip' ? 'IP' : p.key === 'l4' ? trip.l4Label : '';
      const font = p.key === 'card' ? cardFont(label) : 10;
      const onSide = label && p.f > 0.6 ? faceText(dir, v3(centre.x + side.x * (d / 2), centre.y + side.y * (d / 2), z + h / 2)) : null;
      if (label && onSide && along * U * onSide.ex > label.length * font * 0.62 + 4) {
        const t = el('text', { class: p.key === 'card' ? 'face-label card-label' : 'face-label', 'text-anchor': 'middle', 'font-size': font, dy: '0.35em', transform: onSide.tf }, g);
        t.textContent = label;
      }
      // "Ethernet" on the end cap whose end face looks at the viewer.
      const endCap = (p.key === 'ethH' && frontFaces) || (p.key === 'ethT' && backFaces);
      if (endCap && pose.sleeve > 0.5) {
        const out = p.key === 'ethH' ? dir : { x: -dir.x, y: -dir.y };
        const onEnd = faceText(across, v3(centre.x + out.x * (along / 2), centre.y + out.y * (along / 2), z + h / 2));
        if (onEnd) {
          const t = el('text', { class: 'face-label eth-label', 'text-anchor': 'middle', dy: '0.35em', transform: onEnd.tf }, g);
          t.textContent = this.l2 === 'wifi' ? 'Wi-Fi' : 'Ethernet';
        }
      }
    }

    // The Ethernet sleeve: a see-through wrap from the header cap to the trailer cap.
    const sleeve = parts.find((p) => p.key === 'ethH');
    const front = placed.find((x) => x.p.key === 'ethH');
    const back = placed.find((x) => x.p.key === 'ethT');
    if (sleeve && front && back && sleeve.op * pose.sleeve > 0.01) {
      const sec = SECTION.eth;
      const centre = at((back.u0 + front.u1) / 2 + sleeve.slide);
      const g = el('g', { opacity: (sleeve.op * pose.sleeve).toFixed(3), class: `sleeve ${this.l2}` }, g0);
      rbox(g, { cx: centre.x, cy: centre.y, z: pos.z - sec.h / 2 - 0.02 + sleeve.lift, len: front.u1 - back.u0, wid: sec.d + 0.04, h: sec.h + 0.04, angle: pose.angle, color: colorOf('eth', trip, this.l2) });
    }

    const ip = parts.find((p) => p.key === 'ip');
    if (ip && ip.op > 0.5 && ip.f > 0.5 && pose.tag) {
      this.addressTag(seg, k, v3(pos.x - dir.x * 0.6, pos.y - dir.y * 0.6, pos.z + 2.35), 1 - pose.chips * 2);
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
    const frame = frameAt(seg) ?? { l2: 'ethernet', head: trip.header.eth, tail: trip.trailer };
    const L = TILES_PER_BYTE;
    const list = [
      mk('ethH', 'eth', frame.head, frame.head * L),
      mk('ip', 'ip', trip.header.ip, trip.header.ip * L),
      mk('l4', 'l4', trip.header.l4, trip.header.l4 * L),
    ];
    if (trip.card) list.push(mk('card', 'app', trip.dataBytes, cardLen(trip)));
    list.push(mk('ethT', 'eth', frame.tail, Math.max(frame.tail * L, 0.12)));
    // The trailer cap follows the sleeve: the same slide and fall.
    const head = list[0]!;
    const tail = list[list.length - 1]!;
    Object.assign(tail, { f: head.f, lift: head.lift, slide: head.slide, op: head.op });
    return list;
  }

  private sizeChips(items: { p: Part; top: Vec3 }[], trip: Trip, op: number): void {
    const chips = items
      .map(({ p, top }) => {
        const name = p.key === 'card' ? this.cardText(trip) : p.key === 'ethT' ? '' : p.key === 'l4' ? trip.l4Label : layerName(p.layer, trip, this.l2);
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
      const color = c.p.key === 'card' && this.lock > 0.5 ? LOCKED : colorOf(c.p.layer, trip, this.l2);
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
    const back = !seg.trip.outward;
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

import { el } from './svg';
import { box, cylinder, line, rbox, tile } from './prims';
import { clamp01, easeIn, easeInOut, easeOut, easeOutBack, easeOutBounce, iso, lerp, U, v3, type Vec3 } from './project';
import { drawBolt, drawSatellite, drawScissors, drawShield, drawSpyglass } from './icons';
import { shade } from './shade';
import type { Details, PartKey, Row, Seen, Story, Trip, Wrap } from './story';
import { drawBook, drawShelf, SERVER } from './stations';
import { addressBefore, detailsAt, DEVICE_TOP, FACE_EMOJI, frameAt, LEVEL, lockPose, packetPos, packetPose, segAt, swapLanding, swapMoment, trayOpacity, wrapsBefore, type LockPose, type Seg, type Timeline } from './timeline';

export const COLOR = { app: '#4f9d69', tcp: '#8b6fd0', udp: '#b8609f', ip: '#4a84d4', vpn: '#2e5e6e', eth: '#e08b33', wifi: '#2a9d8f' } as const;
const DEVICE = '#d9d0c2';
/** A locked (encrypted) card: dark, under a padlock. */
const LOCKED = '#3d4654';

/** Mix two #rrggbb colours. */
function mix(a: string, b: string, t: number): string {
  const p = (h: string, i: number): number => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const c = [0, 1, 2].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t).toString(16).padStart(2, '0'));
  return `#${c.join('')}`;
}

const BURST = '#ffd84a';
/** A fresh address label as it lands, and once it has settled. */
const LABEL_FRESH = '#8fe3d0';
const LABEL_SETTLED = '#d8f5ee';
const WAIT = '#c2562f';
const sealedInside = (key: PartKey): boolean => key === 'ip' || key === 'l4' || key === 'card';
/** How far from a device its satellite dish stands. */
const DISH = 2.4;

/** The point a share t of the way along a path, and the path's direction there on the ground. */
function pointAlong(path: Vec3[], t: number): { p: Vec3; ux: number; uy: number } {
  const lens = path.slice(1).map((p, i) => Math.hypot(p.x - path[i]!.x, p.y - path[i]!.y, p.z - path[i]!.z));
  let d = t * lens.reduce((s, x) => s + x, 0);
  for (let i = 0; i < lens.length; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    if (d <= lens[i]! || i === lens.length - 1) {
      const q = lens[i] ? clamp01(d / lens[i]!) : 0;
      const ground = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { p: v3(lerp(a.x, b.x, q), lerp(a.y, b.y, q), lerp(a.z, b.z, q)), ux: (b.x - a.x) / ground, uy: (b.y - a.y) / ground };
    }
    d -= lens[i]!;
  }
  return { p: path[0] ?? v3(0, 0, 0), ux: 1, uy: 0 };
}
const NO_KEY: LockPose = { show: false, drop: 0, open: 0, op: 1, dark: 0, key: null };

/** Header bytes → tiles along the packet. The data card is not to scale (it would dwarf the headers). */
const TILES_PER_BYTE = 0.04;
type Layer = Wrap | 'app';
const SECTION: Record<Layer, { d: number; h: number }> = { app: { d: 1.0, h: 0.72 }, l4: { d: 1.18, h: 0.88 }, ip: { d: 1.34, h: 1.02 }, vpn: { d: 1.48, h: 1.1 }, eth: { d: 1.62, h: 1.18 } };

type L2 = 'ethernet' | 'wifi';
const colorOf = (layer: Layer, trip: Trip, l2: L2 = 'ethernet'): string =>
  layer === 'l4' ? COLOR[trip.l4] : layer === 'eth' && l2 === 'wifi' ? COLOR.wifi : COLOR[layer];
const layerName = (layer: Layer, trip: Trip, l2: L2 = 'ethernet'): string =>
  ({ app: 'App', l4: trip.l4 === 'udp' ? 'UDP' : 'TCP', ip: 'IP', vpn: 'VPN', eth: l2 === 'wifi' ? 'Wi-Fi' : 'Ethernet' })[layer];
const cardFont = (label: string): number => (label.length <= 7 ? 13 : label.length <= 14 ? 10.5 : 9);
const cardLen = (trip: Trip): number => {
  const label = trip.card ?? '';
  return Math.max(1.3 + 0.42 * Math.log2(Math.max(trip.dataBytes, 64) / 64), (label.length * cardFont(label) * 0.62 + 18) / U);
};

/** Text printed on a box face: `+y` faces run along +x on screen, `+x` faces along −y. */
const faceTf = (p: { sx: number; sy: number }, face: '+y' | '+x'): string =>
  `matrix(1 ${face === '+y' ? 0.5 : -0.5} 0 1 ${p.sx.toFixed(1)} ${p.sy.toFixed(1)})`;


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
  kind: string;
  g: SVGGElement;
  trays: SVGGElement;
  l4Name: SVGTextElement | null;
  /** The frame tray (Ethernet or Wi-Fi) and its name. */
  l2Tray: SVGPathElement | null;
  l2Name: SVGTextElement | null;
}

interface Screen {
  face: SVGGElement;
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
  /** What the spyglass reads, and the line it is on. */
  private readonly spyNote: SVGGElement;
  private spy: string | null = null;
  /** The session keys beside each end, and the one at work. */
  private readonly keys: SVGGElement;
  /** What the laptop and the phone show on their screens. */
  private readonly screens = new Map<string, Screen>();
  /** The paths of the links that crackle in stormy weather. */
  private stormy: { id: string; path: Vec3[] }[] = [];
  private readonly storm: SVGGElement;
  /** Where a page that comes in several parts is put back together, beside the laptop. */
  private readonly rack: SVGGElement;
  private overview = { x: 0, y: 0, w: 1, h: 1 };
  private onTable: { sx: number; sy: number }[] = [];
  private remembered: ReadonlyMap<string, { site: string; ip: string }> = new Map();
  /** The kind of frame around the packet being drawn. */
  private l2: L2 = 'ethernet';
  /** How locked the card being drawn is (0 open, 1 locked): HTTPS cards lock at the sender and open at the receiver. */
  private lock = 0;

  /** The pill opened on the packet this frame, and how far. */
  private pill: { key: PartKey; k: number } | null = null;
  /** Where the keyhole of the padlock on the packet is on screen this frame. */
  private keyhole: { sx: number; sy: number } | null = null;

  /** What the card says: nothing readable while locked, only which part it is. */
  private cardText(trip: Trip): string {
    return this.lock > 0.5 ? (trip.card?.match(/\d+\/\d+$/)?.[0] ?? '') : (trip.card ?? '');
  }
  private readonly cables: SVGGElement;
  private cut = new Set<string>();
  /** The line a tool would work on, highlighted. */
  private readonly hover: SVGGElement;
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
    this.hover = el('g', { class: 'hover' }, world);
    this.storm = el('g', { class: 'storm' }, world);
    const devs = el('g', {}, world);
    this.rack = el('g', { class: 'rack' }, world);
    // Effects (impact bursts, timers) sit behind the packet, the way an anime impact star does.
    this.fx = el('g', { class: 'fx' }, world);
    this.packet = el('g', { class: 'packet' }, world);
    this.tags = el('g', { class: 'tags' }, world);
    this.keys = el('g', { class: 'keys' }, world);
    this.moods = el('g', { class: 'moods' }, world);
    this.spyNote = el('g', { class: 'spy' }, world);

    // Draw far devices first: a larger x + y is nearer the viewer.
    const order = [...story.devices].sort((m, n) => this.depthOf(m.id) - this.depthOf(n.id));
    for (const d of order) {
      const p = tl.pos.get(d.id) ?? { x: 0, y: 0 };
      const trays = el('g', { class: 'trays', opacity: 0 }, devs);
      const g = el('g', { class: 'device' }, devs);
      const screen = this.buildDevice(g, d.kind, p.x, p.y);
      if (screen) {
        this.screens.set(d.id, screen);
        screen.face.setAttribute('data-device', d.id);
      }
      const { l4Name, l2Tray, l2Name } = this.buildTrays(trays, d.id, p.x, p.y);
      const s = iso(p.x, p.y + 1.9, 0);
      const name = el('text', { class: 'device-name', 'text-anchor': 'middle', x: s.sx.toFixed(1), y: (s.sy + 26).toFixed(1) }, g);
      name.textContent = d.label;
      this.devices.push({ id: d.id, kind: d.kind, g, trays, l4Name, l2Tray, l2Name });
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

  /**
   * The way a link really runs through the world: a straight cable, an arc through the air for Wi-Fi, or for a
   * satellite hop a short cable to a dish at each end with the radio beams up to the satellite between them.
   */
  private linkWorld(id: string): Vec3[] {
    const l = this.story.links.find((x) => x.id === id);
    const a = l && this.tl.pos.get(l.a);
    const b = l && this.tl.pos.get(l.b);
    if (!l || !a || !b) return [];
    if (this.tl.air.has(id)) {
      const za = (DEVICE_TOP[this.tl.kind.get(l.a) ?? ''] ?? 1) + 0.2;
      const zb = (DEVICE_TOP[this.tl.kind.get(l.b) ?? ''] ?? 1) + 0.9;
      return Array.from({ length: 21 }, (_, i) => {
        const q = i / 20;
        return v3(lerp(a.x, b.x, q), lerp(a.y, b.y, q), lerp(za, zb, q) + Math.sin(Math.PI * q) * 1.4);
      });
    }
    const sky = this.tl.sky.get(id);
    if (!sky) return [v3(a.x, a.y, 0), v3(b.x, b.y, 0)];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const dish = (p: { x: number; y: number }, s: number): Vec3 => v3(p.x + ux * DISH * s, p.y + uy * DISH * s, 0.3);
    return [v3(a.x, a.y, 0), dish(a, 1), v3((a.x + b.x) / 2, (a.y + b.y) / 2, sky), dish(b, -1), v3(b.x, b.y, 0)];
  }

  /** A link's path on screen, in SVG units. */
  linkPath(id: string): { sx: number; sy: number }[] {
    return this.linkWorld(id).map((p) => iso(p.x, p.y, p.z));
  }

  /** A spot a share t along a link, `lift` px above it; a satellite hop keeps to its first beam. */
  linkSpot(id: string, t: number, lift: number): { sx: number; sy: number } {
    const { p } = pointAlong(this.linkWorld(id), this.tl.sky.has(id) ? t * 0.56 : t);
    const s = iso(p.x, p.y, p.z);
    return { sx: s.sx, sy: s.sy - lift };
  }

  /** The line the spyglass is on, if any. */
  setSpy(line: string | null): void {
    this.spy = line;
  }

  /** What the spyglass reads: a note with the last thing that passed along its line, staying for a moment. */
  private renderSpy(v: number): void {
    this.spyNote.replaceChildren();
    const line = this.spy;
    if (!line) return;
    const glass = this.linkSpot(line, 0.66, 30);
    drawSpyglass(el('g', { transform: `translate(${glass.sx.toFixed(1)} ${glass.sy.toFixed(1)})` }, this.spyNote));
    if (v < 0) return;
    let last: { seen: Seen; t0: number; t1: number } | null = null;
    for (const s of this.tl.segs) {
      const st = s.step;
      if ((st.kind === 'travel' || st.kind === 'lost') && st.link === line && st.seen && s.t0 <= v) last = { seen: st.seen, t0: s.t0, t1: s.t1 };
    }
    if (!last || v > last.t1 + 1.4) return;
    const dt = v - (last.t0 + (last.t1 - last.t0) * 0.25);
    if (dt < 0) return;
    const { seen } = last;
    const c = this.linkSpot(line, 0.66, 132);
    const op = 1 - clamp01((v - last.t1 - 1) / 0.4);
    const addr = `${seen.from} → ${seen.to}`;
    const w = Math.max(...[addr, ...seen.lines].map((l) => l.length * 7)) + 24;
    const h = 28 + seen.lines.length * 18;
    const g = el('g', { class: `spy-note spy-${seen.kind}`, opacity: op.toFixed(3), transform: `translate(${c.sx.toFixed(1)} ${c.sy.toFixed(1)}) scale(${easeOutBack(clamp01(dt / 0.25)).toFixed(3)})` }, this.spyNote);
    el('rect', { x: -w / 2, y: -h, width: w, height: h, rx: 7, class: 'spy-paper' }, g);
    const t = el('text', { x: 0, y: -h + 18, 'text-anchor': 'middle', class: 'spy-addr' }, g);
    t.textContent = addr;
    seen.lines.forEach((l, i) => {
      const line2 = el('text', { x: 0, y: -h + 38 + i * 18, 'text-anchor': 'middle', class: i === 0 ? 'spy-text' : 'spy-text spy-more' }, g);
      line2.textContent = l;
    });
  }

  /** Cables between devices; a slow link is a radio hop up to a satellite instead. */
  private buildCables(): void {
    this.cables.replaceChildren();
    this.cableViews = [];
    for (const l of this.story.links) {
      const path = this.linkWorld(l.id);
      if (!path.length) continue;
      const g = el('g', { class: 'link' }, this.cables);
      if (this.tl.air.has(l.id)) {
        const pts = path.map((p) => iso(p.x, p.y, p.z));
        el('polyline', { points: pts.map((p) => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(' '), class: 'airwave' }, g);
        // Radio ripples at both ends.
        for (const p of [path[0]!, path[path.length - 1]!]) {
          const c = iso(p.x, p.y, p.z + 0.3);
          for (const r of [7, 12, 17]) el('path', { d: `M${(c.sx - r).toFixed(1)} ${(c.sy - r * 0.2).toFixed(1)}A${r} ${r} 0 0 1 ${(c.sx + r).toFixed(1)} ${(c.sy - r * 0.2).toFixed(1)}`, class: 'ripple' }, g);
        }
      } else if (path.length === 5) {
        // A cable from each device to its dish, then the radio beams up to the satellite.
        const [a, footA, top, footB, b] = path as [Vec3, Vec3, Vec3, Vec3, Vec3];
        for (const [end, foot] of [[a, footA], [b, footB]] as const) {
          line(g, end, v3(foot.x, foot.y, 0), { class: 'cable' });
          line(g, foot, top, { class: 'beam' });
          cylinder(g, { x: foot.x, y: foot.y, z: 0, r: 0.35, h: 0.3, color: DEVICE });
        }
        const sat = iso(top.x, top.y, top.z);
        drawSatellite(el('g', { transform: `translate(${sat.sx.toFixed(1)} ${sat.sy.toFixed(1)})` }, g));
      } else if (this.cut.has(l.id)) {
        // Two loose ends with a gap between them.
        const [a, b] = path as [Vec3, Vec3];
        const mid = (s: number): Vec3 => v3(lerp(a.x, b.x, 0.5 + s), lerp(a.y, b.y, 0.5 + s), 0);
        line(g, a, mid(-0.07), { class: 'cable' });
        line(g, mid(0.07), b, { class: 'cable' });
        for (const s of [-0.07, 0.07]) {
          const c = iso(mid(s).x, mid(s).y, 0);
          for (const [dx, dy] of [[6, -7], [9, 1], [4, 8]] as const) {
            const k = Math.sign(s);
            el('line', { x1: c.sx, y1: c.sy, x2: c.sx - k * dx, y2: c.sy + dy, class: 'fray' }, g);
          }
        }
        const c = iso(mid(0).x, mid(0).y, 0);
        drawScissors(el('g', { transform: `translate(${c.sx.toFixed(1)} ${(c.sy - 8).toFixed(1)}) scale(0.5)` }, g));
      } else {
        line(g, path[0]!, path[1]!, { class: 'cable' });
      }
      this.cableViews.push({ g, a: l.a, b: l.b });
    }
    if (this.story.vpn) this.buildTunnel();
  }

  /** A tube along the whole way from the device to the VPN server: inside it, nobody sees what is going on. */
  private buildTunnel(): void {
    const first = this.story.links.find((l) => l.a === this.tl.client);
    if (!first) return;
    const pts = [first.id, 'wan', 'bb3'].flatMap((id) => this.linkPath(id));
    const points = pts.map((p) => `${p.sx.toFixed(1)},${(p.sy - 10).toFixed(1)}`).join(' ');
    const g = el('g', { class: 'tunnel' }, this.cables);
    el('polyline', { points, class: 'tunnel-tube' }, g);
    el('polyline', { points, class: 'tunnel-flow' }, g);
    const c = this.linkSpot('wan', 0.5, -34);
    const name = el('text', { x: c.sx, y: c.sy, 'text-anchor': 'middle', class: 'tunnel-name' }, g);
    name.textContent = 'VPN tunnel';
  }

  private linkShown(device: string): boolean {
    return this.tl.kind.get(device) !== 'vpn-server' || this.story.vpn;
  }

  /** Is this link really on the table right now? */
  hasLink(id: string): boolean {
    const l = this.story.links.find((x) => x.id === id);
    return !!l && this.linkShown(l.a) && this.linkShown(l.b);
  }

  /** Which cables are cut. */
  setCut(lines: readonly string[]): void {
    this.cut = new Set(lines);
    this.buildCables();
  }

  /** Highlight the line a tool would work on. */
  setHover(id: string | null): void {
    this.hover.replaceChildren();
    if (!id) return;
    el('polyline', { points: this.linkPath(id).map((p) => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(' '), class: 'line-hover' }, this.hover);
  }

  /** Which links crackle, by id; empty for calm weather. */
  setStorm(links: readonly string[]): void {
    this.stormy = links.map((id) => ({ id, path: this.linkWorld(id) })).filter((l) => l.path.length > 1);
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
    this.stormy.forEach(({ id, path }, li) => {
      const length = path.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - path[i]!.x, p.y - path[i]!.y, p.z - path[i]!.z), 0);
      const steps = Math.max(4, Math.round(length / 0.45));
      const pts: string[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        // Ends stay on the ports; the middle jumps around.
        const amp = Math.sin(Math.PI * t) * 0.34;
        const off = (rnd(li * 100 + i) - 0.5) * 2 * amp;
        const z = (rnd(li * 100 + i + 50) - 0.3) * amp * 1.2;
        const { p, ux, uy } = pointAlong(path, t);
        const s = iso(p.x - uy * off, p.y + ux * off, Math.max(0, p.z + z));
        pts.push(`${s.sx.toFixed(1)},${s.sy.toFixed(1)}`);
      }
      const flicker = (0.55 + 0.45 * rnd(li + 7)).toFixed(2);
      // A dark edge under the yellow keeps it readable on the light table.
      el('polyline', { points: pts.join(' '), class: 'crackle-edge', opacity: flicker }, this.storm);
      el('polyline', { points: pts.join(' '), class: 'crackle', opacity: flicker }, this.storm);
      // Now and then a spark jumps off the line.
      if (rnd(li + 31) > 0.72) {
        const { p: at } = pointAlong(path, 0.15 + 0.7 * rnd(li + 3));
        const p = iso(at.x, at.y, at.z + 0.3);
        const r = 5 + 6 * rnd(li + 9);
        const spikes = [0, 1, 2, 3, 4, 5, 6, 7].map((j) => {
          const ang = (j / 8) * Math.PI * 2;
          const rr = j % 2 ? r * 0.4 : r;
          return `${(p.sx + Math.cos(ang) * rr).toFixed(1)},${(p.sy + Math.sin(ang) * rr).toFixed(1)}`;
        });
        el('polygon', { points: spikes.join(' '), class: 'spark' }, this.storm);
      }
      // A chunky bolt stands over every stormy line, trembling.
      const c = this.linkSpot(id, 0.5, 52);
      const jump = (rnd(li + 91) - 0.5) * 5;
      drawBolt(el('g', { class: 'storm-bolt', transform: `translate(${(c.sx + jump).toFixed(1)} ${c.sy.toFixed(1)}) scale(${(0.92 + 0.12 * rnd(li + 77)).toFixed(3)})` }, this.storm));
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

  /** Everything else lying on the table, which the whole-network view must keep in frame. */
  setOnTable(points: { sx: number; sy: number }[]): void {
    this.onTable = points;
    this.fit();
  }

  /** The remembered address on each device's screen (only the one running shows anything else). */
  setRemembered(known: ReadonlyMap<string, { site: string; ip: string }>): void {
    this.remembered = known;
  }

  private fit(): void {
    const pts: { sx: number; sy: number }[] = [];
    for (const p of this.tl.pos.values()) for (const [dx, dy] of [[-2, -2], [2, 2.4], [-2, 2.4], [2, -2]] as const) for (const z of [0, 3.2]) pts.push(iso(p.x + dx, p.y + dy, z));
    pts.push(...this.onTable);
    const minX = Math.min(...pts.map((p) => p.sx)) - 20;
    const maxX = Math.max(...pts.map((p) => p.sx)) + 20;
    const minY = Math.min(...pts.map((p) => p.sy)) - 10;
    // Room for the device names, and for the bar over the bottom of the view.
    const maxY = Math.max(...pts.map((p) => p.sy)) + 90;
    this.overview = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  /** Screen pixels per SVG unit that fit the whole network. */
  private baseScale(): number {
    const o = this.overview;
    return Math.min((this.svg.clientWidth || 1) / o.w, (this.svg.clientHeight || 1) / o.h);
  }

  /** Following shows about 560–1100 units across, so the packet stays big on a phone too. */
  private followScale(): number {
    const cw = this.svg.clientWidth || 1;
    return Math.max(this.baseScale() * 1.15, cw / Math.min(1100, Math.max(560, cw * 0.8)));
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
      return { cx: -20, cy: 60, scale: Math.max(this.baseScale(), cw / 560) };
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
    } else if (hit?.seg.step.kind === 'wait' || hit?.seg.step.kind === 'lookup') {
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

  /** The point `x`, `y` screen pixels from the top left of the view, in SVG units. */
  viewPoint(c: Camera, x: number, y: number): { sx: number; sy: number } {
    return { sx: c.cx + (x - (this.svg.clientWidth || 1) / 2) / c.scale, sy: c.cy + (y - (this.svg.clientHeight || 1) / 2) / c.scale };
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
    const face = el('g', { class: 'dev-screen', transform: faceTf(a, '+y') }, g);
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
    return { face, page, title, dns, dnsName: name, dnsAddr, fail };
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
      case 'vpn-server': {
        box(g, { x: x - 1.0, y: y - 0.8, z: 0, w: 2.0, d: 1.6, h: 1.3, ...neutral });
        for (let i = 0; i < 3; i++) line(g, v3(x - 0.7, y + 0.8, 1.0 - i * 0.3), v3(x + 0.7, y + 0.8, 1.0 - i * 0.3), { class: 'slot' });
        const top = iso(x, y, 2.2);
        drawShield(el('g', { transform: `translate(${top.sx.toFixed(1)} ${top.sy.toFixed(1)})` }, g));
        return null;
      }
      case 'dns-resolver': {
        // A squat cabinet with a fat address book on top.
        box(g, { x: x - 1.0, y: y - 0.8, z: 0, w: 2.0, d: 1.6, h: 0.75, ...neutral });
        box(g, { x: x - 0.7, y: y - 0.55, z: 0.75, w: 1.4, d: 1.1, h: 0.35, color: '#c9b79c', cls: 'dev-body' });
        return null;
      }
      default: {
        box(g, { x: x - SERVER.half, y: y - SERVER.half, z: 0, w: SERVER.half * 2, d: SERVER.half * 2, h: SERVER.height, ...neutral });
        for (const z of SERVER.slots) line(g, v3(x - SERVER.slotHalf, y + SERVER.half, z), v3(x + SERVER.slotHalf, y + SERVER.half, z), { class: 'slot' });
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
    for (const d of this.devices) {
      // Without a VPN its server is not on the table.
      const absent = d.kind === 'vpn-server' && !this.story.vpn;
      d.g.classList.toggle('absent', absent);
      d.g.classList.toggle('unused', !absent && greying && !this.used.has(d.id));
    }
    for (const c of this.cableViews) {
      const absent = !this.linkShown(c.a) || !this.linkShown(c.b);
      c.g.classList.toggle('absent', absent);
      c.g.classList.toggle('unused', greying && (!this.used.has(c.a) || !this.used.has(c.b)));
    }
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
    this.renderSpy(v);
    for (const [id, screen] of this.screens) {
      if (id === tl.client && v >= 0) continue;
      this.blank(screen);
      const known = this.remembered.get(id);
      screen.face.classList.toggle('remembers', !!known);
      if (!known) continue;
      screen.dnsName.textContent = known.site;
      screen.dnsAddr.textContent = known.ip;
      screen.dns.setAttribute('opacity', '1');
    }
    const screen = this.screens.get(tl.client);
    if (!screen || v < 0) return;
    screen.face.classList.toggle('remembers', this.remembered.has(tl.client));
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
    return !!kind && kind !== 'lost' && kind !== 'wait' && kind !== 'lookup';
  }

  /** The packet at visual time v. `peek` (0..1) pulls its pieces apart and shows their sizes; `pill` is the one opened. */
  drawPacket(v: number, peek: number, pill: { key: PartKey; k: number } | null = null): void {
    this.pill = pill;
    this.packet.replaceChildren();
    this.tags.replaceChildren();
    this.fx.replaceChildren();
    this.keys.replaceChildren();
    // The spy's note makes way for the size chips.
    this.spyNote.style.display = peek > 0.05 ? 'none' : '';
    this.keyhole = null;
    const hit = segAt(this.tl, v);
    if (!hit) return;
    const { seg, k } = hit;
    const step = seg.step;
    if (step.kind === 'wait') {
      this.drawWait(seg, k);
      this.drawKeys(v, seg, NO_KEY);
      return;
    }
    if (step.kind === 'lookup') {
      const d = this.tl.pos.get(step.device) ?? { x: 0, y: 0 };
      const draw = step.what === 'dns' ? drawBook : drawShelf;
      draw(this.fx, v3(d.x, d.y, DEVICE_TOP[this.tl.kind.get(step.device) ?? ''] ?? 1), seg.p1, step, k);
      this.drawKeys(v, seg, NO_KEY);
      return;
    }
    const trip = seg.trip;
    this.l2 = frameAt(seg)?.l2 ?? 'ethernet';
    const lock = lockPose(seg, k);
    this.lock = lock.dark;
    const parts = this.parts(seg, k);
    const at = packetPose(this.tl, seg, k);
    const pose: Pose = { pos: at.pos, angle: at.angle, gap: peek * 0.7, spin: 0, squash: 0, op: 1, sleeve: 1 - peek, tag: peek < 0.5, chips: peek };

    // Knocked off the cable: impact, tumble, bounce, fall apart.
    if (step.kind === 'lost' && seg.knock) {
      const tau = k * (seg.t1 - seg.t0) - seg.knock.k * seg.knock.travel;
      if (tau >= 0) {
        if (!seg.knock.cut || seg.knock.byYou) this.burst(pose.pos, tau, !seg.knock.byYou);
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
    this.drawPose(seg, k, trip, parts, pose, wiggle, lock);
    this.drawKeys(v, seg, lock);
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

  private drawPose(seg: Seg, k: number, trip: Trip, parts: Part[], pose: Pose, wiggle: number, lock: LockPose): void {
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
    // The VPN box closes over the whole packet: address, transport and card all go inside.
    const boxFront = placed.find((x) => x.p.key === 'vpn');
    const boxBack = boxFront && [...placed].reverse().find((x) => sealedInside(x.p.key));
    const boxShut = !!boxFront && boxFront.p.f > 0.95 && Math.abs(boxFront.p.lift) < 0.05;
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

    // What goes in the box is drawn first, so that the box comes down over it.
    const boxDepth = boxFront && boxBack ? mid({ u0: boxBack.u0, u1: boxFront.u1 }) : 0;
    const depth = (x: { p: Part; u0: number; u1: number }): number =>
      x.p.key === 'vpn' && boxBack ? boxDepth : boxFront && sealedInside(x.p.key) ? boxDepth - 0.01 : mid(x);
    for (const { p, u0: start, u1 } of [...placed].sort((m, n) => depth(m) - depth(n))) {
      if (boxShut && sealedInside(p.key)) continue;
      const isBox = p.key === 'vpn' && !!boxBack;
      const u0 = isBox ? boxBack.u0 : start;
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
      if (isBox) {
        const top = iso(centre.x, centre.y, z + h);
        drawShield(el('g', { transform: `translate(${top.sx.toFixed(1)} ${(top.sy - 8).toFixed(1)}) scale(0.62)` }, g));
      }
      const label = p.key === 'card' ? this.cardText(trip) : p.key === 'ip' ? 'IP' : p.key === 'l4' ? trip.l4Label : p.key === 'vpn' ? 'VPN' : '';
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

    const card = placed.find((x) => x.p.key === 'card');
    if (lock.show && card && !boxShut) {
      const c = at((card.u0 + card.u1) / 2 + card.p.slide);
      const h = SECTION.app.h * card.p.scale;
      this.padlock(g0, iso(c.x, c.y, pos.z + h / 2 + card.p.lift + wiggle), lock);
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
      this.sizeChips(items, trip, pose.chips, detailsAt(seg, k));
    }
  }

  /** A padlock standing on the card. `base` is the middle of the card's top. */
  private padlock(parent: SVGGElement, base: { sx: number; sy: number }, l: LockPose): void {
    const y = base.sy - 2 - l.drop * 110;
    const g = el('g', { class: 'padlock', opacity: l.op.toFixed(3), transform: `translate(${base.sx.toFixed(1)} ${y.toFixed(1)})` }, parent);
    // The shackle lifts and swings out on its left leg when open.
    const shackle = `translate(0 ${(-11 * l.open).toFixed(1)}) rotate(${(26 * l.open).toFixed(1)} -9 -24)`;
    el('path', { d: 'M-9 -22 V-33 A9 9 0 0 1 9 -33 V-22', class: 'padlock-shackle', transform: shackle }, g);
    el('rect', { x: -15, y: -24, width: 30, height: 24, rx: 5, class: 'padlock-body' }, g);
    el('circle', { cx: 0, cy: -14, r: 3.4, class: 'padlock-hole' }, g);
    el('rect', { x: -1.4, y: -14, width: 2.8, height: 7, class: 'padlock-hole' }, g);
    this.keyhole = { sx: base.sx, sy: y - 14 };
  }

  /** The session key resting beside a device. */
  private keyRest(device: string): { sx: number; sy: number } {
    const d = this.tl.pos.get(device) ?? { x: 0, y: 0 };
    return iso(d.x + 1.7, d.y - 1.3, (DEVICE_TOP[this.tl.kind.get(device) ?? ''] ?? 1) + 0.5);
  }

  /** One key: the same shape at both ends, because both ends worked out the same secret. Tip at the origin. */
  private keyShape(c: { sx: number; sy: number }, scale: number, turn: number): SVGGElement {
    const squeeze = Math.max(0.12, Math.cos((turn * Math.PI) / 2));
    const g = el('g', { class: 'key', transform: `translate(${c.sx.toFixed(1)} ${c.sy.toFixed(1)}) scale(${scale.toFixed(3)} ${(scale * squeeze).toFixed(3)})` }, this.keys);
    el('path', { d: 'M0 -2.2 H30 V2.2 H16 V8 H12 V2.2 H8 V6 H4 V2.2 H0 Z', class: 'key-metal' }, g);
    el('circle', { cx: 38, cy: 0, r: 10, class: 'key-metal' }, g);
    el('circle', { cx: 40, cy: 0, r: 3.5, class: 'key-hole' }, g);
    return g;
  }

  /** Each end's key from the moment it has worked it out, popping up with a sparkle; the one at work flies to the lock. */
  private drawKeys(v: number, seg: Seg, lock: LockPose): void {
    const working = lock.key && 'device' in seg.step ? seg.step.device : null;
    for (const [device, t] of this.tl.keys) {
      const dt = v - t;
      if (dt < 0) continue;
      const rest = this.keyRest(device);
      if (device === working && lock.key) {
        const hole = this.keyhole ?? rest;
        this.keyShape({ sx: lerp(rest.sx, hole.sx, lock.key.to), sy: lerp(rest.sy, hole.sy, lock.key.to) }, 1, lock.key.turn);
        continue;
      }
      const g = this.keyShape(rest, easeOutBack(clamp01(dt / 0.35)), 0);
      if (dt < 0.7) {
        const r = 20 + 34 * easeOut(dt / 0.7);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          el('line', { x1: 20 + Math.cos(a) * r * 0.7, y1: Math.sin(a) * r * 0.7, x2: 20 + Math.cos(a) * r, y2: Math.sin(a) * r, class: 'key-spark', opacity: (1 - dt / 0.7).toFixed(2) }, g);
        }
      }
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
      ...(trip.tunnel ? [mk('vpn', 'vpn', trip.tunnel, trip.tunnel * L)] : []),
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

  private sizeChips(items: { p: Part; top: Vec3 }[], trip: Trip, op: number, details: Details): void {
    const chips = items
      .map(({ p, top }) => {
        const hidden = sealedInside(p.key) && !!items.find((x) => x.p.key === 'vpn');
        const rows = hidden ? [{ name: '🔒', value: 'sealed' }] : (details[p.key] ?? []);
        const name = hidden ? '🔒' : p.key === 'card' ? (this.lock > 0.5 ? `🔒 ${this.cardText(trip)}`.trim() : this.cardText(trip)) : p.key === 'ethT' ? '' : p.key === 'l4' ? trip.l4Label : layerName(p.layer, trip, this.l2);
        const text = `${name ? `${name} · ${p.bytes} B` : `${p.bytes} B`}${rows.length ? ' ▴' : ''}`;
        const c = p.key === 'card' && this.lock > 0.5 ? LOCKED : colorOf(p.layer, trip, this.l2);
        return { p, a: iso(top.x, top.y, top.z), text, rows, c, w: text.length * 6.6 + 14, x: 0 };
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
      const color = c.c;
      const g = el('g', { class: 'size-tag', opacity: op.toFixed(3), ...(c.rows.length ? { 'data-chip': c.p.key } : {}) }, this.tags);
      el('path', { d: `M${c.a.sx.toFixed(1)} ${c.a.sy.toFixed(1)}L${c.x.toFixed(1)} ${y.toFixed(1)}`, stroke: color, fill: 'none' }, g);
      el('rect', { x: c.x - c.w / 2, y: y - 18, width: c.w, height: 18, rx: 9, fill: color }, g);
      const t = el('text', { x: c.x.toFixed(1), y: (y - 9).toFixed(1), dy: '0.35em', 'text-anchor': 'middle' }, g);
      t.textContent = c.text;
    }
    const open = this.pill && chips.find((c) => c.p.key === this.pill!.key && c.rows.length);
    if (open) this.pillPanel(open.x, y - 18, open.w, open.p.key, open.c, open.rows, this.pill!.k);
  }

  /** A pill's fields, growing upwards out of the pill. */
  private pillPanel(x: number, bottom: number, pillW: number, key: PartKey, color: string, rows: Row[], k: number): void {
    const ROW = 19;
    const h = rows.length * ROW + 12;
    const w = Math.max(pillW, ...rows.map((r) => r.name.length * 6.1 + r.value.length * 6.7 + 34));
    const g = el('g', { class: 'pill-panel', 'data-chip': key, opacity: clamp01(k * 2).toFixed(3), transform: `translate(${x.toFixed(1)} ${(bottom - 3).toFixed(1)}) scale(1 ${easeOutBack(k).toFixed(3)})` }, this.tags);
    el('rect', { x: -w / 2, y: -h, width: w, height: h, rx: 10, stroke: color }, g);
    rows.forEach((r, i) => {
      const y = -h + 6 + (i + 0.5) * ROW;
      const name = el('text', { x: -w / 2 + 11, y, dy: '0.35em', class: 'pill-name' }, g);
      name.textContent = r.name;
      const value = el('text', { x: w / 2 - 11, y, dy: '0.35em', 'text-anchor': 'end', class: 'pill-value' }, g);
      value.textContent = r.value;
    });
  }

  /** "from → to" on the IP piece. When an address changes it is the big moment of the step, see `swapMoment`. */
  private addressTag(seg: Seg, k: number, p: Vec3, op: number): void {
    const a = addressBefore(seg);
    const old = { ...a };
    let changed: 'from' | 'to' | 'both' | null = null;
    const step = seg.step;
    const m = swapMoment(k, swapLanding(step) ?? 0);
    if (step.kind === 'nat') {
      changed = step.which;
      if (m.flip >= 0.5) a[step.which] = step.after;
    } else if ((step.kind === 'wrap' || step.kind === 'unwrap') && step.addr) {
      // Going into the VPN box the packet gets a whole new address label; coming out it has its old one again.
      changed = 'both';
      if (m.flip >= 0.5) Object.assign(a, step.addr);
    }
    const s = iso(p.x, p.y, p.z);
    const pop = changed ? 1 + 0.75 * m.grow : 1;
    // The arrow says which way we're going: out from the asker, or back to it.
    const back = !seg.trip.outward;
    const g = el('g', { class: `addr ${back ? 'addr-back' : 'addr-out'}`, opacity: op.toFixed(3), transform: `translate(${s.sx.toFixed(1)} ${s.sy.toFixed(1)}) scale(${pop.toFixed(3)})` }, this.tags);
    const flash = el('g', {}, g);
    // With a VPN the numbers alone don't say much: name who they belong to.
    const caption = (word: string, ip: string): string => (this.story.vpn && this.story.names[ip] ? `${word} ${this.story.names[ip]}` : word);
    const fromCap = caption('from', a.from);
    const toCap = caption('to', a.to);
    const fromW = Math.max(a.from.length * 7.2, fromCap.length * 6.6);
    const toW = Math.max(a.to.length * 7.2, toCap.length * 6.6);
    const width = fromW + toW + 44;
    // Small "from" / "to" captions sit above the addresses; the numbers sit on the lower line.
    const NUM_Y = 7;
    const swapping = changed && m.grow > 0.01;
    el('rect', { x: -width / 2, y: -19, width, height: 38, rx: 7, class: swapping ? 'addr-bg addr-swap' : 'addr-bg' }, g);
    const part = (word: 'from' | 'to', cap: string, x: number, w: number, hot: boolean): void => {
      const cx = x + w / 2;
      const capText = el('text', { x: cx.toFixed(1), y: -8, 'text-anchor': 'middle', dy: '0.35em', class: hot ? 'addr-cap hot' : 'addr-cap' }, g);
      capText.textContent = cap;
      const yScale = hot ? Math.max(0.04, Math.abs(1 - 2 * m.flip)) : 1;
      const land = hot && m.flip >= 0.5 ? 1 + 0.6 * (1 - easeOutBack(clamp01(m.stamp / 0.5))) : 1;
      const pg = el('g', { transform: `translate(${cx.toFixed(1)} ${NUM_Y}) scale(${land.toFixed(3)} ${(yScale * land).toFixed(3)})` }, g);
      if (hot) el('rect', { x: -w / 2 - 4, y: -9, width: w + 8, height: 18, rx: 4, fill: mix(LABEL_FRESH, LABEL_SETTLED, m.stamp) }, pg);
      const t = el('text', { 'text-anchor': 'middle', dy: '0.35em', class: hot ? 'addr-text hot' : 'addr-text' }, pg);
      t.textContent = a[word];
      // The old label slips out from under the tag and drifts away, so the new one stays easy to read.
      if (hot && m.flip >= 0.5 && m.stamp < 1 && old[word] !== a[word]) {
        const gone = el('g', { class: 'addr-old', opacity: (1 - easeIn(m.stamp)).toFixed(3), transform: `translate(${(cx + 16 * m.stamp).toFixed(1)} ${(NUM_Y + 44 * easeOut(m.stamp)).toFixed(1)}) rotate(${(10 * m.stamp).toFixed(1)})` }, flash);
        el('rect', { x: -w / 2 - 4, y: -9, width: w + 8, height: 18, rx: 4 }, gone);
        el('text', { 'text-anchor': 'middle', dy: '0.35em', class: 'addr-text' }, gone).textContent = old[word];
      }
    };
    part('from', fromCap, -width / 2 + 10, fromW, changed === 'from' || changed === 'both');
    const arrow = el('text', { x: -width / 2 + 22 + fromW, y: NUM_Y, 'text-anchor': 'middle', dy: '0.35em', class: 'addr-arrow' }, g);
    arrow.textContent = '→';
    part('to', toCap, -width / 2 + 34 + fromW, toW, changed === 'to' || changed === 'both');
    // A soft ring and a few sparkles around the fresh label, or around the whole tag when both change.
    if (changed && m.stamp > 0 && m.stamp < 1) {
      const x = changed === 'both' ? 0 : changed === 'from' ? -width / 2 + 10 + fromW / 2 : width / 2 - 10 - toW / 2;
      this.freshLabel(g, x, changed === 'both' ? 0 : NUM_Y, changed === 'both' ? width : changed === 'from' ? fromW : toW, m.stamp);
    }
  }

  /** The fresh label settling: a ring spreading out from it and a few sparkles. Routine work, not an accident. */
  private freshLabel(parent: SVGGElement, x: number, y: number, w: number, q: number): void {
    const g = el('g', { opacity: (1 - easeIn(q)).toFixed(3), transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` }, parent);
    const out = 14 * easeOut(q);
    el('rect', { x: -w / 2 - 6 - out, y: -13 - out, width: w + 12 + out * 2, height: 26 + out * 2, rx: 8 + out, class: 'swap-ring' }, g);
    const size = 7 * Math.sin(Math.min(1, q * 1.4) * Math.PI);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.5;
      const sx = Math.cos(a) * (w / 2 + 16 + 14 * q);
      const sy = Math.sin(a) * (26 + 16 * q);
      el('path', { d: `M0 ${-size} Q0 0 ${size} 0 Q0 0 0 ${size} Q0 0 ${-size} 0 Q0 0 0 ${-size}Z`, class: 'swap-spark', transform: `translate(${sx.toFixed(1)} ${sy.toFixed(1)})` }, g);
    }
  }
}

function formatWait(s: number): string {
  if (s >= 1) return `${Number(s.toFixed(1))} s`;
  return `${Math.round(s * 1000)} ms`;
}

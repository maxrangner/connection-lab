import type { Action } from '../sim';
import { el, setAttr, setText } from './svg';
import { box, groundShadow, line, panel, rbox, slab, tile, tiles } from './prims';
import { clamp01, easeIn, easeInOut, easeOut, easeOutBack, easeOutBounce, iso, isoV, lerp, lerpV, U, unproject, v3, type Pt, type Vec3 } from './project';
import { drawSatellite, drawScissors, drawShield, drawSpyglass } from './icons';
import { shade } from './shade';
import type { Details, PartKey, Row, Story, Trip, Wrap } from './story';
import { bandPoint, pageContent, Paper, PAPER_H, PAPER_W, photoContent } from './paper';
import { screenAt, type Readout } from './readout';
import { BOOK, drawBook, drawShelf, SERVER } from './stations';
import { addressBefore, ATTACKER_KINDS, detailsAt, DEVICE_TOP, FACE_EMOJI, formatWait, frameAt, KM_PER_SECOND, laneShare, LEVEL, lockPose, NO_LOCK, NOTE_LIFE, namedAcks, packetPos, packetPose, pageParts, segAt, swapLanding, swapMoment, travelPath, trayOpacity, UPSTREAM_KINDS, wrapsBefore, type LockPose, type Seg, type Timeline, FLOW_FALL, FLOW_FLY, type FlowHop, type FlowPacket, type FlowWait, type WaitStep } from './timeline';

/** A cable cut from one moment of a run to another; `to` left out while it stays cut. Cut before a run, it is from -Infinity. */
export interface CutSpan {
  link: string;
  from: number;
  to?: number;
}

export const COLOR = { app: '#4f9d69', tcp: '#8b6fd0', udp: '#b8609f', ip: '#4a84d4', vpn: '#2e5e6e', eth: '#e08b33', wifi: '#2a9d8f' } as const;
/** The bold-outline style: a warm light body, a blue that goes with it, and glass that is blue until it shows something. */
const DEVICE = '#f2ebdd';
const DEVICE_BLUE = '#5b8ec4';
const GLASS = '#5b8ec4';
const DARK_GLASS = '#3b4049';
/** Everything an attacker brings to the table. */
const ATTACKER = '#d23b3b';
/** A locked (encrypted) card: dark, under a padlock. */
const LOCKED = '#3d4654';

/** Mix two #rrggbb colours. */
function mix(a: string, b: string, t: number): string {
  const p = (h: string, i: number): number => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const c = [0, 1, 2].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t).toString(16).padStart(2, '0'));
  return `#${c.join('')}`;
}

/** A fresh address label as it lands, and once it has settled. */
const LABEL_FRESH = '#8fe3d0';
const LABEL_SETTLED = '#d8f5ee';
const WAIT = '#c2562f';
const PHOTO_ID = 'net-photo';
const sealedInside = (key: PartKey): boolean => key === 'ip' || key === 'l4' || key === 'card';
/** Screen pixels kept clear beside the chips of an opened packet. */
const CHIP_MARGIN = 8;
/** How much of the VPN box fades away when a packet is opened up. */
const BOX_CLEAR = 0.78;
/** A cable comes in where these would have their name, so it goes straight under them instead. */
const NAMED_BELOW = new Set(['dns-resolver', 'tld-server', 'vpn-server']);
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
      return { p: lerpV(a, b, q), ux: (b.x - a.x) / ground, uy: (b.y - a.y) / ground };
    }
    d -= lens[i]!;
  }
  return { p: path[0] ?? v3(0, 0, 0), ux: 1, uy: 0 };
}
/** A music note: its head and its stem with a flag. The head is one outline, as two halves side by side show a hairline between them. */
const NOTE_HEAD = 'M0 3 C-3 3 -9 5 -9 9 C-9 12 -4 13 0 12 C3 11 7 8 7 5 C7 3 3 3 0 3 Z';
/** The same head as two halves, for a note that breaks down the middle. */
const NOTE_HEAD_LEFT ='M0 3 C-3 3 -9 5 -9 9 C-9 12 -4 13 0 12 Z';
const NOTE_HEAD_RIGHT = 'M0 3 L0 12 C3 11 7 8 7 5 C7 3 3 3 0 3 Z';
const NOTE_STEM = 'M7 5 V-16 C8 -10 14 -9 14 -3';
/** How far to the side of its phone a note drifts, in SVG units. */
const NOTE_SIDE = 70;
/** How far to the side of its cable a small block rides, in tiles, so blocks going opposite ways pass each other; and how soon it gets there. */
const LANE = 0.55;
/** How small a device starts when it springs up, and how soon it is solid. */
const SPRING_SIZE = 0.5;
const SPRING_SOLID = 0.35;
/** How far back what a run does not use steps, and how many seconds that takes. */
const UNUSED_OPACITY = 0.28;
const STEP_BACK = 0.4;
/** How wide a device's button is (see app.css), and how small it gets. */
const ACTION_W = 104;
const ACTION_H = 34;
/** The sides of a device its button can stand on, best first, named for the way its arrow then points. */
const ACTION_SIDES = ['up', 'down', 'left', 'right'] as const;
type ActionSide = (typeof ACTION_SIDES)[number];
const MIN_ACTION_SIZE = 0.7;
/** What a device takes up around where it stands, with its trays above it and its name below, in SVG units. */
const DEVICE_ROOM = { side: 75, up: 130, down: 70 };
/** A cable, and the circle that lets it out as it is laid. */
interface CableView {
  id: string;
  g: SVGGElement;
  a: string;
  b: string;
  tip: SVGCircleElement;
  /** How far the circle has to grow to show all of it, once it has been measured. */
  reach: number;
}

/** The terminal ping and traceroute print to: the width of a character and the height of a line at its font size, and its margin. */
const TERM_CHAR = 7.3;
const TERM_LINE = 17;
const TERM_PAD = 12;
/** A speech bubble's tip below the spot a device's name hangs from, or below a hop's flag there, and the width of a character. */
const SPEECH_UNDER_NAME = 34;
const SPEECH_UNDER_FLAG = 70;
/** A speech bubble's height, and the screen pixels it keeps clear of the bar. */
const SPEECH_H = 40;
const SPEECH_OVER_BAR = 10;
const TERM_UNDER_NAME = 100;
/** How far along an attacker's terminal its name is: it hangs out to the right, away from the phone's. */
const TERM_TIP = 60;
/** How far below a hop's flag the next one on the same device hangs. */
const FLAG_ROW = 30;
const SPEECH_CHAR = 7.1;
/** The colours of a voice: its packets on the cables and its notes at the far end. */
const VOICE_OF_CALLER = '#8b6fd0';
const VOICE_OF_FRIEND = '#2f86e6';
/** The blade of the session key, with its teeth; the tip at the origin. */
const KEY_BLADE = 'M0 -2.2 H30 V2.2 H16 V8 H12 V2.2 H8 V6 H4 V2.2 H0 Z';

/** Header bytes → tiles along the packet. The data card is not to scale (it would dwarf the headers). */
const TILES_PER_BYTE = 0.04;
type Layer = Wrap | 'app';
const SECTION: Record<Layer, { d: number; h: number }> = { app: { d: 1.0, h: 0.72 }, l4: { d: 1.18, h: 0.88 }, ip: { d: 1.34, h: 1.02 }, vpn: { d: 1.48, h: 1.1 }, eth: { d: 1.62, h: 1.18 } };

type L2 = 'ethernet' | 'wifi';
const colorOf = (layer: Layer, trip: Trip, l2: L2 = 'ethernet'): string =>
  layer === 'l4' ? (trip.l4 === 'udp' ? COLOR.udp : COLOR.tcp) : layer === 'eth' && l2 === 'wifi' ? COLOR.wifi : COLOR[layer];
const layerName = (layer: Layer, trip: Trip, l2: L2 = 'ethernet'): string =>
  ({ app: 'App', l4: trip.l4 === 'udp' ? 'UDP' : trip.l4 === 'none' ? '' : 'TCP', ip: 'IP', vpn: 'VPN', eth: l2 === 'wifi' ? 'Wi-Fi' : 'Ethernet' })[layer];
const cardFont = (label: string): number => (label.length <= 7 ? 13 : label.length <= 14 ? 10.5 : 9);
const cardLen = (trip: Trip): number => {
  const label = trip.card ?? '';
  return Math.max(1.3 + 0.42 * Math.log2(Math.max(trip.dataBytes, 64) / 64), (label.length * cardFont(label) * 0.62 + 18) / U);
};

/** Text printed on a box face: `+y` faces run along +x on screen, `+x` faces along −y. */
const faceTf = (p: { sx: number; sy: number }, face: '+y' | '+x', lean = 0): string =>
  `matrix(1 ${face === '+y' ? 0.5 : -0.5} ${(-Math.sin(lean)).toFixed(3)} ${(Math.sin(lean) / 2 + Math.cos(lean)).toFixed(3)} ${p.sx.toFixed(1)} ${p.sy.toFixed(1)})`;
/** A laptop's lid, as long as the keyboard part is deep, leaning back from the hinge as a laptop's does. */
const LID = { long: 1.8, lean: (18 * Math.PI) / 180 };
/** How far up the lid its screen starts and ends. */
const LID_SCREEN = { from: 0.14, to: 1.7 };


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
  name: SVGTextElement;
}

interface Screen {
  face: SVGGElement;
  page: SVGGElement;
  title: SVGTextElement;
  dns: SVGGElement;
  dnsName: SVGTextElement;
  dnsAddr: SVGTextElement;
  fail: SVGTextElement;
  photo: SVGImageElement;
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
  /** Where the size chips of an opened packet are, left and right. */
  private chipRow: { left: number; right: number } | null = null;
  /** Emoji statuses over devices; on top of everything. */
  private readonly moods: SVGGElement;
  /** A call's music notes. */
  private readonly noteLayer: SVGGElement;
  /** Whether any note is up, so an empty frame costs nothing. */
  private notesUp = false;
  /** What ping or traceroute printed, and the hops flagged; behind the packet, which still has to get past them. */
  private readonly readoutLayer: SVGGElement;
  private readonly speechLayer: SVGGElement;
  private readonly over: SVGSVGElement;
  /** What that layer was last drawn as, so it is not drawn again every frame. */
  private readoutDrawn = '';
  private readonly fx: SVGGElement;
  /** What the spyglass reads, and the line it is on. */
  private readonly spyGlass: SVGGElement;
  private spy: string | null = null;
  /** The session keys beside each end, and the one at work. */
  private readonly keys: SVGGElement;
  /** What the laptop and the phone show on their screens. */
  private readonly screens = new Map<string, Screen>();
  /** Where a page that comes in several parts is put back together, beside the laptop. */
  private readonly sheet: Paper;
  /** The picture asked for, drawn wherever it shows. */
  private readonly photo: SVGImageElement;
  private overview = { x: 0, y: 0, w: 1, h: 1 };
  /** What is on the table right now, which is all the whole-network view has to frame; and what that is made of. */
  private table = { x: 0, y: 0, w: 1, h: 1 };
  private tableMade = '';
  private onTable: { sx: number; sy: number }[] = [];
  private bar = 0;
  /** The stretch of the table in view, for what must not be cut off at its edges. */
  private viewX = 0;
  private viewY = 0;
  private viewW = 0;
  private viewScale = 1;
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
  private cutSpans: readonly CutSpan[] = [];
  private cutKey = '';
  /** The line a tool would work on, highlighted. */
  private readonly hover: SVGGElement;
  /** Each drawn cable (or satellite hop) and the devices at its ends, to grey out the unused ones. */
  private cableViews: CableView[] = [];
  /** Devices that take part in this run; the rest are greyed out once it starts. */
  private used = new Set<string>();
  /** What the last run showed, which stays until the next one starts. */
  private revealed = new Set<string>();
  /** The visual time last drawn, for the tools. */
  private now = -1;
  /** The VPN tube and the stranger's dotted line, which only show with what they run along. */
  private tube: SVGGElement | null = null;
  private earBeam: SVGLineElement | null = null;
  private readonly devs: SVGGElement;
  /** The positions the devices were last built at. */
  private laidOut = '';
  /** Where the spyglass was last drawn, so it is not drawn again every frame. */
  private spyDrawn = '';
  /** What the packet was last drawn from: held still, it stays as it is. */
  private packetDrawn: { tl: Timeline; moment: string } | null = null;
  /** The stage's size in pixels, until it changes: asking the browser every frame makes it lay the page out. */
  private size: { w: number; h: number } | null = null;
  /** Your own devices are the ones you can start something on. */
  private yours = new Set<string>();
  /** The colour of each device's blocks, once several are at it. */
  private owners = new Map<string, string>();
  /** Whether any emoji is up, so an empty frame costs nothing. */
  private moodsUp = false;
  /** The devices keep their lines to themselves. */
  private quiet = false;
  /** The bubbles as last drawn, so they are not drawn again every frame. */
  private speechDrawn = '';
  private speechNodes: { g: SVGGElement; shape: SVGPathElement }[] = [];
  /** The side of its device each button keeps during this run. */
  private actionSides = new Map<string, ActionSide>();
  /** What the stranger has printed, while it has. */
  private heard: { g: SVGGElement; bottom: number } | null = null;

  constructor(
    host: HTMLElement,
    private story: Story,
    private tl: Timeline,
  ) {
    // One picture to a screen reader: its words are labels on things, not text to read out.
    this.svg = el('svg', { class: 'net-stage', preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': "A laptop and a phone, a home router, an internet provider's router, a DNS resolver and a web server, with the packets travelling between them" });
    host.appendChild(this.svg);
    const resized = (): void => {
      this.size = null;
    };
    new ResizeObserver(resized).observe(this.svg);
    window.addEventListener('resize', resized);
    this.photo = el('image', { id: PHOTO_ID, width: PAPER_W, height: PAPER_H, preserveAspectRatio: 'xMidYMid slice' }, el('defs', {}, this.svg));
    const world = el('g', {}, this.svg);
    this.cables = el('g', { class: 'cables' }, world);
    this.hover = el('g', { class: 'hover' }, world);
    this.devs = el('g', {}, world);
    this.sheet = new Paper(world);
    // Effects (impact bursts, timers) sit behind the packet, the way an anime impact star does.
    this.fx = el('g', { class: 'fx' }, world);
    this.readoutLayer = el('g', { class: 'moods' }, world);
    this.packet = el('g', { class: 'packet' }, world);
    this.tags = el('g', { class: 'tags' }, world);
    this.keys = el('g', { class: 'keys' }, world);
    this.moods = el('g', { class: 'moods' }, world);
    this.noteLayer = el('g', { class: 'moods' }, world);
    // What the devices say goes over everything, the bar and the buttons too: it matters, and it is gone in a moment.
    this.over = el('svg', { class: 'net-over', preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' }, host);
    this.speechLayer = el('g', { class: 'moods' }, this.over);
    this.spyGlass = el('g', { class: 'spy' }, world);

    this.buildDevices();
    this.setStory(story, tl);
  }

  /** The devices where the timeline puts them; built again when the layout changes (the cable to the ISP stretched). */
  private buildDevices(): void {
    this.devs.replaceChildren();
    this.devices.length = 0;
    this.screens.clear();
    this.laidOut = this.layoutKey();
    // Draw far devices first: a larger x + y is nearer the viewer.
    const order = [...this.story.devices].sort((m, n) => this.depthOf(m.id) - this.depthOf(n.id));
    for (const d of order) {
      const p = this.tl.pos.get(d.id) ?? { x: 0, y: 0 };
      const trays = el('g', { class: 'trays', opacity: 0 }, this.devs);
      const g = el('g', { class: ATTACKER_KINDS.has(d.kind) ? 'device attacker' : 'device', 'data-id': d.id }, this.devs);
      // The ISP router can be dragged further away between runs.
      if (d.kind === 'router') g.setAttribute('data-grab', d.id);
      const screen = this.buildDevice(g, d.kind, p.x, p.y);
      if (screen) {
        this.screens.set(d.id, screen);
        screen.face.setAttribute('data-device', d.id);
      }
      const { l4Name, l2Tray, l2Name } = this.buildTrays(trays, d.id, p.x, p.y);
      const s = NAMED_BELOW.has(d.kind) ? iso(p.x + 0.7, p.y + 0.7, 0) : iso(p.x, p.y + 1.9, 0);
      const name = el('text', { class: 'device-name', 'text-anchor': 'middle', x: s.sx.toFixed(1), y: (s.sy + 26).toFixed(1) }, g);
      name.textContent = d.label;
      this.devices.push({ id: d.id, g, trays, l4Name, l2Tray, l2Name, name });
    }
  }

  private layoutKey(): string {
    return [...this.tl.pos].map(([id, p]) => `${id}:${p.x},${p.y}`).join(' ');
  }

  /** Swap in a re-simulated story (after a cut). Devices and cables stay unless the layout moved; what's on the laptop screen may change. */
  setStory(story: Story, tl: Timeline): void {
    this.story = story;
    this.tl = tl;
    this.actionSides.clear();
    this.yours = new Set(story.devices.filter((d) => d.actions.length).map((d) => d.id));
    this.owners = new Map(story.devices.flatMap((d) => (d.color ? [[d.id, d.color]] : [])));
    if (this.layoutKey() !== this.laidOut) this.buildDevices();
    // A name can change with the run, as the TLD server's does with the site.
    for (const d of this.devices) d.name.textContent = story.devices.find((x) => x.id === d.id)?.label ?? d.name.textContent;
    const stops = (t: Trip): string[] => t.steps.flatMap((s) => (s.kind === 'flow' ? s.packets.flatMap(stops) : 'device' in s ? [s.device] : [s.from, s.to]));
    this.used = new Set([...story.trips.flatMap(stops), ...(story.listener ? [story.listener] : [])]);
    this.fit();
    this.buildCables();
    const sheetImage = story.image ?? '';
    if ((this.photo.getAttribute('href') ?? '') !== sheetImage) this.photo.setAttribute('href', sheetImage);
    this.sheet.setContent(story.image ? photoContent(PHOTO_ID) : pageContent(story.pageTitle ?? story.site));
    for (const [id, screen] of this.screens) {
      const shows = story.screens[id];
      const image = shows?.image ?? '';
      if ((screen.photo.getAttribute('href') ?? '') !== image) screen.photo.setAttribute('href', image);
      screen.photo.style.display = image ? '' : 'none';
      // A long title wraps onto two lines at the space nearest the middle.
      const t = shows?.pageTitle ?? '';
      const cut = t.length > 14 ? [...t.matchAll(/ /g)].map((m) => m.index).sort((a, b) => Math.abs(a - t.length / 2) - Math.abs(b - t.length / 2))[0] : undefined;
      screen.title.replaceChildren();
      const lines = cut === undefined ? [t] : [t.slice(0, cut), t.slice(cut + 1)];
      lines.forEach((line, i) => {
        const span = el('tspan', { x: screen.title.getAttribute('x') ?? 0, dy: i ? '1.15em' : lines.length > 1 ? '-0.4em' : '0' }, screen.title);
        span.textContent = line;
      });
      screen.dnsName.textContent = shows?.site ?? '';
      screen.dnsAddr.textContent = shows?.address ?? '';
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
      const za = this.deviceTop(l.a) + 0.2;
      const zb = this.deviceTop(l.b) + 0.9;
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
    return this.linkWorld(id).map((p) => isoV(p));
  }

  /** A spot a share t along a link, `lift` px above it; a satellite hop keeps to its first beam. */
  linkSpot(id: string, t: number, lift: number): { sx: number; sy: number } {
    const { p } = pointAlong(this.linkWorld(id), this.tl.sky.has(id) ? t * 0.56 : t);
    const s = isoV(p);
    return { sx: s.sx, sy: s.sy - lift };
  }

  /** The line the spyglass is on, if any. */
  setSpy(line: string | null): void {
    this.spy = line;
  }

  setQuiet(quiet: boolean): void {
    this.quiet = quiet;
  }

  /** The top of a device, in tiles. */
  private deviceTop(id: string): number {
    return DEVICE_TOP[this.tl.kind.get(id) ?? ''] ?? 1;
  }

  /** The spyglass, with its lens on the middle of its line; what it reads goes in the popup above the bar. It is drawn again only when it moves. */
  private renderSpy(): void {
    const where = this.spy ? `${this.spy}|${this.tl.sky.has(this.spy)}|${this.laidOut}` : '';
    if (where === this.spyDrawn) return;
    this.spyDrawn = where;
    this.spyGlass.replaceChildren();
    if (!this.spy) return;
    const glass = this.linkSpot(this.spy, 0.5, 0);
    drawSpyglass(el('g', { transform: `translate(${glass.sx.toFixed(1)} ${glass.sy.toFixed(1)})` }, this.spyGlass));
  }

  /** Cables between devices; a slow link is a radio hop up to a satellite instead. */
  private buildCables(): void {
    this.cables.replaceChildren();
    this.cableViews = [];
    this.tube = null;
    this.earBeam = null;
    for (const l of this.story.links) {
      const path = this.linkWorld(l.id);
      if (!path.length) continue;
      const g = el('g', { class: [l.a, l.b].some((d) => ATTACKER_KINDS.has(this.tl.kind.get(d) ?? '')) ? 'link attacker' : 'link' }, this.cables);
      if (this.tl.air.has(l.id)) {
        // Shaken (tapped between runs), the radio is noisy: the arc wobbles and frames get lost and sent again.
        // The whole group is the tap target: the arc, its ripples and its note alike.
        const noisy = this.story.noise > 0;
        g.classList.toggle('noisy', noisy);
        g.setAttribute('data-air', l.id);
        const pts = path.map((p) => isoV(p));
        const points = pts.map((p) => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(' ');
        el('polyline', { points, class: 'airwave-hit' }, g);
        el('polyline', { points, class: 'airwave' }, g);
        // Radio ripples at both ends.
        for (const p of [path[0]!, path[path.length - 1]!]) {
          const c = iso(p.x, p.y, p.z + 0.3);
          for (const r of [7, 12, 17]) el('path', { d: `M${(c.sx - r).toFixed(1)} ${(c.sy - r * 0.2).toFixed(1)}A${r} ${r} 0 0 1 ${(c.sx + r).toFixed(1)} ${(c.sy - r * 0.2).toFixed(1)}`, class: 'ripple' }, g);
        }
        // Home Wi-Fi with a password seals its frames; this one is not, so the spyglass can read it. Once is enough to say so.
        if (l.id === 'wlan') {
          const note = this.linkSpot(l.id, 0.3, 16);
          el('text', { x: note.sx, y: note.sy, 'text-anchor': 'middle', class: 'link-note' }, g).textContent = noisy ? 'open Wi-Fi · noisy' : 'open Wi-Fi';
        }
      } else if (path.length === 5) {
        // A cable from each device to its dish, then the radio beams up to the satellite.
        const [a, footA, top, footB, b] = path as [Vec3, Vec3, Vec3, Vec3, Vec3];
        for (const [end, foot] of [[a, footA], [b, footB]] as const) {
          line(g, end, v3(foot.x, foot.y, 0), { class: 'cable' });
          line(g, foot, top, { class: 'beam' });
          slab(g, { x: foot.x - 0.35, y: foot.y - 0.35, z: 0, w: 0.7, d: 0.7, h: 0.3, r: 0.35, color: DEVICE });
        }
        const sat = isoV(top);
        drawSatellite(el('g', { transform: `translate(${sat.sx.toFixed(1)} ${sat.sy.toFixed(1)})` }, g));
        el('text', { x: sat.sx, y: sat.sy - 30, 'text-anchor': 'middle', class: 'link-note' }, g).textContent = formatWait(l.delay);
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
        // The fibre to the ISP says how long it is: light takes its time, and the router can be dragged further away.
        if (l.id === 'wan') {
          const note = this.linkSpot(l.id, 0.5, 14);
          el('text', { x: note.sx, y: note.sy, 'text-anchor': 'middle', class: 'link-note' }, g).textContent = `${Math.round(l.delay * KM_PER_SECOND)} km · ${formatWait(l.delay)}`;
        }
      }
      // A circle growing out of the end it is laid from: that shows a dotted arc and a satellite as well as it does a cable.
      const start = this.tl.pos.get(this.tl.laid.get(l.id)?.from ?? l.a) ?? { x: 0, y: 0 };
      const origin = iso(start.x, start.y);
      const clip = el('clipPath', { id: `laying-${l.id}` }, this.cables);
      const tip = el('circle', { cx: origin.sx.toFixed(1), cy: origin.sy.toFixed(1) }, clip);
      this.cableViews.push({ id: l.id, g, a: l.a, b: l.b, tip, reach: 0 });
    }
    if (this.story.vpn) this.buildTunnel();
    // The stranger joins nothing: a dotted line says what it has its ear on.
    const ear = this.story.listener && this.tl.pos.get(this.story.listener);
    if (ear) {
      const from = iso(ear.x, ear.y, 1.6);
      const to = this.linkSpot('wlan', 0.5, 0);
      this.earBeam = el('line', { x1: from.sx, y1: from.sy, x2: to.sx, y2: to.sy, class: 'ear-beam' }, this.cables);
    }
  }

  /** A tube along the whole way from the device to the VPN server: inside it, nobody sees what is going on. */
  private buildTunnel(): void {
    const first = this.story.links.find((l) => l.a === this.tl.client);
    if (!first) return;
    const pts = [first.id, 'wan', 'bb3'].flatMap((id) => this.linkPath(id));
    const points = pts.map((p) => `${p.sx.toFixed(1)},${(p.sy - 10).toFixed(1)}`).join(' ');
    const g = el('g', { class: 'tunnel' }, this.cables);
    this.tube = g;
    el('polyline', { points, class: 'tunnel-tube' }, g);
    el('polyline', { points, class: 'tunnel-flow' }, g);
    const c = this.linkSpot('wan', 0.5, -34);
    const name = el('text', { x: c.sx, y: c.sy, 'text-anchor': 'middle', class: 'tunnel-name' }, g);
    name.textContent = 'VPN tunnel';
  }

  /** Is this device on the table: the VPN server only with a VPN, the name servers only with a cold resolver. */
  private shown(device: string): boolean {
    const kind = this.tl.kind.get(device) ?? '';
    if (kind === 'vpn-server') return this.story.vpn;
    if (UPSTREAM_KINDS.has(kind)) return this.story.cold;
    // The friend's phone stands there for a call, also one dropped in partway.
    if (kind === 'peer') return !!this.story.voice || this.used.has(device);
    return true;
  }

  /** How far a device has come onto the table at visual time v, from 0 to 1. */
  private present(device: string, v: number): number {
    if (!this.shown(device)) return 0;
    if (this.yours.has(device) || ATTACKER_KINDS.has(this.tl.kind.get(device) ?? '') || this.revealed.has(device)) return 1;
    const at = this.tl.reveals.get(device);
    return !at || v < at.t0 ? 0 : Math.max(0.01, clamp01((v - at.t0) / (at.t1 - at.t0)));
  }

  /** How far a cable is laid at visual time v, from 0 to 1. One nothing crosses this run comes with its two ends. */
  private layingOf(c: { id: string; a: string; b: string }, v: number): number {
    const ends = Math.min(this.present(c.a, v), this.present(c.b, v));
    const at = this.tl.laid.get(c.id);
    if (!at || this.revealed.size) return ends;
    return v < at.t0 ? 0 : Math.max(0.01, clamp01((v - at.t0) / (at.t1 - at.t0)));
  }

  /** What the last run showed stays on the table. An empty list clears it, and the next run shows it all again. */
  setRevealed(devices: Iterable<string>): void {
    this.revealed = new Set(devices);
  }

  /** Is this link really on the table right now? */
  hasLink(id: string): boolean {
    const c = this.cableViews.find((x) => x.id === id);
    return !!c && this.layingOf(c, this.now) > 0;
  }

  /** Lets a cable out as far as it is laid. */
  private layCable(c: CableView, k: number): void {
    const laying = k > 0 && k < 1;
    if (laying) {
      if (!c.reach) {
        const box = c.g.getBBox();
        const [cx, cy] = [Number(c.tip.getAttribute('cx')), Number(c.tip.getAttribute('cy'))];
        c.reach = Math.hypot(Math.max(cx - box.x, box.x + box.width - cx), Math.max(cy - box.y, box.y + box.height - cy));
      }
      setAttr(c.tip, 'r', (easeOut(k) * c.reach).toFixed(1));
    }
    setAttr(c.g, 'clip-path', laying ? `url(#laying-${c.id})` : 'none');
  }

  /** Which cables are cut, and from when to when in the run. */
  setCut(spans: readonly CutSpan[]): void {
    this.cutSpans = spans;
    this.showCuts(this.now);
  }

  /** A cable is drawn cut only at the moments it is: going back in a run takes you to before the cut. */
  private showCuts(v: number): void {
    const cut = this.cutSpans.filter((s) => v >= s.from && (s.to === undefined || v < s.to)).map((s) => s.link).sort();
    const key = cut.join(' ');
    if (key === this.cutKey) return;
    this.cutKey = key;
    this.cut = new Set(cut);
    this.buildCables();
  }

  /** Highlight the line a tool would work on. */
  setHover(id: string | null): void {
    this.hover.replaceChildren();
    if (!id) return;
    el('polyline', { points: this.linkPath(id).map((p) => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(' '), class: 'line-hover' }, this.hover);
  }

  /** Where the sheet stands: beside the device, clear of it. */
  private paperAt(): Pt {
    const d = this.tl.pos.get(this.tl.client) ?? { x: 0, y: 0 };
    const c = iso(d.x, d.y);
    return { sx: c.sx - 185, sy: c.sy - 85 };
  }

  /** Band n of the sheet, as a world point the arriving card flies into. */
  private paperSlot(n: number, of: number): Vec3 {
    const p = bandPoint(this.paperAt(), n, of);
    const { x, y } = unproject(p.sx, p.sy, 1.6);
    return v3(x, y, 1.6);
  }

  /** The middle of a device's screen. */
  private screenPoint(device = this.tl.client): Vec3 {
    const d = this.tl.pos.get(device) ?? { x: 0, y: 0 };
    const kind = this.tl.kind.get(device);
    return kind === 'phone' || kind === 'peer' ? v3(d.x, d.y + 0.2, 1.3) : v3(d.x, d.y - 0.9 - 0.9 * Math.sin(LID.lean), 0.14 + 0.9 * Math.cos(LID.lean));
  }

  private depthOf(id: string): number {
    const p = this.tl.pos.get(id) ?? { x: 0, y: 0 };
    return p.x + p.y;
  }

  /** Screen points (in SVG units) where your devices accept a dropped card, and what each can do. */
  dropPoints(): { id: string; actions: Action[]; sx: number; sy: number }[] {
    return this.story.devices.flatMap((d) => {
      const p = this.tl.pos.get(d.id);
      return p && d.actions.length ? [{ id: d.id, actions: d.actions, ...iso(p.x, p.y - 0.3, d.kind === 'phone' ? 1.4 : 1.0) }] : [];
    });
  }

  /** How much of the bottom of the view the bar covers, in screen pixels. */
  setBar(height: number): void {
    this.bar = height;
  }

  get barHeight(): number {
    return this.bar;
  }

  /** Screen pixels of a point in the world. */
  private onScreen(p: { sx: number; sy: number }): { x: number; y: number } {
    return { x: (p.sx - this.viewX) * this.viewScale, y: (p.sy - this.viewY) * this.viewScale };
  }

  /** How big a device's button is drawn: smaller as the camera goes back, as far as a finger can still hit it. */
  actionSize(): number {
    return Math.max(MIN_ACTION_SIZE, Math.min(1, this.viewScale / this.followScale()));
  }

  /** Where a device's button stands in the world on this side of it, at this zoom and size. */
  private actionPoint(device: string, side: ActionSide, scale: number, size: number): { sx: number; sy: number } {
    const p = this.tl.pos.get(device) ?? { x: 0, y: 0 };
    const name = iso(p.x, p.y + 1.9, 0);
    const middle = iso(p.x, p.y, this.deviceTop(device) / 2);
    const beside = DEVICE_ROOM.side + ((ACTION_W / 2 + 14) * size) / scale;
    if (side === 'up') return { sx: name.sx, sy: name.sy + 26 + (5 + 29 * size) / scale };
    if (side === 'down') {
      const head = iso(p.x, p.y, this.deviceTop(device) + 1.7);
      return { sx: head.sx, sy: head.sy - (24 * size) / scale };
    }
    return { sx: middle.sx + (side === 'left' ? beside : -beside), sy: middle.sy };
  }

  /** The side of a device its button keeps all through a run: the first that stands clear of everything this run can put on the table. */
  private actionSide(device: string): ActionSide {
    const known = this.actionSides.get(device);
    if (known) return known;
    const scale = this.followScale();
    const [w, h] = [(ACTION_W + 8) / scale, (ACTION_H + 8) / scale];
    const side = ACTION_SIDES.find((s) => {
      const a = this.actionPoint(device, s, scale, 1);
      return !this.devices.some(({ id }) => {
        if (id === device || !this.shown(id)) return false;
        const p = this.tl.pos.get(id) ?? { x: 0, y: 0 };
        const c = iso(p.x, p.y);
        return a.sx + w / 2 > c.sx - DEVICE_ROOM.side && a.sx - w / 2 < c.sx + DEVICE_ROOM.side && a.sy + h / 2 > c.sy - DEVICE_ROOM.up && a.sy - h / 2 < c.sy + DEVICE_ROOM.down;
      });
    }) ?? 'up';
    this.actionSides.set(device, side);
    return side;
  }

  /** Where a device's button is on the screen, in pixels, and which way its arrow points. */
  actionSpot(device: string): { x: number; y: number; points: ActionSide } {
    const points = this.actionSide(device);
    return { ...this.onScreen(this.actionPoint(device, points, this.viewScale, this.actionSize())), points };
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
    // Everything a run could bring on: what the follow camera's scale comes from, so it holds still during a run.
    this.overview = this.frameOf([...this.tl.pos.keys()].filter((id) => this.shown(id)), this.terminals());
    this.tableMade = '';
    this.frameTable();
  }

  /** The whole-network view shows what is there, not what could be: it grows as a run brings things on. */
  private frameTable(): void {
    const devices = [...this.tl.pos.keys()].filter((id) => this.present(id, this.now) > 0);
    const printing = this.terminals().filter((t) => this.now >= 0 && screenAt(t.readout, this.now));
    const made = `${devices.join()}|${printing.map((t) => t.device).join()}`;
    if (made === this.tableMade) return;
    this.tableMade = made;
    this.table = this.frameOf(devices, printing);
  }

  private frameOf(devices: string[], terminals: { readout: Readout; device: string }[]): { x: number; y: number; w: number; h: number } {
    const pts: { sx: number; sy: number }[] = [];
    for (const id of devices) {
      const p = this.tl.pos.get(id) ?? { x: 0, y: 0 };
      for (const [dx, dy] of [[-2, -2], [2, 2.4], [-2, 2.4], [2, -2]] as const) for (const z of [0, 3.2]) pts.push(iso(p.x + dx, p.y + dy, z));
    }
    pts.push(...this.onTable);
    // What a probe printed stays up after the run, so the view between runs keeps it in frame.
    for (const t of terminals) {
      const printed = this.terminalBox(t.readout, t.device);
      if (printed) pts.push({ sx: printed.x, sy: printed.y }, { sx: printed.x + printed.w, sy: printed.y + printed.h });
    }
    const minX = Math.min(...pts.map((p) => p.sx)) - 20;
    const maxX = Math.max(...pts.map((p) => p.sx)) + 20;
    const minY = Math.min(...pts.map((p) => p.sy)) - 10;
    // Room for the device names, and for the bar over the bottom of the view.
    const maxY = Math.max(...pts.map((p) => p.sy)) + 90;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  private get stage(): { w: number; h: number } {
    this.size ??= { w: this.svg.clientWidth || 1, h: this.svg.clientHeight || 1 };
    return this.size;
  }

  /** Screen pixels per SVG unit that fit the whole network, or this much of it. */
  private baseScale(o = this.overview): number {
    return Math.min(this.stage.w / o.w, this.stage.h / o.h);
  }

  /** Following shows about 560–1100 units across, so the packet stays big on a phone too. */
  private followScale(): number {
    const cw = this.stage.w;
    return Math.max(this.baseScale() * 1.15, cw / Math.min(1100, Math.max(560, cw * 0.8)));
  }

  /** How far a viewer may zoom out and in by hand. */
  scaleLimits(): { min: number; max: number } {
    return { min: this.baseScale() * 0.6, max: this.followScale() * 4 };
  }

  /** All that is on the table in view, however narrow the screen, and no closer than following a packet. */
  wholeCamera(): Camera {
    const o = this.table;
    return { cx: o.x + o.w / 2, cy: o.y + o.h / 2, scale: Math.min(this.baseScale(o), this.followScale()) };
  }

  /** More than one action at once: the whole network, with room for the sheet and for the notes above whoever is on a call. */
  busyCamera(): Camera {
    const o = this.table;
    const pts = [{ sx: o.x, sy: o.y }, { sx: o.x + o.w, sy: o.y + o.h - 90 }];
    if (pageParts(this.tl)) {
      const paper = this.paperAt();
      pts.push({ sx: paper.sx - 100, sy: paper.sy - 170 }, { sx: paper.sx + 100, sy: paper.sy + 110 });
    }
    for (const id of new Set(this.tl.notes.map((n) => n.device))) {
      const d = this.tl.pos.get(id) ?? { x: 0, y: 0 };
      const c = iso(d.x, d.y);
      pts.push({ sx: c.sx - 174, sy: c.sy - 300 }, { sx: c.sx + 174, sy: c.sy + 100 });
    }
    return this.framing(pts);
  }

  /** Between runs: the whole network, or on a tall phone screen closer on the laptop and the card so they are big enough to drag. */
  overviewCamera(): Camera {
    const cw = this.stage.w;
    const ch = this.stage.h;
    const tall = ch > cw * 1.2;
    if (!tall && this.revealed.size) return this.wholeCamera();
    // Only your own things are on the table: no need to leave room for what has not shown up yet.
    const pts = this.story.devices.filter((d) => d.actions.length).flatMap((d) => {
      const p = this.tl.pos.get(d.id) ?? { x: 0, y: 0 };
      const c = iso(p.x, p.y);
      return [{ sx: c.sx - 130, sy: c.sy - 130 }, { sx: c.sx + 130, sy: c.sy + 70 }];
    });
    if (this.now >= 0) pts.push(...this.terminalCorners());
    const xs = [...pts, ...this.onTable].map((p) => p.sx);
    const ys = [...pts, ...this.onTable].map((p) => p.sy);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const fit = Math.min(cw / (x1 - x0), (ch - this.bar) / (y1 - y0));
    const scale = tall ? Math.min(fit, Math.max(this.baseScale(), cw / 560)) : Math.min(fit, this.followScale());
    // In the middle of what the bar leaves free.
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 + this.bar / 2 / scale, scale };
  }

  /** Whether the whole network has anything to show that the view between runs leaves out. */
  get anythingRevealed(): boolean {
    return this.revealed.size > 0;
  }

  /** Close on the packet (or the device it is at) at visual time v. */
  followCamera(v: number): Camera {
    const hit = segAt(this.tl, v);
    if (hit?.seg.flow && hit.seg.flow.length > 1) return this.flowCamera(hit.seg.flow);
    if (!hit && this.story.probe) return this.resultCamera();
    let p: Vec3;
    const laptop = this.tl.pos.get(this.tl.client) ?? { x: 0, y: 0 };
    const mood = this.tl.reactions.find((r) => v >= r.t && v < r.t + 1.1);
    if (mood && (!hit || v < hit.seg.t0)) {
      // Between trips: stay on whoever is reacting.
      const d = this.tl.pos.get(mood.device) ?? { x: 0, y: 0 };
      p = v3(d.x, d.y, this.deviceTop(mood.device) + 1.5);
    } else if (hit?.seg.step.kind === 'wait' || hit?.seg.step.kind === 'lookup') {
      const d = this.tl.pos.get(hit.seg.step.device) ?? { x: 0, y: 0 };
      p = v3(d.x, d.y, this.deviceTop(hit.seg.step.device) + 1.5);
    } else if (hit?.seg.flow) {
      // One small ACK: follow it like a packet, unless whoever sent it gets straight to work: the story stays there.
      const next = this.tl.segs[this.tl.segs.indexOf(hit.seg) + 1];
      const nextAt = next?.flow ? next.flow[0]?.hops[0]?.from : next && 'device' in next.step ? next.step.device : undefined;
      const sender = hit.seg.flow[0]!.hops[0]?.from;
      if (sender && nextAt === sender) {
        const d = this.tl.pos.get(sender) ?? { x: 0, y: 0 };
        p = v3(d.x, d.y, this.deviceTop(sender) + 1.5);
      } else p = this.blockAt(hit.seg.flow[0]!, v) ?? packetPos(this.tl, hit.seg, hit.k);
    } else if (hit) {
      p = packetPos(this.tl, hit.seg, hit.k);
      if (hit.seg.step.kind === 'read' && hit.seg.step.device === hit.seg.trip.client) p = v3(p.x, p.y, lerp(p.z, 1.2, hit.k));
    } else {
      // A reading ends out where the last of it landed: there is nothing to go back to the sensor for.
      const last = this.story.reading ? this.tl.segs.at(-1) : undefined;
      if (last) return this.followCamera(last.t1 - 1e-6);
      p = v3(laptop.x, laptop.y, 1.6);
    }
    // Aim a little below the packet so the device it hovers over stays in view.
    const s = iso(p.x, p.y, p.z * 0.65);
    return { cx: s.sx, cy: s.sy, scale: this.followScale() };
  }

  /** A stream is too much to follow: the way it takes, and the sheet it ends on. */
  private flowCamera(flow: FlowPacket[]): Camera {
    const paper = this.paperAt();
    // Room above the sheet for the chapter name; a call has no sheet, but needs room for the notes above each device.
    // Probes have no sheet either, only what they print.
    const pts = [
      ...(this.story.voice || this.story.probe
        ? []
        : [
            { sx: paper.sx - 100, sy: paper.sy - 170 },
            { sx: paper.sx + 100, sy: paper.sy + 110 },
          ]),
      ...this.terminalCorners(),
    ];
    const voice = flow.some((p) => p.trip.chapter === 'call');
    const above = voice ? 300 : 90;
    const beside = voice ? 70 + NOTE_SIDE + 34 : this.story.probe ? 110 : 70;
    for (const id of new Set(flow.flatMap((p) => p.hops.flatMap((h) => [h.from, h.to])))) {
      const d = this.tl.pos.get(id) ?? { x: 0, y: 0 };
      const c = iso(d.x, d.y);
      pts.push({ sx: c.sx - beside, sy: c.sy - above }, { sx: c.sx + beside, sy: c.sy + 100 });
    }
    return this.framing(pts);
  }

  private terminalCorners(): { sx: number; sy: number }[] {
    // The stranger is only listening: the camera stays with the packets, and what it hears waits under it.
    return this.terminals().filter((t) => t.device !== this.story.listener).flatMap((t) => {
      const b = this.terminalBox(t.readout, t.device);
      return b ? [{ sx: b.x - 20, sy: b.y - 80 }, { sx: b.x + b.w + 20, sy: b.y + b.h + 20 }] : [];
    });
  }

  /** A probe has run: what it printed and the path it found. On a tall phone screen the printout alone is big enough to read. */
  private resultCamera(): Camera {
    const pts = this.terminalCorners();
    const tall = this.stage.h > this.stage.w * 1.2;
    const devices = tall ? [] : this.tl.readout.flags.map((f) => f.device);
    for (const id of [this.tl.client, ...devices]) {
      const d = this.tl.pos.get(id) ?? { x: 0, y: 0 };
      const c = iso(d.x, d.y);
      pts.push({ sx: c.sx - 110, sy: c.sy - 90 }, { sx: c.sx + 110, sy: c.sy + 100 });
    }
    return this.framing(pts);
  }

  /** The camera that just fits these points. */
  private framing(pts: { sx: number; sy: number }[]): Camera {
    const x0 = Math.min(...pts.map((p) => p.sx));
    const x1 = Math.max(...pts.map((p) => p.sx));
    const y0 = Math.min(...pts.map((p) => p.sy));
    // Room for the bar over the bottom of the view.
    const y1 = Math.max(...pts.map((p) => p.sy)) + 90;
    const scale = Math.min(this.stage.w / (x1 - x0), this.stage.h / (y1 - y0));
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale };
  }

  /** Sets the viewBox so it matches the element's aspect ratio. */
  /** A camera that cuts off the chips of an opened packet stands further back, with the whole row in the middle. */
  fitChips(c: Camera): Camera {
    const row = this.chipRow;
    const width = this.stage.w;
    if (!row || (row.left >= c.cx - (width / 2 - CHIP_MARGIN) / c.scale && row.right <= c.cx + (width / 2 - CHIP_MARGIN) / c.scale)) return c;
    return { cx: (row.left + row.right) / 2, cy: c.cy, scale: Math.min(c.scale, (width - CHIP_MARGIN * 2) / (row.right - row.left)) };
  }

  applyCamera(c: Camera): void {
    const w = this.stage.w / c.scale;
    const h = this.stage.h / c.scale;
    this.viewX = c.cx - w / 2;
    this.viewY = c.cy - h / 2;
    this.viewW = w;
    this.viewScale = c.scale;
    // Fine enough for the closest zoom, where a tenth of a unit is most of a pixel and a pan would go in uneven steps.
    const box = `${this.viewX.toFixed(3)} ${this.viewY.toFixed(3)} ${w.toFixed(3)} ${h.toFixed(3)}`;
    setAttr(this.svg, 'viewBox', box);
    setAttr(this.over, 'viewBox', box);
  }

  /**
   * A screen on a vertical face at world point `a` (its top-left corner, face looking towards +y), `w` × `h` px.
   * Content is laid out for the laptop's 66 × 37 px screen and scaled to fit.
   */
  private buildScreen(g: SVGGElement, a: { sx: number; sy: number }, w: number, h: number, glass = GLASS, lean = 0): Screen {
    const face = el('g', { class: 'dev-screen', transform: faceTf(a, '+y', lean) }, g);
    el('rect', { x: 0, y: 0, width: w, height: h, rx: 3, fill: glass }, face);
    el('path', { d: `M${w * 0.5} 0H${w * 0.82}L${w * 0.4} ${h}H${w * 0.08}Z`, class: 'dev-glare' }, face);
    const W = 2.36 * U;
    const H = 1.32 * U;
    const k = Math.min(w / W, h / H);
    const page = el('g', { class: 'page', opacity: 0 }, face);
    el('rect', { x: 0, y: 0, width: w, height: h, rx: 3, fill: '#fbf8f2' }, page);
    const content = (parent: SVGGElement): SVGGElement =>
      el('g', { transform: `translate(${((w - W * k) / 2).toFixed(2)} ${((h - H * k) / 2).toFixed(2)}) scale(${k.toFixed(3)})` }, parent);
    const dns = el('g', { class: 'screen-dns', opacity: 0 }, face);
    const dc = content(dns);
    const name = el('text', { x: W / 2, y: H * 0.38, class: 'screen-small', 'text-anchor': 'middle' }, dc);
    const dnsAddr = el('text', { x: W / 2, y: H * 0.62, class: 'screen-addr', 'text-anchor': 'middle' }, dc);
    const pc = content(page);
    const photo = el('image', { x: 0, y: 0, width: w, height: h, preserveAspectRatio: 'xMidYMid slice' }, page);
    photo.style.display = 'none';
    const title = el('text', { x: W / 2, y: 0.5 * U, class: 'page-title', 'text-anchor': 'middle' }, pc);
    for (const [i, lw] of [0.8, 0.62, 0.7].entries()) {
      el('rect', { x: (W - W * lw) / 2, y: 0.78 * U + i * 6, width: W * lw, height: 2.4, rx: 1.2, fill: '#c9c1b5' }, pc);
    }
    const fail = el('text', { x: w / 2, y: h / 2, dy: '0.35em', class: 'screen-fail', 'text-anchor': 'middle', opacity: 0 }, face);
    fail.textContent = '✗';
    el('rect', { x: 0, y: 0, width: w, height: h, rx: 3, class: 'dev-line dev-glass-line' }, face);
    return { face, page, title, dns, dnsName: name, dnsAddr, fail, photo };
  }

  /** A rounded plate on a device's face, or a hole in it: `at` is its top corner on the left, seen from in front of that face. */
  private plate(g: SVGGElement, face: '+y' | '+x', at: Vec3, w: number, h: number, cls: string): void {
    el('rect', { x: 0, y: 0, width: w * U, height: h * U, rx: Math.min(3, (h * U) / 2), class: cls, transform: faceTf(isoV(at), face) }, g);
  }

  /** A round thing on a device's face: a light, a lens. */
  private stud(g: SVGGElement, face: '+y' | '+x', at: Vec3, r: number, cls: string): void {
    el('circle', { cx: 0, cy: 0, r, class: cls, transform: faceTf(isoV(at), face) }, g);
  }

  /** Air slots down the right side of a case: `x` is that side. */
  private vents(g: SVGGElement, x: number, y: number, zs: number[], half: number): void {
    for (const z of zs) line(g, v3(x, y + half, z), v3(x, y - half, z), { class: 'dev-vent' });
  }

  /** A low cabinet, the base of everything that looks things up. */
  private cabinet(g: SVGGElement, x: number, y: number, color: string): void {
    groundShadow(g, { x: x - 0.65, y: y - 1.0, w: 2.0, d: 1.6, r: 0.2 });
    slab(g, { x: x - 1.0, y: y - 0.8, z: 0, w: 2.0, d: 1.6, h: 0.75, r: 0.14, color });
    for (const z of [0.62, 0.34]) this.plate(g, '+y', v3(x - 0.82, y + 0.8, z), 1.64, 0.2, 'dev-row');
    this.stud(g, '+y', v3(x + 0.68, y + 0.8, 0.52), 2, 'dev-led');
  }

  /** A closed book lying on a cabinet: two covers with the pages between them. */
  private book(g: SVGGElement, x: number, y: number, h: number, cover: string): void {
    slab(g, { x: x - 0.7, y: y - 0.55, z: 0.75, w: 1.4, d: 1.1, h: 0.05, r: 0.05, color: cover });
    slab(g, { x: x - 0.62, y: y - 0.5, z: 0.8, w: 1.26, d: 1.0, h: h - 0.1, r: 0.03, color: '#fff8ea' });
    slab(g, { x: x - 0.7, y: y - 0.55, z: 0.7 + h, w: 1.4, d: 1.1, h: 0.05, r: 0.05, color: cover });
  }

  /** A phone standing up. The face is at y + 0.1. */
  private standingPhone(g: SVGGElement, x: number, y: number, color: string): void {
    groundShadow(g, { x: x - 0.45, y: y - 0.7, w: 1.6, d: 0.8, r: 0.2 });
    panel(g, { x: x - 0.7, y: y + 0.1, z: 0, w: 1.4, h: 2.3, t: 0.22, r: 0.18, lean: 0, color });
    line(g, v3(x + 0.7, y - 0.01, 1.75), v3(x + 0.7, y - 0.01, 1.3), { class: 'dev-port' });
  }

  private buildDevice(g: SVGGElement, kind: string, x: number, y: number): Screen | null {
    const color = ATTACKER_KINDS.has(kind) ? ATTACKER : DEVICE;
    switch (kind) {
      case 'stranger':
      case 'scanner':
      case 'laptop': {
        groundShadow(g, { x: x - 0.9, y: y - 1.3, w: 3.2, d: 2.2, r: 0.3 });
        panel(g, { x: x - 1.3, y: y - 0.9, z: 0.14, w: 2.6, h: LID.long, t: 0.1, r: 0.14, lean: LID.lean, color });
        slab(g, { x: x - 1.3, y: y - 0.9, z: 0, w: 2.6, d: 1.8, h: 0.14, r: 0.16, color });
        const keys = Array.from({ length: 4 * 11 }, (_, i) => ({ x: x - 1.08 + (i % 11) * 0.198, y: y - 0.74 + Math.floor(i / 11) * 0.2, w: 0.16, d: 0.15 }));
        tiles(g, keys, 0.14, { class: 'dev-keys' });
        tiles(g, [{ x: x - 0.42, y: y + 0.14, w: 0.84, d: 0.56 }], 0.14, { class: 'dev-pad' });
        line(g, v3(x + 1.3, y + 0.28, 0.07), v3(x + 1.3, y + 0.5, 0.07), { class: 'dev-port' });
        // Screen glass on the face towards the viewer; what it shows changes as the story goes on.
        const corner = iso(x - 1.18, y - 0.9 - LID_SCREEN.to * Math.sin(LID.lean), 0.14 + LID_SCREEN.to * Math.cos(LID.lean));
        return this.buildScreen(g, corner, 2.36 * U, (LID_SCREEN.to - LID_SCREEN.from) * U, kind === 'laptop' ? GLASS : DARK_GLASS, LID.lean);
      }
      case 'phone': {
        this.standingPhone(g, x, y, color);
        const screen = this.buildScreen(g, iso(x - 0.6, y + 0.1, 2.18), 1.2 * U, 2.0 * U);
        this.plate(g, '+y', v3(x - 0.16, y + 0.1, 2.13), 0.32, 0.07, 'dev-notch');
        return screen;
      }
      case 'peer': {
        // The friend's phone, far away: the same phone with nothing on its screen.
        this.standingPhone(g, x, y, color);
        this.plate(g, '+y', v3(x - 0.6, y + 0.1, 2.18), 1.2, 2.0, 'dev-glass');
        this.plate(g, '+y', v3(x - 0.16, y + 0.1, 2.13), 0.32, 0.07, 'dev-notch');
        return null;
      }
      case 'sensor': {
        // A little box on the shelf: a lens, a light, and slots for the air it measures.
        groundShadow(g, { x: x - 0.3, y: y - 0.8, w: 1.2, d: 1.2, r: 0.2 });
        slab(g, { x: x - 0.6, y: y - 0.6, z: 0, w: 1.2, d: 1.2, h: 0.9, r: 0.18, color });
        this.stud(g, '+y', v3(x, y + 0.6, 0.5), 8, 'dev-lens');
        this.stud(g, '+y', v3(x - 0.08, y + 0.6, 0.58), 2.4, 'dev-shine');
        this.stud(g, '+y', v3(x, y + 0.6, 0.16), 2, 'dev-led');
        for (const dy of [0.3, 0.1, -0.1, -0.3]) line(g, v3(x + 0.6, y + dy, 0.62), v3(x + 0.6, y + dy, 0.28), { class: 'dev-vent' });
        return null;
      }
      case 'mqtt-broker': {
        // A box of ports, like a network switch: it is all connections.
        groundShadow(g, { x: x - 0.55, y: y - 1.1, w: 1.8, d: 1.8, r: 0.2 });
        slab(g, { x: x - 0.9, y: y - 0.9, z: 0, w: 1.8, d: 1.8, h: 1.5, r: 0.14, color: DEVICE_BLUE });
        this.plate(g, '+y', v3(x - 0.76, y + 0.9, 1.34), 1.52, 1.18, 'dev-face');
        for (let row = 0; row < 2; row++) for (let i = 0; i < 4; i++) this.plate(g, '+y', v3(x - 0.62 + i * 0.33, y + 0.9, 1.16 - row * 0.42), 0.24, 0.26, 'dev-hole');
        this.stud(g, '+y', v3(x + 0.6, y + 0.9, 0.34), 2, 'dev-led');
        this.vents(g, x + 0.9, y, [1.1, 0.85, 0.6], 0.45);
        return null;
      }
      case 'bot': {
        groundShadow(g, { x: x - 0.35, y: y - 0.9, w: 1.4, d: 1.4, r: 0.2 });
        slab(g, { x: x - 0.7, y: y - 0.7, z: 0, w: 1.4, d: 1.4, h: 1.8, r: 0.12, color });
        for (const z of [1.5, 1.05, 0.6]) this.plate(g, '+y', v3(x - 0.5, y + 0.7, z), 1.0, 0.3, 'dev-row');
        this.vents(g, x + 0.7, y, [1.4, 1.15, 0.9], 0.35);
        return null;
      }
      case 'home-router': {
        for (const ax of [x - 0.8, x + 0.8]) {
          line(g, v3(ax, y - 0.55, 0.5), v3(ax, y - 0.55, 1.6), { class: 'dev-aerial-line' });
          line(g, v3(ax, y - 0.55, 0.5), v3(ax, y - 0.55, 1.6), { class: 'dev-aerial' });
        }
        groundShadow(g, { x: x - 0.75, y: y - 0.9, w: 2.2, d: 1.4, r: 0.24 });
        slab(g, { x: x - 1.1, y: y - 0.7, z: 0, w: 2.2, d: 1.4, h: 0.14, r: 0.24, color: DEVICE_BLUE });
        slab(g, { x: x - 1.1, y: y - 0.7, z: 0.12, w: 2.2, d: 1.4, h: 0.43, r: 0.24, color });
        for (let i = 0; i < 5; i++) this.stud(g, '+y', v3(x - 0.72 + i * 0.36, y + 0.7, 0.32), 2.2, i ? 'dev-led dev-led-on' : 'dev-led');
        return null;
      }
      case 'router': {
        // A router's old sign: a drum with arrows on top, going every way.
        groundShadow(g, { x: x - 0.85, y: y - 1.45, w: 2.3, d: 2.3, r: 1.15 });
        slab(g, { x: x - 1.15, y: y - 1.15, z: 0, w: 2.3, d: 2.3, h: 0.8, r: 1.15, color });
        const c = iso(x, y, 0.8);
        el('ellipse', { cx: c.sx.toFixed(1), cy: c.sy.toFixed(1), rx: (0.86 * Math.SQRT2 * U).toFixed(1), ry: ((0.86 * Math.SQRT2 * U) / 2).toFixed(1), class: 'dev-disc' }, g);
        const toward = (along: number, across: number, d: [number, number]): Pt => iso(x + d[0] * along - d[1] * across, y + d[1] * along + d[0] * across, 0.8);
        const arrows = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]).map((d) => {
          const [a, b, l, r] = [toward(0.16, 0, d), toward(0.66, 0, d), toward(0.46, 0.17, d), toward(0.46, -0.17, d)];
          return `M${a.sx.toFixed(1)} ${a.sy.toFixed(1)}L${b.sx.toFixed(1)} ${b.sy.toFixed(1)}M${l.sx.toFixed(1)} ${l.sy.toFixed(1)}L${b.sx.toFixed(1)} ${b.sy.toFixed(1)}L${r.sx.toFixed(1)} ${r.sy.toFixed(1)}`;
        });
        el('path', { d: arrows.join(''), class: 'dev-arrow' }, g);
        return null;
      }
      case 'vpn-server': {
        groundShadow(g, { x: x - 0.65, y: y - 1.0, w: 2.0, d: 1.6, r: 0.2 });
        slab(g, { x: x - 1.0, y: y - 0.8, z: 0, w: 2.0, d: 1.6, h: 1.3, r: 0.14, color });
        this.plate(g, '+y', v3(x - 0.84, y + 0.8, 1.16), 1.68, 1.02, 'dev-bay');
        for (let i = 0; i < 3; i++) this.plate(g, '+y', v3(x - 0.74, y + 0.8, 1.08 - i * 0.3), 1.48, 0.24, 'dev-row');
        this.vents(g, x + 1.0, y, [1.0, 0.75, 0.5], 0.4);
        const top = iso(x, y, 2.2);
        drawShield(el('g', { transform: `translate(${top.sx.toFixed(1)} ${top.sy.toFixed(1)})` }, g));
        return null;
      }
      case 'dns-resolver': {
        // A squat cabinet with a fat address book on top.
        this.cabinet(g, x, y, color);
        this.book(g, x, y, 0.35, BOOK);
        return null;
      }
      case 'root-server': {
        // The top of the tree: a cabinet with a globe on it.
        this.cabinet(g, x, y, color);
        slab(g, { x: x - 0.14, y: y - 0.14, z: 0.75, w: 0.28, d: 0.28, h: 0.16, r: 0.14, color: BOOK });
        const top = iso(x, y, 1.3);
        el('circle', { cx: top.sx, cy: top.sy, r: 12, class: 'dev-globe' }, g);
        el('circle', { cx: top.sx, cy: top.sy, r: 12, class: 'root-globe' }, g);
        el('ellipse', { cx: top.sx, cy: top.sy, rx: 5, ry: 12, class: 'root-globe' }, g);
        el('line', { x1: top.sx - 12, y1: top.sy, x2: top.sx + 12, y2: top.sy, class: 'root-globe' }, g);
        return null;
      }
      case 'tld-server':
      case 'auth-server': {
        // Cabinets like the resolver's, each with its own thinner book.
        this.cabinet(g, x, y, color);
        this.book(g, x, y, 0.2, kind === 'tld-server' ? '#7f9b67' : BOOK);
        return null;
      }
      default: {
        // The web server: a tower, its shelves the ones the page is looked up on.
        const front = y + SERVER.half;
        groundShadow(g, { x: x - 0.45, y: y - 1.0, w: SERVER.half * 2, d: SERVER.half * 2, r: 0.2 });
        slab(g, { x: x - SERVER.half, y: y - SERVER.half, z: 0, w: SERVER.half * 2, d: SERVER.half * 2, h: SERVER.height, r: 0.14, color });
        this.plate(g, '+y', v3(x - 0.66, front, 2.5), 1.32, 2.0, 'dev-bay');
        for (const z of SERVER.slots) {
          this.plate(g, '+y', v3(x - SERVER.slotHalf, front, z + 0.17), SERVER.slotHalf * 2, 0.34, 'dev-row');
          this.stud(g, '+y', v3(x + SERVER.slotHalf - 0.14, front, z), 2, 'dev-led');
        }
        this.vents(g, x + SERVER.half, y, [2.1, 1.85, 1.6, 1.35, 1.1], 0.42);
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

  /** Devices, trays and the laptop screen at visual time v. `over`: how far the run is behind us, from 0 to 1. */
  render(v: number, over = 0): void {
    const tl = this.tl;
    const hit = segAt(tl, v);
    this.now = v;
    this.showCuts(v);
    this.frameTable();
    // Once a run starts, whatever it doesn't use steps back, until the run is over.
    const greying = v >= 0 && over < 1;
    const stepped = lerp(1, UNUSED_OPACITY, clamp01(v / STEP_BACK) * (1 - over));
    // Opacity comes from v alone: a CSS transition restarted every frame splits the page into layers, and what is on top flickers.
    const fadeIn = (e: SVGGElement | SVGLineElement, on: number): void => {
      e.classList.toggle('absent', on === 0);
      const opacity = on > 0 && on < 1 ? String(Number(on.toFixed(3))) : '';
      if (e.style.opacity !== opacity) e.style.opacity = opacity;
    };
    for (const d of this.devices) {
      // Devices come onto the table as packets reach them. Without a VPN its server never does, nor the name servers without
      // a cold resolver.
      const on = this.present(d.id, v);
      const unused = on > 0 && greying && !this.used.has(d.id);
      fadeIn(d.g, clamp01(on / SPRING_SOLID) * (unused ? stepped : 1));
      d.g.classList.toggle('unused', unused);
    }
    for (const c of this.cableViews) {
      const k = this.layingOf(c, v);
      const unused = greying && (!this.used.has(c.a) || !this.used.has(c.b));
      fadeIn(c.g, (k > 0 ? 1 : 0) * (unused ? stepped : 1));
      c.g.classList.toggle('unused', unused);
      this.layCable(c, k);
    }
    const vpn = this.story.devices.find((d) => d.kind === 'vpn-server');
    if (this.tube && vpn) fadeIn(this.tube, this.present(vpn.id, v));
    const wifi = this.cableViews.find((c) => c.id === 'wlan');
    if (this.earBeam) fadeIn(this.earBeam, wifi ? this.layingOf(wifi, v) : 0);
    for (const d of this.devices) {
      setAttr(d.trays, 'opacity', trayOpacity(tl, d.id, v).toFixed(3));
      setAttr(d.g, 'transform', `translate(0 ${(-this.hop(d.id, v) * U).toFixed(2)})${this.springing(d.id, v)}`);
      if (d.l4Name && hit) {
        const udp = hit.seg.trip.l4 === 'udp';
        setText(d.l4Name, layerName('l4', hit.seg.trip));
        setAttr(d.l4Name, 'fill', shade(udp ? COLOR.udp : COLOR.tcp, 0.75));
      }
      if (d.l2Tray && d.l2Name && hit) {
        const wifi = frameAt(hit.seg)?.l2 === 'wifi';
        const color = wifi ? COLOR.wifi : COLOR.eth;
        setText(d.l2Name, wifi ? 'Wi-Fi' : 'Ethernet');
        setAttr(d.l2Name, 'fill', shade(color, 0.75));
        setAttr(d.l2Tray, 'fill', color);
        setAttr(d.l2Tray, 'stroke', color);
      }
    }
    const parts = pageParts(tl);
    this.sheet.draw(this.paperAt(), isoV(this.screenPoint()), parts, v);
    this.renderMoods(v);
    this.renderNotes(v);
    this.renderReadout(v);
    // The camera goes on without the stranger: what it heard shows whole, or waits, and does not stick out from behind the bar.
    this.heard?.g.classList.toggle('absent', this.onScreen({ sx: 0, sy: this.heard.bottom }).y > this.stage.h - this.bar);
    this.renderSpeech(v);
    this.renderSpy();
    for (const [id, screen] of this.screens) {
      if (this.story.clients.includes(id) && v >= 0) continue;
      this.blank(screen);
      const known = this.remembered.get(id);
      screen.face.classList.toggle('remembers', !!known);
      if (!known) continue;
      setText(screen.dnsName, known.site);
      setText(screen.dnsAddr, known.ip);
      setAttr(screen.dns, 'opacity', '1');
    }
    if (v < 0) return;
    for (const id of this.story.clients) {
      const screen = this.screens.get(id);
      if (!screen) continue;
      const own = id === tl.client;
      const shows = this.story.screens[id];
      screen.face.classList.toggle('remembers', this.remembered.has(id));
      // A page in several parts shows once the finished sheet has slid into the screen. A device dropped in has no sheet.
      const pageAt = own && parts ? clamp01((v - parts.complete - 0.7) / 0.25) : this.screenAfterRead(v, 'page', id);
      const page = shows?.pageTitle ? pageAt : 0;
      setAttr(screen.page, 'opacity', page.toFixed(3));
      // On a second visit the laptop already knows the address from the start.
      const known = own && this.story.remembered ? 1 : this.screenAfterRead(v, 'dns', id);
      setAttr(screen.dns, 'opacity', (known * (1 - page)).toFixed(3));
      const last = tl.segs[tl.segs.length - 1];
      // A call has no page to show: it is not a failure when none comes.
      const failed = !!shows?.browsing && !shows.pageTitle && !!last && v >= last.t1;
      setAttr(screen.fail, 'opacity', failed ? '1' : '0');
    }
  }

  /** A device coming onto the table springs up from where it stands, a little too far and back. */
  private springing(device: string, v: number): string {
    const on = this.present(device, v);
    if (on <= 0 || on >= 1) return '';
    const p = this.tl.pos.get(device) ?? { x: 0, y: 0 };
    const c = iso(p.x, p.y);
    const size = lerp(SPRING_SIZE, 1, easeOutBack(on));
    return ` translate(${c.sx.toFixed(1)} ${c.sy.toFixed(1)}) scale(${size.toFixed(3)}) translate(${(-c.sx).toFixed(1)} ${(-c.sy).toFixed(1)})`;
  }

  private blank(screen: Screen): void {
    for (const e of [screen.page, screen.dns, screen.fail]) setAttr(e, 'opacity', '0');
  }

  /** Emoji statuses: each pops up over its device, floats up a little and fades. */
  private renderMoods(v: number): void {
    const live = this.tl.reactions.filter((r) => v >= r.t && v - r.t <= (r.stamp ? 2.6 : 1.6));
    if (!live.length && !this.moodsUp) return;
    this.moodsUp = live.length > 0;
    this.moods.replaceChildren();
    for (const r of live) {
      const dt = v - r.t;
      const d = this.tl.pos.get(r.device) ?? { x: 0, y: 0 };
      const c = iso(d.x, d.y, this.deviceTop(r.device) + 2.2 + 0.4 * dt);
      if (r.stamp) this.stamp(c, r.stamp, easeOutBack(clamp01(dt / 0.3)), 1 - clamp01((dt - 2.2) / 0.4));
      else this.emoji(this.moods, c, FACE_EMOJI[r.face], easeOutBack(clamp01(dt / 0.3)), 1 - clamp01((dt - 1.2) / 0.4));
    }
  }

  /** A call's sound: notes bubbling up from the phone that hears them, higher for a higher pitch, bigger for a louder one. */
  private renderNotes(v: number): void {
    const live = this.tl.notes.map((n, i) => ({ n, i })).filter(({ n }) => v >= n.t && v - n.t < NOTE_LIFE);
    if (!live.length && !this.notesUp) return;
    this.notesUp = live.length > 0;
    this.noteLayer.replaceChildren();
    for (const { n, i } of live) {
      const dt = v - n.t;
      const c = isoV(this.screenPoint(n.device));
      // Out of the phone's own screen, then away from its cable: each note has its own lane and its own sway, so they do
      // not rise in a single file. Its height for its pitch grows as it leaves.
      const out = easeOut(clamp01(dt / 0.9));
      const lane = ((i * 37) % 11) / 5 - 1;
      const side = n.heardBy === 'caller' ? -NOTE_SIDE : NOTE_SIDE;
      const x = c.sx + out * (side + lane * 34) + Math.sin(dt * 3 + i) * 7 * out;
      const y = c.sy - out * (50 + n.pitch * 90) - dt * 34;
      const scale = (0.7 + 0.7 * n.loud) * easeOutBack(clamp01(dt / 0.2));
      const op = 1 - clamp01((dt - (NOTE_LIFE - 0.8)) / 0.8);
      const g = el('g', { class: `note ${n.heardBy === 'caller' ? 'note-caller' : 'note-friend'}`, opacity: op.toFixed(3), transform: `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${scale.toFixed(3)})` }, this.noteLayer);
      if (n.broken) this.brokenNote(g, dt);
      else this.wholeNote(g);
    }
  }

  /** The terminal's place: its size is for everything it will print, so it does not grow as it goes. */
  private terminalBox(readout = this.tl.readout, device = this.tl.client): { x: number; y: number; w: number; h: number } | null {
    if (!readout.screens.length) return null;
    const c = isoV(this.screenPoint(device));
    const w = Math.max(...readout.screens.flatMap((s) => s.lines.map((l) => l.length))) * TERM_CHAR + TERM_PAD * 2;
    const h = Math.max(...readout.screens.map((s) => s.lines.length)) * TERM_LINE + TERM_PAD * 2;
    const kind = this.tl.kind.get(device) ?? '';
    // An attacker's hangs under its name, where the view has room, with space for what it says in between. The phone's goes
    // under it too, out to the left of the stranger beside it.
    const p = this.tl.pos.get(device) ?? { x: 0, y: 0 };
    const name = iso(p.x, p.y + 1.9, 0);
    if (ATTACKER_KINDS.has(kind)) return { x: name.sx - TERM_TIP, y: name.sy + TERM_UNDER_NAME, w, h };
    if (kind === 'phone' && this.story.listener) return { x: name.sx - w, y: name.sy + TERM_UNDER_NAME, w, h };
    // Above the laptop is open table. Up from the phone is the home router and left of it the cards, so it goes below.
    return kind === 'phone' ? { x: c.sx + 50, y: c.sy + 40, w, h } : { x: c.sx - w / 2, y: c.sy - 150 - h, w, h };
  }

  /** Everything that prints this run, with the device it prints beside. */
  private terminals(): { readout: Readout; device: string; red?: boolean }[] {
    return [
      { readout: this.tl.readout, device: this.tl.client },
      ...this.tl.joinReadouts,
      ...this.tl.attackReadouts.map((x) => ({ ...x, red: true })),
    ];
  }

  /** The terminal beside the device that ran the tool, and each hop flagged under the name of whoever answered. */
  private renderReadout(v: number): void {
    const terminals = this.terminals();
    const lines = terminals.map((x) => (v < 0 ? null : screenAt(x.readout, v)));
    const flags = v < 0 ? [] : terminals.flatMap((x) => x.readout.flags).filter((f) => v >= f.t);
    const sizes = flags.map((f) => easeOutBack(clamp01((v - f.t) / 0.3)));
    const drawn = `${this.laidOut}|${lines.map((l) => l?.join('\n')).join('|')}|${sizes.map((s) => s.toFixed(2)).join(' ')}`;
    if (drawn === this.readoutDrawn) return;
    this.readoutDrawn = drawn;
    this.readoutLayer.replaceChildren();
    this.heard = null;
    flags.forEach((f, i) => {
      const d = this.tl.pos.get(f.device) ?? { x: 0, y: 0 };
      const s = iso(d.x, d.y + 1.9, 0);
      // Two traces find the same hops: the second flag hangs under the first.
      const row = flags.slice(0, i).filter((x) => x.device === f.device).length;
      const g = el('g', { class: 'mood', transform: `translate(${s.sx.toFixed(1)} ${(s.sy + 50 + row * FLAG_ROW).toFixed(1)}) scale(${sizes[i]!.toFixed(3)})` }, this.readoutLayer);
      const w = f.text.length * 7.4 + 22;
      el('rect', { x: -w / 2, y: -13, width: w, height: 26, rx: 13, class: 'hop-bg' }, g);
      el('text', { 'text-anchor': 'middle', dy: '0.36em', class: 'hop-text' }, g).textContent = f.text;
    });
    terminals.forEach(({ readout, device, red }, n) => {
      const box = this.terminalBox(readout, device);
      if (!lines[n] || !box) return;
      const g = el('g', { class: 'mood', transform: `translate(${box.x.toFixed(1)} ${box.y.toFixed(1)})` }, this.readoutLayer);
      if (device === this.story.listener) this.heard = { g, bottom: box.y + box.h };
      // One that hangs under its device has only to be as long as what it has printed so far.
      const h = this.tl.kind.get(device) === 'laptop' ? box.h : lines[n].length * TERM_LINE + TERM_PAD * 2;
      // An attacker's points up at its name, in one piece with the terminal, the way what a device says does.
      if (red) el('path', { d: `M8 0 H${TERM_TIP - 9} L${TERM_TIP} -10 L${TERM_TIP + 9} 0 H${box.w - 8} a8 8 0 0 1 8 8 V${h - 8} a8 8 0 0 1 -8 8 H8 a8 8 0 0 1 -8 -8 V8 a8 8 0 0 1 8 -8 Z`, class: 'term-bg term-red' }, g);
      else el('rect', { width: box.w, height: h, rx: 8, class: 'term-bg' }, g);
      lines[n].forEach((line, i) => {
        el('text', { x: TERM_PAD, y: TERM_PAD + (i + 0.75) * TERM_LINE, class: i ? 'term-text' : 'term-text term-title' }, g).textContent = line;
      });
    });
  }

  /**
   * What the devices say: each line pops up under its speaker's name. Over a device it would land on the terminal, or on the
   * device behind: the web server's stack of trays reaches up to the DNS resolver.
   */
  private renderSpeech(v: number): void {
    const live = this.quiet ? [] : this.tl.speech.filter((b) => v >= b.t0 && v < b.t1);
    // The camera sits further back on a phone.
    const big = this.stage.w < 520 ? 1.3 : 1;
    const flags = [...this.tl.readout.flags, ...this.tl.joinReadouts.flatMap((x) => x.readout.flags)];
    const lowest = this.viewY + (this.stage.h - this.bar - SPEECH_OVER_BAR) / this.viewScale - SPEECH_H * big;
    const looks = live.map((b) => {
      const d = this.tl.pos.get(b.device) ?? { x: 0, y: 0 };
      const s = iso(d.x, d.y + 1.9, 0);
      const w = b.text.length * SPEECH_CHAR + 28;
      // A long line under a device at the edge of the view moves in, and points back at it.
      const room = (w / 2) * big + 8;
      const x = room * 2 < this.viewW ? Math.max(this.viewX + room, Math.min(this.viewX + this.viewW - room, s.sx)) : s.sx;
      const flagged = flags.filter((f) => f.device === b.device && v >= f.t).length;
      // On a low screen a device's name can reach the bar: what it says stops above that.
      const y = Math.min(s.sy + (flagged ? SPEECH_UNDER_FLAG + (flagged - 1) * FLAG_ROW : SPEECH_UNDER_NAME), lowest);
      return { b, s, w, x, y, size: easeOutBack(clamp01((v - b.t0) / 0.25)), op: clamp01((b.t1 - v) / 0.25) };
    });
    // Made anew only for a new line. A bubble held at the edge of the view moves with the camera, so where it sits is set every frame:
    // comparing that rounded, to redraw less, left it riding with the table and then jumping back, by whole units, which zoomed in is many pixels.
    const drawn = looks.map(({ b }) => `${b.device} ${b.text}`).join('|');
    if (drawn !== this.speechDrawn) {
      this.speechDrawn = drawn;
      this.speechLayer.replaceChildren();
      this.speechNodes = looks.map(({ b }) => {
        const g = el('g', { class: 'mood' }, this.speechLayer);
        const shape = el('path', { class: 'speech-bg' }, g);
        el('text', { y: 24, 'text-anchor': 'middle', dy: '0.36em', class: 'speech-text' }, g).textContent = b.text;
        return { g, shape };
      });
    }
    looks.forEach(({ s, w, x, y, size, op }, i) => {
      const { g, shape } = this.speechNodes[i]!;
      setAttr(g, 'opacity', op.toFixed(3));
      setAttr(g, 'transform', `translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${(size * big).toFixed(3)})`);
      const tip = Math.max(-w / 2 + 28, Math.min(w / 2 - 28, (s.sx - x) / big));
      setAttr(shape, 'd', `M${-w / 2 + 16} 8 H${(tip - 9).toFixed(2)} L${tip.toFixed(2)} -2 L${(tip + 9).toFixed(2)} 8 H${w / 2 - 16} a16 16 0 0 1 0 32 H${-w / 2 + 16} a16 16 0 0 1 0 -32 Z`);
    });
  }

  private wholeNote(g: SVGGElement): void {
    el('path', { d: NOTE_HEAD, class: 'note-solid' }, g);
    el('path', { d: NOTE_STEM, class: 'note-line' }, g);
  }

  /** A note snapped in two: the halves fly apart and drop, with a little crack of lines at the start. */
  private brokenNote(g: SVGGElement, dt: number): void {
    const apart = 3 + easeOut(clamp01(dt / 0.5)) * 13;
    const drop = 26 * dt * dt;
    const turn = 40 * easeOut(clamp01(dt / 0.8));
    const left = el('g', { transform: `translate(${(-apart).toFixed(1)} ${drop.toFixed(1)}) rotate(${(-turn).toFixed(1)} -4 8)` }, g);
    el('path', { d: NOTE_HEAD_LEFT, class: 'note-solid' }, left);
    const right = el('g', { transform: `translate(${apart.toFixed(1)} ${drop.toFixed(1)}) rotate(${turn.toFixed(1)} 4 8)` }, g);
    el('path', { d: NOTE_HEAD_RIGHT, class: 'note-solid' }, right);
    el('path', { d: NOTE_STEM, class: 'note-line' }, right);
    if (dt < 0.3) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const r = 10 + 40 * dt;
        el('line', { x1: Math.cos(a) * r, y1: 4 + Math.sin(a) * r, x2: Math.cos(a) * (r + 6), y2: 4 + Math.sin(a) * (r + 6), class: 'note-crack', opacity: (1 - dt / 0.3).toFixed(2) }, g);
      }
    }
  }

  /** The server's name, stamped: its certificate really says so. */
  private stamp(c: { sx: number; sy: number }, name: string, scale: number, op: number): void {
    const text = `${name} ✓`;
    const w = text.length * 9 + 26;
    const g = el('g', { class: 'mood stamp', opacity: op.toFixed(3), transform: `translate(${c.sx.toFixed(1)} ${c.sy.toFixed(1)}) rotate(-4) scale(${scale.toFixed(3)})` }, this.moods);
    el('rect', { x: -w / 2, y: -17, width: w, height: 34, rx: 7, class: 'stamp-bg' }, g);
    el('text', { 'text-anchor': 'middle', dy: '0.36em', class: 'stamp-text' }, g).textContent = text;
  }

  /** One emoji in a round white bubble, centred on a screen point. */
  private emoji(parent: SVGGElement, c: { sx: number; sy: number }, glyph: string, scale: number, op: number): void {
    const g = el('g', { class: 'mood', opacity: op.toFixed(3), transform: `translate(${c.sx.toFixed(1)} ${c.sy.toFixed(1)}) scale(${scale.toFixed(3)})` }, parent);
    el('circle', { r: 20, class: 'mood-bg' }, g);
    const t = el('text', { 'text-anchor': 'middle', dy: '0.36em', class: 'mood-face' }, g);
    t.textContent = glyph;
  }

  /** 0..1: how far a device has shown what a card of this chapter brought it (it fades in as the card goes in). */
  private screenAfterRead(v: number, chapter: Trip['chapter'], device: string): number {
    let o = 0;
    for (const s of this.tl.segs) {
      if (s.step.kind !== 'read' || s.trip.chapter !== chapter || s.step.device !== device) continue;
      o = Math.max(o, clamp01((v - lerp(s.t0, s.t1, 0.8)) / 0.4));
    }
    const landed = (chapter === 'page' ? this.tl.pages : this.tl.answers).get(device);
    return landed === undefined ? o : Math.max(o, clamp01((v - landed) / 0.4));
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

  /** Whether there is a whole packet to pop open (not one tumbling off a cable). */
  peekable(v: number): boolean {
    const kind = segAt(this.tl, v)?.seg.step.kind;
    return !!kind && kind !== 'lost' && kind !== 'wait' && kind !== 'lookup' && kind !== 'flow';
  }

  /** The packet at visual time v. `peek` (0..1) pulls its pieces apart and shows their sizes; `pill` is the one opened. */
  drawPacket(v: number, peek: number, pill: { key: PartKey; k: number } | null = null): void {
    this.pill = pill;
    // The spy's note makes way for the size chips.
    this.spyGlass.style.display = peek > 0.05 || (this.spy && !this.hasLink(this.spy)) ? 'none' : '';
    // Paused, or between runs, nothing below has anything new to draw.
    const moment = `${v}|${peek.toFixed(3)}|${pill?.key}|${pill?.k.toFixed(3)}`;
    if (this.packetDrawn?.tl === this.tl && this.packetDrawn.moment === moment) return;
    this.packetDrawn = { tl: this.tl, moment };
    this.packet.replaceChildren();
    this.tags.replaceChildren();
    this.chipRow = null;
    this.fx.replaceChildren();
    this.keys.replaceChildren();
    this.keyhole = null;
    const hit = segAt(this.tl, v);
    if (!hit) return;
    const { seg, k } = hit;
    const step = seg.step;
    if (step.kind === 'wait') {
      this.drawWait(step, k, seg.t1 - seg.t0);
      this.drawKeys(v, seg, NO_LOCK);
      return;
    }
    if (seg.flow) {
      this.drawFlow(seg.flow, seg.waits ?? [], v, seg.trip.chapter === 'traffic');
      this.drawKeys(v, seg, NO_LOCK);
      return;
    }
    if (step.kind === 'lookup') {
      const d = this.tl.pos.get(step.device) ?? { x: 0, y: 0 };
      const draw = step.what === 'dns' ? drawBook : drawShelf;
      draw(this.fx, v3(d.x, d.y, this.deviceTop(step.device)), seg.p1, step, k);
      this.drawKeys(v, seg, NO_LOCK);
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
        if (seg.knock.byYou) this.burst(pose.pos, tau);
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
      const part = seg.trip.part;
      // A part of a bigger page goes onto its band of the sheet; anything else into the screen or the device.
      const target = !this.story.clients.includes(step.device) ? v3(d.x, d.y, this.deviceTop(step.device)) : part ? this.paperSlot(part.n, part.of) : this.screenPoint(step.device);
      pose.pos = lerpV(pose.pos, target, sink);
      for (const p of parts) {
        if (p.key !== 'card') continue;
        p.scale *= 1 - 0.7 * sink;
        p.op *= 1 - sink;
      }
    }
    this.drawPose(seg, k, trip, parts, pose, wiggle, lock);
    this.drawKeys(v, seg, lock);
    // A hello carries the sender's public half, there for any snoop to see; the half that completes the key stays home.
    if (trip.keyShare && pose.tag) this.keyPiece(iso(pose.pos.x, pose.pos.y, pose.pos.z + 1.5), 'blade', trip.outward ? 'key-share-out' : 'key-share-back');
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

  /** Where a small block is on its cables at v, if it is on one. */
  private blockAt(p: FlowPacket, v: number): Vec3 | null {
    const hop = p.hops.find((h) => v < h.t1);
    if (!hop || v < p.t0) return null;
    // Waiting its turn for this cable: still at the device before it.
    return this.onLane(hop, clamp01((v - hop.t0) / (hop.t1 - hop.t0)) * hop.fall);
  }

  /** A block a share k along a hop, on its own side of the cable: each way keeps right, like traffic on a road. */
  private onLane(hop: FlowHop, k: number): Vec3 {
    const at = travelPath(this.tl.pos, this.tl.trayZ, hop.from, hop.to, k, this.tl.sky.get(hop.link) ?? 0, this.tl.air.has(hop.link));
    const a = this.tl.pos.get(hop.from) ?? { x: 0, y: 0 };
    const b = this.tl.pos.get(hop.to) ?? { x: 0, y: 0 };
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const side = LANE * laneShare(k);
    return v3(at.x + (-(b.y - a.y) / len) * side, at.y + ((b.x - a.x) / len) * side, at.z);
  }

  /** Whose block this is, once several jobs run at once. */
  private ownerColor(client: string): string {
    if (this.story.attackers.includes(client)) return ATTACKER;
    return this.owners.get(client) ?? COLOR.app;
  }

  /** A stream: its packets as small blocks on the cables, far ones first. A part flies onto the sheet, a lost one falls. */
  private drawFlow(flow: FlowPacket[], waits: FlowWait[], v: number, traffic: boolean): void {
    for (const w of waits) if (v >= w.t0 && v < w.t1) this.drawWait(w.step, (v - w.t0) / (w.t1 - w.t0), w.t1 - w.t0);
    const blocks: { at: Vec3; size: number; color: string; op: number; named?: string | null }[] = [];
    // A block says nothing by itself: an ACK on its own says what it is, and so do the first few of a stream.
    const named = namedAcks(flow);
    for (const p of flow) {
      if (v < p.t0 || v >= p.t1) continue;
      const data = p.trip.dataBytes > 0;
      // A call has two sides: whoever answers it speaks in the friend's colour, in a crowd as much as alone.
      const answering = p.trip.chapter === 'call' && !p.trip.outward;
      const color = answering ? VOICE_OF_FRIEND : traffic ? this.ownerColor(p.trip.client) : this.story.voice ? (p.trip.outward ? VOICE_OF_CALLER : VOICE_OF_FRIEND) : !data ? COLOR.tcp : p.trip.locked ? LOCKED : COLOR.app;
      const size = data ? 0.9 : 0.5;
      const end = p.hops[p.hops.length - 1]!;
      const at = this.blockAt(p, v);
      if (at) {
        blocks.push({ at, size, color, op: 1, named: named.includes(p) ? (p.trip.message?.kind === 'mqtt-control' ? p.trip.card : 'ACK: got it') : null });
      } else if (end.lost) {
        const tau = v - end.t1;
        const at = this.onLane(end, end.fall);
        blocks.push({ at: v3(at.x, at.y, at.z - 5 * tau * tau), size, color, op: 1 - clamp01(tau / FLOW_FALL) });
      } else if (p.landed !== null && p.trip.part) {
        const q = easeInOut(clamp01((v - end.t1) / FLOW_FLY));
        const from = travelPath(this.tl.pos, this.tl.trayZ, end.from, end.to, 1);
        const to = this.paperSlot(p.trip.part.n, p.trip.part.of);
        blocks.push({ at: lerpV(from, to, q), size: size * (1 - 0.5 * q), color, op: 1 });
      }
    }
    blocks.sort((a, b) => a.at.x + a.at.y - b.at.x - b.at.y);
    for (const b of blocks) {
      const g = el('g', { opacity: b.op.toFixed(3) }, this.packet);
      box(g, { x: b.at.x - b.size / 2, y: b.at.y - b.size / 2, z: b.at.z, w: b.size, d: b.size, h: b.size * 0.6, color: b.color });
      if (b.named) {
        const c = iso(b.at.x, b.at.y, b.at.z + 1);
        el('text', { x: c.sx.toFixed(1), y: c.sy.toFixed(1), 'text-anchor': 'middle', class: 'ack-name' }, this.tags).textContent = b.named;
      }
    }
  }

  /** Anime impact: a jagged yellow star and speed lines bursting from the hit. */
  private burst(at: Vec3, tau: number): void {
    const T = 0.5;
    if (tau > T) return;
    const q = tau / T;
    const c = isoV(at);
    const g = el('g', { class: 'burst', opacity: (1 - easeIn(q)).toFixed(3), transform: `translate(${c.sx.toFixed(1)} ${c.sy.toFixed(1)})` }, this.fx);
    const r = 22 + 34 * easeOut(q);
    const pts: string[] = [];
    for (let j = 0; j < 20; j++) {
      const a = (j / 20) * Math.PI * 2 + 0.2;
      const rr = j % 2 ? r * 0.5 : r * (j % 4 ? 1 : 1.25);
      pts.push(`${(Math.cos(a) * rr).toFixed(1)},${(Math.sin(a) * rr).toFixed(1)}`);
    }
    el('polygon', { points: pts.join(' '), class: 'burst-star' }, g);
    for (let j = 0; j < 14; j++) {
      const a = (j / 14) * Math.PI * 2 + 0.11 * j;
      const r1 = r * 1.15 + 6;
      const r2 = r1 + 18 + 26 * easeOut(q) + (j % 3) * 6;
      el('line', { x1: Math.cos(a) * r1, y1: Math.sin(a) * r1, x2: Math.cos(a) * r2, y2: Math.sin(a) * r2, class: 'speed-line' }, g);
    }
  }

  /** The resender's timer above it: a ring that fills, then a surprised "!" (or a "✗" if it gives up). */
  private drawWait(step: WaitStep, k: number, dur: number): void {
    const d = this.tl.pos.get(step.device) ?? { x: 0, y: 0 };
    const c = iso(d.x, d.y, this.deviceTop(step.device) + 2.4);
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
    // Opened up, the box goes see-through, for a look at what travels inside it.
    const boxShut = !!boxFront && boxFront.p.f > 0.95 && Math.abs(boxFront.p.lift) < 0.05 && pose.chips < 0.01;
    const dir = { x: Math.cos(pose.angle), y: Math.sin(pose.angle) };
    const across = { x: -dir.y, y: dir.x };
    const at = (uu: number): Vec3 => v3(pos.x + dir.x * uu, pos.y + dir.y * uu, pos.z);
    const mid = (a: { u0: number; u1: number }): number => {
      const m = at((a.u0 + a.u1) / 2);
      return m.x + m.y;
    };
    const c = isoV(pos);
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
    for (const { p, u0: start, u1 } of [...placed].sort((m, n) => depth(m) - depth(n) || mid(m) - mid(n))) {
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
      const g = el('g', { opacity: (p.op * (isBox ? 1 - BOX_CLEAR * pose.chips : 1)).toFixed(3), class: `part part-${p.layer}` }, g0);
      rbox(g, { cx: centre.x, cy: centre.y, z, len: along, wid: d, h, angle: pose.angle, color });
      // Name printed on the long side facing the viewer, if there is room for it.
      if (isBox) {
        const top = iso(centre.x, centre.y, z + h);
        drawShield(el('g', { transform: `translate(${top.sx.toFixed(1)} ${(top.sy - 8).toFixed(1)}) scale(0.62)` }, g));
      }
      const label = p.key === 'card' ? this.cardText(trip) : p.key === 'ip' ? 'IP' : p.key === 'l4' ? trip.l4Label : p.key === 'vpn' && pose.chips < 0.5 ? 'VPN' : '';
      const font = p.key === 'card' ? cardFont(label) : 10;
      const onSide = label && p.f > 0.6 ? faceText(dir, v3(centre.x + side.x * (d / 2), centre.y + side.y * (d / 2), z + h / 2)) : null;
      if (label && onSide) {
        const fits = (s: string): boolean => along * U * onSide.ex > s.length * font * 0.62 + 4;
        // A name too long for its block stands in lines: SYN over ACK.
        const lines = fits(label) ? [label] : label.split('-');
        if (lines.every(fits)) {
          lines.forEach((line, i) => {
            const dy = 0.35 + (i - (lines.length - 1) / 2) * 1.05;
            const t = el('text', { class: p.key === 'card' ? 'face-label card-label' : 'face-label', 'text-anchor': 'middle', 'font-size': font, dy: `${dy.toFixed(2)}em`, transform: onSide.tf }, g);
            t.textContent = line;
          });
        }
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
    return iso(d.x + 1.7, d.y - 1.3, this.deviceTop(device) + 0.5);
  }

  /** One key: the same shape at both ends, because both ends worked out the same secret. Tip at the origin. */
  private keyShape(c: { sx: number; sy: number }, scale: number, turn: number): SVGGElement {
    const squeeze = Math.max(0.12, Math.cos((turn * Math.PI) / 2));
    const g = el('g', { class: 'key', transform: `translate(${c.sx.toFixed(1)} ${c.sy.toFixed(1)}) scale(${scale.toFixed(3)} ${(scale * squeeze).toFixed(3)})` }, this.keys);
    el('path', { d: KEY_BLADE, class: 'key-metal' }, g);
    el('circle', { cx: 38, cy: 0, r: 10, class: 'key-metal' }, g);
    el('circle', { cx: 40, cy: 0, r: 3.5, class: 'key-hole' }, g);
    return g;
  }

  /** A piece of the key: the bow an end keeps to itself, or the blade it sends. They are the key's own shapes. */
  private keyPiece(c: { sx: number; sy: number }, piece: 'bow' | 'blade', cls: string): void {
    const g = el('g', { class: `key ${cls}`, transform: `translate(${c.sx.toFixed(1)} ${c.sy.toFixed(1)})` }, this.keys);
    if (piece === 'blade') el('path', { d: KEY_BLADE, class: 'key-metal' }, g);
    else {
      el('circle', { cx: 38, cy: 0, r: 10, class: 'key-metal' }, g);
      el('circle', { cx: 40, cy: 0, r: 3.5, class: 'key-hole' }, g);
    }
  }

  /** Each end's key from the moment it has worked it out, popping up with a sparkle; the one at work flies to the lock. */
  private drawKeys(v: number, seg: Seg, lock: LockPose): void {
    const working = lock.key && 'device' in seg.step ? seg.step.device : null;
    for (const [device, t] of this.tl.halves) {
      const whole = this.tl.keys.get(device);
      if (v >= t && (whole === undefined || v < whole)) this.keyPiece(this.keyRest(device), 'bow', 'key-home');
    }
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
    // A piece the packet does not have (an ARP message has no IP or transport) is not there at all.
    const list = [
      mk('ethH', 'eth', frame.head, frame.head * L),
      ...(trip.tunnel ? [mk('vpn', 'vpn', trip.tunnel, trip.tunnel * L)] : []),
      ...(trip.header.ip ? [mk('ip', 'ip', trip.header.ip, trip.header.ip * L)] : []),
      ...(trip.header.l4 ? [mk('l4', 'l4', trip.header.l4, trip.header.l4 * L)] : []),
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
        const name = hidden ? '🔒' : p.key === 'card' ? (this.lock > 0.5 ? `🔒 ${this.cardText(trip)}`.trim() : this.cardText(trip)) : p.key === 'ethT' ? 'Error check' : p.key === 'l4' ? trip.l4Label : layerName(p.layer, trip, this.l2);
        // The trailer has no room for its size on a phone: opening it says what it holds.
        const text = `${p.key === 'ethT' ? name : `${name} · ${p.bytes} B`}${rows.length ? ' ▴' : ''}`;
        const c = p.key === 'card' && this.lock > 0.5 ? LOCKED : colorOf(p.layer, trip, this.l2);
        return { p, a: isoV(top), text, rows, c, w: text.length * 6.6 + 14, x: 0 };
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
    this.chipRow = { left: chips[0]!.x - chips[0]!.w / 2, right: x - 6 };
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

  /** A pill's fields, growing upwards out of the pill, with a last row that opens the bytes themselves. */
  private pillPanel(x: number, bottom: number, pillW: number, key: PartKey, color: string, rows: Row[], k: number): void {
    const ROW = 19;
    const h = (rows.length + 1) * ROW + 12;
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
    const y = -h + 6 + (rows.length + 0.5) * ROW;
    const bytes = el('g', { 'data-hex': key, class: 'pill-bytes' }, g);
    el('rect', { x: -w / 2 + 6, y: y - 8, width: w - 12, height: 16, rx: 8 }, bytes);
    el('text', { x: 0, y, dy: '0.35em', 'text-anchor': 'middle', class: 'pill-name' }, bytes).textContent = 'the bytes ▸';
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
      // The port changes too: it is how the router will know who the reply is for.
      old[step.which] = `${step.before}:${step.beforePort}`;
      a[step.which] = m.flip >= 0.5 ? `${step.after}:${step.afterPort}` : old[step.which];
    } else if ((step.kind === 'wrap' || step.kind === 'unwrap') && step.addr) {
      // Going into the VPN box the packet gets a whole new address label; coming out it has its old one again.
      changed = 'both';
      if (m.flip >= 0.5) Object.assign(a, step.addr);
    }
    const s = isoV(p);
    const pop = changed ? 1 + 0.75 * m.grow : 1;
    // The arrow says which way we're going: out from the asker, or back to it.
    const back = !seg.trip.outward;
    const g = el('g', { class: `addr ${back ? 'addr-back' : 'addr-out'}`, opacity: op.toFixed(3), transform: `translate(${s.sx.toFixed(1)} ${s.sy.toFixed(1)}) scale(${pop.toFixed(3)})` }, this.tags);
    const flash = el('g', {}, g);
    // With a VPN the numbers alone don't say much: name who they belong to.
    const caption = (word: string, addr: string): string => {
      const name = this.story.names[addr.split(':')[0]!];
      return this.story.vpn && name ? `${word} ${name}` : `${word} ip`;
    };
    const fromCap = caption('from', a.from);
    const toCap = caption('to', a.to);
    const fromW = Math.max(a.from.length * 7.2, fromCap.length * 6.6);
    const toW = Math.max(a.to.length * 7.2, toCap.length * 6.6);
    const width = fromW + toW + 44;
    // Small "from ip" / "to ip" captions sit above the addresses; the numbers sit on the lower line.
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
    // A few sparkles around the fresh label, or around the whole tag when both change.
    if (changed && m.stamp > 0 && m.stamp < 1) {
      const x = changed === 'both' ? 0 : changed === 'from' ? -width / 2 + 10 + fromW / 2 : width / 2 - 10 - toW / 2;
      this.freshLabel(g, x, changed === 'both' ? 0 : NUM_Y, changed === 'both' ? width : changed === 'from' ? fromW : toW, m.stamp);
    }
  }

  /** The fresh label settling: a few sparkles spreading out from it. Routine work, not an accident. */
  private freshLabel(parent: SVGGElement, x: number, y: number, w: number, q: number): void {
    const g = el('g', { opacity: (1 - easeIn(q)).toFixed(3), transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` }, parent);
    const size = 7 * Math.sin(Math.min(1, q * 1.4) * Math.PI);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.5;
      const sx = Math.cos(a) * (w / 2 + 16 + 14 * q);
      const sy = Math.sin(a) * (26 + 16 * q);
      el('path', { d: `M0 ${-size} Q0 0 ${size} 0 Q0 0 0 ${size} Q0 0 ${-size} 0 Q0 0 0 ${-size}Z`, class: 'swap-spark', transform: `translate(${sx.toFixed(1)} ${sy.toFixed(1)})` }, g);
    }
  }
}


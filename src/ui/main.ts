import './app.css';
import { fetchWebPage, runScenario, ulawDecodeAll, type Cut, type Job, type ManualFault } from '../sim';
import { el } from './svg';
import { clamp01, easeInOut, easeOutBack, iso, ISO_X, ISO_Y, lerp, U } from './project';
import { HexCard } from './hexCard';
import { drawHandset, drawHush, drawPadlock, drawPage, drawPing, drawPipe, drawQuestion, drawSatellite, drawScissors, drawShield, drawSnowflake, drawSpyglass, drawTag, drawTrace } from './icons';
import { Menu } from './menus';
import { NetworkScene, type Camera } from './NetworkScene';
import { Sound } from './sound';
import { SpyCard } from './spyCard';
import { buildStory, type Chapter, type PartKey, type Story } from './story';
import { buildTimeline, chapterAt, formatWait, joinAt, MAX_STRETCH, pduAt, realAt, ridingOn, seenSoFar, segAt, spyLog, stepTarget, wanDelayFor, type Timeline } from './timeline';

/**
 * "Get example.com". Drag the site card onto the laptop or the phone. The bar below holds the playback buttons, and
 * popups for the speed, the tools you click lines with, and the setup of the next run.
 * Tap a packet to pop it open. When a run ends the card comes back. During a run the cards wait down the side of the
 * screen: drag one onto the other device and it joins in.
 */

/** Seconds the finished picture stays before the card comes back. */
const LINGER = 1.4;
/** Seconds after the start of a step in which back goes to the step before it. */
const BACK_GRACE = 1;

/** What the next run is like, set from the Setup menu between runs: changing it mid-run would rewrite what happened. */
type Setting = 'https' | 'big' | 'slow' | 'vpn' | 'arp' | 'dhcp' | 'cold' | 'thin' | 'quiet';
type Features = Record<Setting, boolean>;
const SETTINGS: Setting[] = ['https', 'big', 'slow', 'vpn', 'arp', 'dhcp', 'cold', 'thin', 'quiet'];
const features: Features = { https: false, big: false, slow: false, vpn: false, arp: false, dhcp: false, cold: false, thin: false, quiet: false };
/** The line the spyglass is on, if any. */
let spyLine: string | null = null;
/** The visual time it was put there: it can only read what passes from then on. */
let spyFrom = -Infinity;
/** The cables that are cut. They can change any time, before or during a run. */
const cutLines = new Set<string>();
// Only the Setup is remembered across visits: a cable left cut or a spyglass left out would make the next visit fail for no visible reason.
try {
  const saved = JSON.parse(localStorage.getItem('net.features') ?? '{}') as Partial<Features>;
  for (const k of SETTINGS) features[k] = !!saved[k];
} catch {
  // Nothing remembered; start plain.
}
function remember(): void {
  try {
    localStorage.setItem('net.features', JSON.stringify(features));
  } catch {
    // Not remembered; fine.
  }
}
/** Packets that fell when their cable was cut, and how far along it they were (only for drawing the fall). */
const faults: ManualFault[] = [];
const knocks = new Map<string, number>();
/** Each run gets its own seed; cutting a cable re-runs with the same one. */
let runSeed = 1;
/** What the viewer has already seen happen in this run. */
let decided: Record<string, boolean> = {};
/** When (sim time) cables were cut during this run. */
let cuts: Cut[] = [];
/** A cable was already cut at the start of the run, so the ARP that would not get through is left out of it. */
let warmArp = false;
let story: Story;
let tl: Timeline;
type Client = 'laptop' | 'phone';
/** Which device the card was dropped on: the laptop (Ethernet cable) or the phone (Wi-Fi). */
let client: Client = 'laptop';
/** What each device still remembers from an earlier visit, until the DNS record's real TTL runs out. */
const known = new Map<string, { site: string; ip: string; until: number }>();
/** This run is a second visit: the address is remembered, so there is nothing to look up. */
let revisit = false;
/** What a card on the table asks for: the page, or the photo. */
type Wanted = Job;
const WANTED: Wanted[] = ['page', 'photo', 'call', 'ping', 'trace'];
const isProbe = (w: Wanted): boolean => w === 'ping' || w === 'trace';
/** The card picked up last. */
let carried: Wanted = 'page';
const pageSite = (): 'info.cern.ch' | 'example.com' => (features.big ? 'info.cern.ch' : 'example.com');
const siteName = (): 'info.cern.ch' | 'example.com' | 'httpbin.org' => (carried === 'photo' ? 'httpbin.org' : pageSite());
/** The name the device will look up: a site, the friend to call, or the server a ping or trace goes to. */
const wantedName = (): string => (carried === 'call' ? 'sam.example' : isProbe(carried) ? 'example.com' : siteName());
function remembers(): boolean {
  const k = known.get(client);
  return !!k && k.site === wantedName() && performance.now() < k.until;
}
/** How far the ISP router has been dragged away, in tiles: the fibre gets longer and so does its delay. */
let stretch = 0;
/** The Wi-Fi has been shaken: this share of its frames is lost to interference, and the radio sends them again. */
let noise = 0;
const NOISY = 0.4;
/** A card dropped in during this run: what it asks for, and when in sim time and in visual time. */
let joined: { job: Wanted; at: number; v: number } | null = null;
function simulate(): void {
  const scenario = fetchWebPage({
    // A ping or a trace goes to example.com's server, whatever page the Setup would fetch.
    site: isProbe(carried) ? 'example.com' : siteName(),
    ...(carried === 'ping' ? { probe: 'ping' as const } : carried === 'trace' ? { probe: 'traceroute' as const } : {}),
    revisit,
    slow: features.slow,
    vpn: features.vpn,
    https: features.https,
    from: client,
    warmArp,
    ...(joined ? { join: { job: joined.job, at: joined.at } } : {}),
    dhcp: features.dhcp,
    cold: features.cold,
    thin: features.thin,
    call: carried === 'call',
    ...(stretch > 0 ? { wanDelay: wanDelayFor(stretch) } : {}),
    ...(noise > 0 ? { noise } : {}),
  });
  const plan = { randomLoss: 0, decided, cuts, manual: faults };
  // Long enough for TCP to give up on a dead line (15 resends, backing off to a minute apart).
  story = buildStory(runScenario(scenario, { seed: runSeed, faults: plan, maxTime: 1000 }), { arp: features.arp });
  tl = buildTimeline(story, knocks, stretch, joined?.v);
}
simulate();

const root = document.querySelector<HTMLElement>('#app')!;
root.className = 'net';
const scene = new NetworkScene(root, story!, tl!);
scene.setRemembered(known);
const svg = scene.svg;
const sound = new Sound();
try {
  sound.muted = localStorage.getItem('net.muted') === '1';
} catch {
  // Storage can be blocked; sound simply starts on.
}

type Mode = 'idle' | 'drag' | 'spring' | 'drop' | 'play' | 'return';
let mode: Mode = 'idle';

// The site card rests on the table between the laptop and the phone.
const home = iso(0, 7.4, 0.5);
const HOMES: Record<Wanted, { sx: number; sy: number }> = {
  page: home,
  photo: { sx: home.sx, sy: home.sy + 62 },
  call: { sx: home.sx, sy: home.sy + 124 },
  ping: { sx: home.sx, sy: home.sy + 186 },
  trace: { sx: home.sx, sy: home.sy + 248 },
};
// Above the stack, as it goes for every card in it. The first card's badges stick out above it, so this clears them.
const hint = el('text', { class: 'cards-hint', 'text-anchor': 'middle', x: home.sx, y: home.sy - 46 }, svg);
hint.textContent = 'drag a card onto a device';
const card = el('g', { class: 'site-card' }, svg);
const cardBody = el('g', {}, card);
el('rect', { x: -88, y: -22, width: 176, height: 44, rx: 10, class: 'site-card-bg' }, cardBody);
el('circle', { cx: -66, cy: 0, r: 9, class: 'site-card-globe' }, cardBody);
el('ellipse', { cx: -66, cy: 0, rx: 4, ry: 9, class: 'site-card-globe' }, cardBody);
const cardText = el('text', { x: 12, y: 0, dy: '0.35em', 'text-anchor': 'middle' }, cardBody);
cardText.textContent = 'example.com';
let cardPop = 9;
/** Small badges on the card for what is set up. */
const cardBadges = el('g', {}, card);

// The photo card: the same kind of card, with a little picture on it.
const photoCard = el('g', { class: 'site-card' }, svg);
const photoBody = el('g', {}, photoCard);
el('rect', { x: -88, y: -22, width: 176, height: 44, rx: 10, class: 'site-card-bg' }, photoBody);
el('rect', { x: -77, y: -10, width: 24, height: 20, rx: 2, class: 'site-card-globe' }, photoBody);
el('path', { d: 'M-75 7l7-8 5 5 3-3 5 6', class: 'site-card-globe' }, photoBody);
el('text', { x: 12, y: 0, dy: '0.35em', 'text-anchor': 'middle' }, photoBody).textContent = 'photo.jpg';
const photoBadges = el('g', {}, photoCard);

// The call card: a handset, and the friend's name.
const callCard = el('g', { class: 'site-card' }, svg);
const callBody = el('g', {}, callCard);
el('rect', { x: -88, y: -22, width: 176, height: 44, rx: 10, class: 'site-card-bg' }, callBody);
drawHandset(el('g', { transform: 'translate(-66 0) scale(0.42)', class: 'site-card-globe' }, callBody));
el('text', { x: 12, y: 0, dy: '0.35em', 'text-anchor': 'middle' }, callBody).textContent = 'call Sam';
const callBadges = el('g', {}, callCard);

// Two small tools as cards too: a ping, and a trace of the path.
const toolCard = (text: string, draw: (g: SVGGElement) => void): SVGGElement => {
  const c = el('g', { class: 'site-card' }, svg);
  const body = el('g', {}, c);
  el('rect', { x: -88, y: -22, width: 176, height: 44, rx: 10, class: 'site-card-bg' }, body);
  draw(el('g', { transform: 'translate(-66 0) scale(0.42)', class: 'site-card-globe' }, body));
  el('text', { x: 12, y: 0, dy: '0.35em', 'text-anchor': 'middle' }, body).textContent = text;
  return c;
};
const CARDS: Record<Wanted, SVGGElement> = { page: card, photo: photoCard, call: callCard, ping: toolCard('ping', drawPing), trace: toolCard('trace route', drawTrace) };

scene.setOnTable([home, { sx: home.sx - 110, sy: home.sy + 50 }, { sx: home.sx + 110, sy: home.sy - 40 }, { sx: HOMES.trace.sx - 110, sy: HOMES.trace.sy + 50 }]);

/** A setting changed before a run: show the network it will use, with a clean screen. */
function preview(): void {
  remember();
  joined = null;
  idleV = -1;
  revisit = remembers();
  simulate();
  scene.setStory(story, tl);
  showFeatures();
}

function showFeatures(): void {
  const site = pageSite();
  if (cardText.textContent !== site) {
    cardText.textContent = site;
    cardPop = 0;
  }
  for (const [badges, skip] of [[cardBadges, null], [photoBadges, 'big'], [callBadges, 'big']] as const) {
    badges.replaceChildren();
    // Quiet devices change nothing about the run, so the card has nothing to say about it.
    SETUP.filter((s) => features[s.id] && s.id !== skip && s.id !== 'quiet').forEach((s, i) => {
      const g = el('g', { transform: `translate(${72 - i * 30} -24)` }, badges);
      el('circle', { r: 13, class: 'card-badge' }, g);
      s.draw(el('g', { transform: `scale(${(14 / s.span).toFixed(3)})` }, g));
    });
  }
}

/** Distance from a point to a link's path on screen. */
function toLink(p: { sx: number; sy: number }, link: string): number {
  const path = scene.linkPath(link);
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const dx = b.sx - a.sx;
    const dy = b.sy - a.sy;
    const t = clamp01(((p.sx - a.sx) * dx + (p.sy - a.sy) * dy) / (dx * dx + dy * dy || 1));
    best = Math.min(best, Math.hypot(p.sx - (a.sx + dx * t), p.sy - (a.sy + dy * t)));
  }
  return best;
}
/** The line near a point, if any; only the cables, for tools that need one. */
function lineNear(p: { sx: number; sy: number }, cablesOnly: boolean, reach: number): string | null {
  let best: string | null = null;
  let bestD = reach;
  for (const l of story.links) {
    if (!scene.hasLink(l.id)) continue;
    if (cablesOnly && (l.medium !== 'cable' || tl.sky.has(l.id))) continue;
    const d = toLink(p, l.id);
    if (d < bestD) {
      best = l.id;
      bestD = d;
    }
  }
  return best;
}
const canSetUp = (): boolean => mode === 'idle' || mode === 'spring';

/** Cut a cable, or mend it. It works mid-run too: the simulation re-runs from this moment on, what was seen stays, and whatever is on that cable right now falls in. */
function toggleCut(line: string): void {
  const on = !cutLines.has(line);
  if (on) cutLines.add(line);
  else cutLines.delete(line);
  if (mode === 'play') {
    // A step under way was aimed at the old timeline.
    seek = null;
    for (const r of on ? ridingOn(tl, v, line) : []) {
      faults.push({ packetId: r.packetId, linkId: line });
      knocks.set(`${r.packetId}@${line}`, r.k);
    }
    const seen = seenSoFar(tl, v, line);
    decided = { ...decided, ...seen.decided };
    cuts = cuts.map((c) => (c.to === undefined && c.link === line ? { ...c, to: seen.now } : c));
    if (on) cuts = [...cuts, { link: line, from: seen.now }];
    simulate();
    scene.setStory(story, tl);
  }
  scene.setCut([...cutLines]);
  sound.play(on ? 'snip' : 'snap');
}

/** Take a line back to normal. */
function clearLine(line: string): void {
  if (cutLines.has(line)) toggleCut(line);
}

let cam: Camera = scene.overviewCamera();

/** Tools come from the Tools menu: pick one, click as many lines as you like, click a line again to undo it. */
type Tool = 'spy' | 'cut';
let tool: Tool | null = null;

/** Put the spyglass on a line, or take it off. It only reads, so nothing about the run changes. */
function setSpyLine(line: string | null): void {
  if (line === spyLine) return;
  spyLine = line;
  spyFrom = mode === 'play' ? v : idleV;
  scene.setSpy(line);
  spyCard.reset();
  sound.play('snap');
}
const USE: Record<Tool, (line: string) => void> = { spy: (l) => setSpyLine(spyLine === l ? null : l), cut: toggleCut };
function pickUp(t: Tool | null): void {
  tool = t;
  for (const id of ['spy', 'cut'] as const) {
    toolsMenu.setOn(id, t === id);
    svg.classList.toggle(`tool-${id}`, t === id);
  }
  toolsMenu.button.classList.toggle('on', !!t);
  scene.setHover(null);
}
/** The line under the pointer that the tool in hand can work on. Radio cannot be cut. */
const toolLine = (e: PointerEvent): string | null => lineNear(toSvg(e), tool === 'cut', 26 / cam.scale);
scene.setSpy(spyLine);
scene.setCut([...cutLines]);

const VPN_LINKS = ['bb3', 'bb4', 'bb5'];
const SETUP: { id: Setting; label: string; hint: string; draw: (g: SVGGElement) => void; span: number }[] = [
  { id: 'https', label: 'Secure page (HTTPS)', hint: 'Scrambles everything after hello', draw: drawPadlock, span: 34 },
  { id: 'big', label: 'Bigger page', hint: 'Too big for one packet', draw: drawPage, span: 34 },
  { id: 'slow', label: 'Satellite internet', hint: 'To space and back: long waits', draw: drawSatellite, span: 56 },
  { id: 'vpn', label: 'VPN', hint: 'Sealed tunnel past your ISP', draw: drawShield, span: 34 },
  { id: 'arp', label: 'Find the router first', hint: 'Shouts for its hardware address', draw: drawQuestion, span: 34 },
  { id: 'dhcp', label: 'New on the network', hint: 'Asks for an address first', draw: drawTag, span: 34 },
  { id: 'cold', label: "DNS doesn't know it yet", hint: 'Must ask around for the name', draw: drawSnowflake, span: 34 },
  { id: 'thin', label: 'Slow home line', hint: 'Big downloads lose packets', draw: drawPipe, span: 34 },
  { id: 'quiet', label: 'Quiet devices', hint: 'No speech bubbles', draw: drawHush, span: 34 },
];
function setSetting(id: Setting, on: boolean): void {
  features[id] = on;
  // The line to the ISP becomes radio, which cannot be cut.
  if (id === 'slow' && on && cutLines.has('wan')) toggleCut('wan');
  // The VPN's cables go with it.
  if (id === 'vpn' && !on) {
    for (const l of VPN_LINKS) clearLine(l);
    if (spyLine && VPN_LINKS.includes(spyLine)) setSpyLine(null);
  }
  showSetup();
  preview();
  sound.play(id === 'https' || id === 'vpn' ? 'lock' : 'snap');
}
/** The Setup menu says what is on, also for what was remembered from last time. */
function showSetup(): void {
  for (const k of SETTINGS) setupMenu.setOn(k, features[k]);
  setupMenu.button.classList.toggle('on', SETTINGS.some((k) => features[k]));
  scene.setQuiet(features.quiet);
}

const CHAPTERS: Record<Chapter, string> = { address: 'Get an address', arp: 'Find the router', dns: 'Find the address', hello: 'Say hello', secret: 'Check and agree', page: 'Get the page', call: 'Make a call', ping: 'Ping the server', trace: 'Trace the path', traffic: 'All at once' };
/** Chapter number in this run (a second visit skips the address, HTTPS adds the secret). */
const chapterName = (ch: Chapter): string => (ch === 'page' && story.image ? 'Get the photo' : CHAPTERS[ch]);

function chapterNumber(ch: Chapter): number {
  const order: Chapter[] = [];
  for (const s of tl.segs) if (!order.includes(s.trip.chapter)) order.push(s.trip.chapter);
  return order.indexOf(ch) + 1;
}
const chapter = document.createElement('button');
chapter.className = 'chapter';
chapter.hidden = true;
chapter.setAttribute('aria-haspopup', 'true');
chapter.setAttribute('aria-expanded', 'false');
root.appendChild(chapter);
let shownChapter: Chapter | null = null;

// Tap the chapter label to jump to any chapter of this run.
const chapterMenu = document.createElement('div');
chapterMenu.className = 'chapter-menu';
chapterMenu.hidden = true;
root.appendChild(chapterMenu);
/** The list's items by chapter, so the current one can be marked as the run moves on. */
const chapterItems = new Map<Chapter, HTMLButtonElement>();
function showChapterMenu(open: boolean): void {
  chapterMenu.hidden = !open;
  chapter.setAttribute('aria-expanded', String(open));
}
chapter.addEventListener('click', () => {
  if (!chapterMenu.hidden) {
    showChapterMenu(false);
    return;
  }
  chapterMenu.replaceChildren();
  chapterItems.clear();
  for (const s of tl.segs) {
    const ch = s.trip.chapter;
    if (chapterItems.has(ch)) continue;
    const item = document.createElement('button');
    item.innerHTML = `<span class="chapter-num">${chapterNumber(ch)}</span><span>${chapterName(ch)}</span>`;
    item.classList.toggle('current', ch === shownChapter);
    item.addEventListener('click', () => {
      // Jumping keeps the viewer's pause: they land at the chapter's start, playing or not as before.
      v = s.t0;
      seek = null;
      peek = peekTarget = 0;
      camFree = false;
      showChapterMenu(false);
    });
    chapterItems.set(ch, item);
    chapterMenu.appendChild(item);
  }
  showChapterMenu(true);
});

const controls = document.createElement('div');
controls.className = 'net-controls';
const button = (text: string, label: string, onClick: () => void): HTMLButtonElement => {
  const b = document.createElement('button');
  b.textContent = text;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  controls.appendChild(b);
  return b;
};
const backBtn = button('⏮', 'Step back', () => step(-1));
const pauseBtn = button('', 'Pause', togglePause);
const nextBtn = button('⏭', 'Step forward', () => step(1));
// 0.25× is for a stream: slow enough to see the window of packets go out and the ACKs let the next ones out.
const SPEEDS = ['0.25', '0.5', '1', '2'];
const speedMenu = new Menu<string>(controls, root, '1×', 'Speed', SPEEDS.map((id) => ({ id, label: `${id}×` })), (id) => {
  speed = Number(id);
  speedMenu.button.textContent = `${id}×`;
  for (const x of SPEEDS) speedMenu.setOn(x, x === id);
  speedMenu.setOpen(false);
});
speedMenu.setOn('1', true);
const toolsMenu = new Menu<Tool>(
  controls,
  root,
  'Tools',
  'Tools',
  [
    { id: 'spy', label: 'Spy', draw: drawSpyglass, span: 36 },
    { id: 'cut', label: 'Cut', draw: drawScissors, span: 38 },
  ],
  (id) => pickUp(tool === id ? null : id),
);
// Closing Tools by its own button puts the tool down. Another popup only hides it: the tool stays in hand.
toolsMenu.button.addEventListener('click', () => {
  if (!toolsMenu.isOpen) pickUp(null);
});
const setupMenu = new Menu<Setting>(controls, root, 'Setup', 'Setup', SETUP, (id) => setSetting(id, !features[id]));
showSetup();
const menus: { isOpen: boolean; setOpen(open: boolean): void; place(): void; button: HTMLButtonElement }[] = [speedMenu, toolsMenu, setupMenu];
for (const menu of menus) {
  menu.button.addEventListener('click', () => {
    for (const other of menus) if (other !== menu) other.setOpen(false);
    showChapterMenu(false);
  });
}
const placeMenus = (): void => {
  for (const menu of menus) menu.place();
  spyCard.place(controls);
};
const soundBtn = button('♪', 'Mute', () => {
  sound.muted = !sound.muted;
  try {
    localStorage.setItem('net.muted', sound.muted ? '1' : '0');
  } catch {
    // Not remembered; fine.
  }
});
button('↺', 'Reset', reset);
// On a narrow screen the bar breaks into two rows here (see app.css).
controls.appendChild(Object.assign(document.createElement('span'), { className: 'bar-break' }));
root.appendChild(controls);

/** How close to a device, in screen pixels, a card from the dock has to come. */
const DOCK_REACH = 70;
const DOCK_ICONS: Record<Wanted, { name: string; draw: (g: SVGGElement) => void }> = {
  page: {
    name: 'the page',
    draw: (g) => {
      el('circle', { r: 9 }, g);
      el('ellipse', { rx: 4, ry: 9 }, g);
    },
  },
  photo: {
    name: 'the photo',
    draw: (g) => {
      el('rect', { x: -12, y: -10, width: 24, height: 20, rx: 2 }, g);
      el('path', { d: 'M-10 7l7-8 5 5 3-3 5 6' }, g);
    },
  },
  call: { name: 'a call', draw: (g) => drawHandset(el('g', { transform: 'scale(0.42)' }, g)) },
  ping: { name: 'a ping', draw: (g) => drawPing(el('g', { transform: 'scale(0.42)' }, g)) },
  trace: { name: 'a trace', draw: (g) => drawTrace(el('g', { transform: 'scale(0.42)' }, g)) },
};
const dockIcon = (w: Wanted): SVGSVGElement => {
  const icon = el('svg', { viewBox: '-16 -16 32 32', width: 30, height: 30, 'aria-hidden': 'true' });
  DOCK_ICONS[w].draw(el('g', { class: 'site-card-globe' }, icon));
  return icon;
};
/** A card from the dock, in hand. */
let holding: { wanted: Wanted; x: number; y: number } | null = null;
const dock = document.createElement('div');
dock.className = 'dock';
dock.hidden = true;
dock.appendChild(Object.assign(document.createElement('span'), { className: 'dock-label', textContent: 'drag one in' }));
/** The card under the finger, and the ring on the device it can go to. */
const dockGhost = document.createElement('div');
dockGhost.className = 'dock-ghost';
const dockRing = document.createElement('div');
dockRing.className = 'dock-ring';
dockGhost.hidden = dockRing.hidden = true;
root.append(dock, dockRing, dockGhost);

/** Where the device that has nothing to do is on screen. */
function freeSpot(): { x: number; y: number } | null {
  const free = scene.dropPoints().find((d) => d.id !== client);
  const m = svg.getScreenCTM();
  if (!free || !m) return null;
  const p = new DOMPoint(free.sx, free.sy).matrixTransform(m);
  return { x: p.x, y: p.y };
}
const overFree = (): boolean => {
  const spot = freeSpot();
  return !!holding && !!spot && Math.hypot(holding.x - spot.x, holding.y - spot.y) < DOCK_REACH;
};

/** The other device starts on this job now: what has been shown stays, and from the next step on everything runs at once. */
function joinIn(job: Wanted): void {
  const seen = seenSoFar(tl, v);
  decided = { ...decided, ...seen.decided };
  joined = { job, at: joinAt(tl, v), v };
  // A device joining in looks everything up afresh: it remembers nothing from before.
  known.delete(client === 'laptop' ? 'phone' : 'laptop');
  seek = null;
  simulate();
  scene.setStory(story, tl);
  sound.play('pop');
}

for (const w of WANTED) {
  const b = document.createElement('button');
  b.className = 'dock-card';
  b.setAttribute('aria-label', `Drag ${DOCK_ICONS[w].name} onto the other device`);
  b.appendChild(dockIcon(w));
  const letGo = (): void => {
    if (!holding) return;
    const landed = overFree() && mode === 'play' && !joined;
    holding = null;
    if (landed) joinIn(w);
  };
  b.addEventListener('pointerdown', (e) => {
    holding = { wanted: w, x: e.clientX, y: e.clientY };
    b.setPointerCapture(e.pointerId);
    dockGhost.replaceChildren(dockIcon(w));
  });
  b.addEventListener('pointermove', (e) => {
    if (holding) holding = { ...holding, x: e.clientX, y: e.clientY };
  });
  b.addEventListener('pointerup', letGo);
  b.addEventListener('pointercancel', letGo);
  b.addEventListener('lostpointercapture', letGo);
  dock.appendChild(b);
}

// Outside the bar, so the bar never moves.
const followBtn = document.createElement('button');
followBtn.className = 'follow';
followBtn.setAttribute('aria-label', 'Follow the packet');
followBtn.addEventListener('click', () => {
  camFree = false;
  showAll = mode !== 'play';
});
root.appendChild(followBtn);
const spyCard = new SpyCard(root, () => setSpyLine(null));
const hexCard = new HexCard(root, () => hexCard.hide());
// The animation takes its time so you can watch; this says how long it really took.
const realClock = document.createElement('div');
realClock.className = 'real-clock';
realClock.hidden = true;
root.appendChild(realClock);
// A popup only has to move when the bar does.
new ResizeObserver(placeMenus).observe(controls);
window.addEventListener('resize', placeMenus);

let v = 0;
/** What the table shows between runs: the end of the last run, or a clean table (-1). */
let idleV = -1;
let paused = false;
let speed = 1;
/** A step button playing the animation through at high speed, playing or paused. */
let seek: { from: number; to: number; t: number; dur: number } | null = null;
/** Seconds since the run reached its end. */
let doneFor = 0;
let peek = 0;
let peekTarget = 0;
/** The pill opened on a popped-open packet, and how far. */
let pill: PartKey | null = null;
let pillOpen = 0;
let pillTarget = 0;
let cardPos = { ...home };
let anim = { from: { ...home }, to: { ...home }, t: 0, dur: 0.4 };
let grab = { dx: 0, dy: 0 };
cam = scene.overviewCamera();
let snapCamera = false;
/** Set once the viewer pans or zooms by hand; the camera stops following until they ask again. */
let camFree = false;
/** "Show all" was pressed: between runs the camera keeps the whole network in view until the next run. */
let showAll = false;
revisit = remembers();
showFeatures();
cardPop = 9;

function toSvg(e: PointerEvent): { sx: number; sy: number } {
  const m = svg.getScreenCTM();
  if (!m) return { sx: 0, sy: 0 };
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  return { sx: p.x, sy: p.y };
}

for (const wanted of WANTED) {
  const g = CARDS[wanted];
  g.addEventListener('pointerdown', (e) => {
    if (mode !== 'idle' && mode !== 'spring') return;
    // A card still springing back lands at once, so the other one can be picked up.
    if (wanted !== carried) {
      carried = wanted;
      cardPos = { ...HOMES[wanted] };
    }
    const p = toSvg(e);
    grab = { dx: cardPos.sx - p.sx, dy: cardPos.sy - p.sy };
    mode = 'drag';
    g.setPointerCapture(e.pointerId);
    g.classList.add('held');
  });
  g.addEventListener('pointermove', (e) => {
    if (mode !== 'drag') return;
    const p = toSvg(e);
    cardPos = { sx: p.sx + grab.dx, sy: p.sy + grab.dy };
    g.classList.toggle('over', !!dropTarget());
  });
  g.addEventListener('pointerup', dropCard);
  // A drag the browser takes over (a second finger, a palm, leaving the page) still puts the card down.
  g.addEventListener('pointercancel', dropCard);
  g.addEventListener('lostpointercapture', dropCard);
}

/** The laptop or phone the card is over, if any. */
function dropTarget(): { id: string; sx: number; sy: number } | null {
  let best: { id: string; sx: number; sy: number } | null = null;
  let bestD = 85;
  for (const d of scene.dropPoints()) {
    const dist = Math.hypot(cardPos.sx - d.sx, cardPos.sy - d.sy);
    if (dist < bestD) {
      best = d;
      bestD = dist;
    }
  }
  return best;
}
function dropCard(): void {
  if (mode !== 'drag') return;
  CARDS[carried].classList.remove('held', 'over');
  const drop = dropTarget();
  if (drop) client = drop.id === 'phone' ? 'phone' : 'laptop';
  anim = { from: { ...cardPos }, to: drop ?? { ...HOMES[carried] }, t: 0, dur: drop ? 0.35 : 0.5 };
  mode = drop ? 'drop' : 'spring';
  if (drop) {
    camFree = false;
    sound.play('pop');
  }
}

// Tap a packet to pop it open.
scene.packet.addEventListener('pointerdown', () => {
  if (tool || mode !== 'play' || v >= tl.total) return;
  if (scene.peekable(v)) peekTarget = peekTarget ? 0 : 1;
});

// Pan and zoom by hand: drag the stage, pinch, or use the wheel. Any of these lets go of the follow camera.
const pointers = new Map<number, { x: number; y: number }>();
/** A press on a device's screen between runs, which is a "forget" if it does not turn into a drag. */
let screenPress: { device: string; x: number; y: number } | null = null;
/** A press with a tool in hand: a click on a line if it does not turn into a drag. */
let toolPress: { x: number; y: number } | null = null;
/** A press on the table: it only takes the view over once it really moves. */
let panPress: { x: number; y: number } | null = null;
/** A press on the Wi-Fi arc between runs: it shakes the radio if it does not turn into a drag. */
let airPress: { x: number; y: number } | null = null;
/** A press on the ISP router between runs: along its cable it stretches the fibre, any other way it pans. */
let grabPress: { x: number; y: number } | null = null;
/** The ISP router being dragged along its cable, from where. */
let stretchPress: { x: number; y: number; from: number } | null = null;
/** How closely a drag must follow the cable to stretch it (the cosine of the angle between them). */
const ALONG_CABLE = 0.9;
/** A drag along the cable to the ISP (+x, right and down on screen), in screen pixels. */
const alongCable = (dx: number, dy: number): number => dx * ISO_X + dy * ISO_Y;

function zoomAt(clientX: number, clientY: number, factor: number): void {
  const r = svg.getBoundingClientRect();
  const ox = clientX - r.left - r.width / 2;
  const oy = clientY - r.top - r.height / 2;
  const px = cam.cx + ox / cam.scale;
  const py = cam.cy + oy / cam.scale;
  const { min, max } = scene.scaleLimits();
  const scale = Math.min(max, Math.max(min, cam.scale * factor));
  cam = { cx: px - ox / scale, cy: py - oy / scale, scale };
}

function spread(): { d: number; x: number; y: number } {
  const [a, b] = [...pointers.values()];
  if (!a || !b) return { d: 1, x: a?.x ?? 0, y: a?.y ?? 0 };
  return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

svg.addEventListener('pointerdown', (e) => {
  // The first finger of a new touch: any other still listed lost its pointerup, and would turn every drag into a pinch.
  if (e.isPrimary) pointers.clear();
  // Working the stage leaves the Tools menu open while a tool is in hand; the other popups give way to it.
  for (const menu of menus) if (menu !== toolsMenu || !tool) menu.setOpen(false);
  showChapterMenu(false);
  const target = e.target as Element;
  // The last row of an open pill: the bytes themselves.
  const hex = target.closest('[data-hex]')?.getAttribute('data-hex') as PartKey | undefined;
  if (hex) {
    const hit = segAt(tl, v);
    const pdu = hit && pduAt(hit.seg, hit.k);
    if (pdu) hexCard.show(pdu, hex);
    sound.play('snap');
    return;
  }
  const chip = target.closest('[data-chip]')?.getAttribute('data-chip') as PartKey | undefined;
  if (chip) {
    pillTarget = pill === chip && pillTarget ? 0 : 1;
    if (pill !== chip) pillOpen = 0;
    pill = chip;
    sound.play('snap');
    return;
  }
  if (target.closest('.site-card') || (!tool && target.closest('.packet'))) return;
  // One finger only: a second one down means a pinch, whatever the first was on.
  const onTable = !tool && canSetUp() && e.isPrimary;
  // A tap on the Wi-Fi arc between runs shakes it: noisy, or calm again. A drag from there pans, like anywhere else.
  airPress = onTable && target.closest('[data-air]') ? { x: e.clientX, y: e.clientY } : null;
  // The ISP router can be dragged further away between runs: the fibre to it gets longer.
  grabPress = onTable && target.closest('[data-grab]') ? { x: e.clientX, y: e.clientY } : null;
  toolPress = tool ? { x: e.clientX, y: e.clientY } : null;
  const device = target.closest('[data-device]')?.getAttribute('data-device');
  screenPress = device && mode === 'idle' && known.has(device) ? { device, x: e.clientX, y: e.clientY } : null;
  // Listed only once captured: a finger that cannot be followed must not stay listed as down.
  svg.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  panPress = !screenPress && !toolPress ? { x: e.clientX, y: e.clientY } : null;
  svg.classList.add('panning');
});
svg.addEventListener('pointermove', (e) => {
  if (tool) scene.setHover(toolLine(e));
  if (grabPress) {
    const dx = e.clientX - grabPress.x;
    const dy = e.clientY - grabPress.y;
    const moved = Math.hypot(dx, dy);
    if (moved < 6) return;
    if (Math.abs(alongCable(dx, dy)) >= moved * ALONG_CABLE) {
      stretchPress = { ...grabPress, from: stretch };
      panPress = null;
      // The view holds still while the router moves, so nothing zooms under the finger.
      camFree = true;
    }
    grabPress = null;
  }
  if (stretchPress) {
    // Along the cable, in tiles: the layout moves with the pointer, the simulation catches up when the router is let go.
    const tiles = alongCable(e.clientX - stretchPress.x, e.clientY - stretchPress.y) / (Math.hypot(U, U / 2) * cam.scale);
    const next = Math.round(Math.max(0, Math.min(MAX_STRETCH, stretchPress.from + tiles)));
    if (next !== stretch) {
      stretch = next;
      tl = buildTimeline(story, knocks, stretch);
      scene.setStory(story, tl);
    }
    return;
  }
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  if (panPress) {
    if (Math.hypot(e.clientX - panPress.x, e.clientY - panPress.y) < 6) return;
    panPress = null;
    airPress = null;
    camFree = true;
  }
  if (toolPress) {
    if (Math.hypot(e.clientX - toolPress.x, e.clientY - toolPress.y) < 6) return;
    toolPress = null;
    camFree = true;
  }
  if (screenPress) {
    if (Math.hypot(e.clientX - screenPress.x, e.clientY - screenPress.y) < 6) return;
    screenPress = null;
    camFree = true;
  }
  if (pointers.size === 1) {
    cam = { ...cam, cx: cam.cx - (e.clientX - prev.x) / cam.scale, cy: cam.cy - (e.clientY - prev.y) / cam.scale };
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    return;
  }
  const before = spread();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const after = spread();
  cam = { ...cam, cx: cam.cx - (after.x - before.x) / cam.scale, cy: cam.cy - (after.y - before.y) / cam.scale };
  zoomAt(after.x, after.y, after.d / before.d);
});
const release = (e: PointerEvent): void => {
  pointers.delete(e.pointerId);
  if (!pointers.size) svg.classList.remove('panning');
  if (stretchPress) {
    stretchPress = null;
    preview();
    sound.play('snap');
  }
  if (airPress && e.type === 'pointerup') {
    noise = noise > 0 ? 0 : NOISY;
    preview();
    sound.play(noise > 0 ? 'bonk' : 'snap');
  }
  airPress = null;
  grabPress = null;
  if (screenPress) {
    forget(screenPress.device);
    screenPress = null;
  }
  if (toolPress && tool) {
    const line = toolLine(e);
    if (line) USE[tool](line);
  }
  toolPress = null;
  panPress = null;
};
svg.addEventListener('pointerup', release);
svg.addEventListener('pointercancel', release);
// However a finger stops being followed, it is no longer down.
svg.addEventListener('lostpointercapture', (e) => {
  pointers.delete(e.pointerId);
  if (!pointers.size) svg.classList.remove('panning');
});
svg.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    camFree = true;
    // Wheel steps come in pixels, lines or pages depending on the browser and mouse.
    const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
    zoomAt(e.clientX, e.clientY, Math.exp(-px * 0.0015));
  },
  { passive: false },
);

/** Tap a screen between runs: the device forgets what it remembers, and the next visit starts from scratch. */
function forget(device: string): void {
  known.delete(device);
  if (device === client) {
    idleV = -1;
    revisit = false;
  }
  sound.play('thud');
}

function togglePause(): void {
  if (mode !== 'play') return;
  if (peekTarget) peekTarget = 0;
  else paused = !paused;
}

/** One action on or back: the animation really plays, very fast, then carries on as it was (playing or paused). */
function step(dir: 1 | -1): void {
  if (mode !== 'play') return;
  peekTarget = 0;
  const to = stepTarget(tl, seek?.to ?? v, dir, BACK_GRACE * speed);
  seek = { from: v, to, t: 0, dur: Math.min(0.5, Math.max(0.22, Math.abs(to - v) / 6)) };
}

/** Start over: a clean table, everything put back and forgotten. */
function reset(): void {
  mode = 'idle';
  CARDS[carried].classList.remove('held', 'over');
  carried = 'page';
  seek = null;
  paused = false;
  peek = peekTarget = 0;
  doneFor = 0;
  camFree = false;
  showAll = false;
  holding = null;
  faults.length = 0;
  knocks.clear();
  decided = {};
  known.clear();
  client = 'laptop';
  cardPos = { ...home };
  pickUp(null);
  // Everything goes back at once: one simulation and one sound, not one of each per thing undone.
  cutLines.clear();
  scene.setCut([]);
  if (spyLine) {
    spyLine = null;
    scene.setSpy(null);
    spyCard.reset();
  }
  cuts = [];
  warmArp = false;
  stretch = 0;
  noise = 0;
  for (const menu of menus) menu.setOpen(false);
  showChapterMenu(false);
  for (const k of SETTINGS) features[k] = false;
  showSetup();
  preview();
  sound.play('thud');
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    // A button reached by keyboard works like any button; everywhere else Space pauses.
    if (e.target instanceof Element && e.target.closest('button')) return;
    e.preventDefault();
    togglePause();
  } else if (e.code === 'Escape') {
    pickUp(null);
    for (const menu of menus) menu.setOpen(false);
    showChapterMenu(false);
    hexCard.hide();
  }
  else if (e.code === 'ArrowRight') step(1);
  else if (e.code === 'ArrowLeft') step(-1);
});

/** The card has gone into the device: run the simulation with what is on the table and a fresh seed. */
function beginRun(): void {
  faults.length = 0;
  knocks.clear();
  runSeed = 1 + Math.floor(Math.random() * 1e6);
  decided = {};
  cuts = [...cutLines].map((link) => ({ link, from: 0 }));
  warmArp = cutLines.size > 0;
  revisit = remembers();
  joined = null;
  simulate();
  scene.setStory(story, tl);
  showFeatures();
  spyCard.reset();
  spyFrom = -Infinity;
  mode = 'play';
  v = 0;
  seek = null;
  doneFor = 0;
  paused = false;
  peek = peekTarget = 0;
  showAll = false;
}

/** The run is over: the device remembers the address until its TTL runs out, and the card floats back. */
function endRun(): void {
  const ip = story.remembered ?? story.dnsAnswer;
  if (ip && !revisit) known.set(client, { site: story.site, ip, until: performance.now() + (story.dnsTtl ?? 0) * 1000 });
  // A call over: hear what came through, holes and all.
  if (story.voice) sound.playVoice(story.voice.heard.map((b) => (b ? ulawDecodeAll(b) : null)), 160);
  idleV = tl.total;
  const from = scene.dropPoints().find((d) => d.id === client) ?? home;
  anim = { from, to: { ...HOMES[carried] }, t: 0, dur: 0.8 };
  mode = 'return';
  camFree = false;
}

let last = performance.now();
let clock = 0;
/** The viewer asked their system for less motion: the idle card keeps still. */
const stillness = window.matchMedia('(prefers-reduced-motion: reduce)');
/** Text in the bar only changes when it has to: setting it every frame makes the browser lay the bar out again. */
const setText = (e: HTMLElement, text: string): void => {
  if (e.textContent !== text) e.textContent = text;
};
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  clock += dt;

  for (const [device, k] of known) if (now >= k.until) known.delete(device);

  if (mode === 'spring' || mode === 'drop' || mode === 'return') {
    anim.t += dt;
    const k = clamp01(anim.t / anim.dur);
    const e = mode === 'drop' ? easeInOut(k) : easeOutBack(k);
    cardPos = { sx: lerp(anim.from.sx, anim.to.sx, e), sy: lerp(anim.from.sy, anim.to.sy, e) };
    if (k >= 1) {
      if (mode === 'drop') beginRun();
      else mode = 'idle';
    }
  }
  if (mode === 'play') {
    if (seek) {
      // A step button: the animation plays through at high speed, without sounds.
      seek.t += dt;
      const k = clamp01(seek.t / seek.dur);
      v = lerp(seek.from, seek.to, k);
      if (k >= 1) seek = null;
    } else if (!paused && !peekTarget) {
      const next = Math.min(tl.total, v + dt * speed);
      for (const c of tl.cues) if (c.t > v && c.t <= next) sound.play(c.sound, c.hz);
      v = next;
    }
    // A step can land where there is no packet to hold open (a lookup, a timer): carry on.
    if (peekTarget && !scene.peekable(v)) peekTarget = 0;
    doneFor = v >= tl.total && !paused && !seek ? doneFor + dt : 0;
    if (doneFor > LINGER) endRun();
  }
  peek += (peekTarget - peek) * Math.min(1, dt * 10);
  if (!peekTarget) pillTarget = 0;
  // The bytes go with the pill they came out of.
  if (!pillTarget && hexCard.isOpen) hexCard.hide();
  pillOpen += (pillTarget - pillOpen) * Math.min(1, dt * 12);

  const bob = mode === 'idle' && !stillness.matches ? Math.sin(clock * 2.4) * 4 : 0;
  const dropK = mode === 'drop' ? clamp01(anim.t / anim.dur) : 0;
  const riseK = mode === 'return' ? clamp01(anim.t / anim.dur) : 1;
  cardPop += dt;
  const pop = cardPop < 0.4 ? 1 + 0.12 * Math.sin((cardPop / 0.4) * Math.PI) : 1;
  const scale = (mode === 'drop' ? 1 - 0.8 * dropK : mode === 'drag' ? 1.06 : 0.2 + 0.8 * riseK) * pop;
  const cardOp = (1 - dropK) * riseK;
  const moving = CARDS[carried];
  moving.style.display = mode === 'play' ? 'none' : '';
  moving.setAttribute('transform', `translate(${cardPos.sx.toFixed(1)} ${(cardPos.sy + bob).toFixed(1)}) scale(${scale.toFixed(3)})`);
  moving.setAttribute('opacity', cardOp.toFixed(3));
  for (const w of WANTED) {
    if (w === carried) continue;
    const resting = CARDS[w];
    const rest = HOMES[w];
    resting.style.display = mode === 'play' ? 'none' : '';
    resting.setAttribute('transform', `translate(${rest.sx.toFixed(1)} ${(rest.sy - bob).toFixed(1)})`);
    resting.setAttribute('opacity', '1');
  }
  hint.style.display = mode === 'idle' ? '' : 'none';
  dock.hidden = mode !== 'play' || !!joined || v >= tl.total;
  dockGhost.hidden = dockRing.hidden = !holding;
  if (holding) {
    const spot = freeSpot();
    dockGhost.style.transform = `translate(${holding.x}px, ${holding.y}px)`;
    dockGhost.classList.toggle('over', overFree());
    if (spot) dockRing.style.transform = `translate(${spot.x}px, ${spot.y}px)`;
  }

  // The camera eases between the whole network (between runs) and a close follow of the packet,
  // unless the viewer has taken it over. A card in hand needs the whole network, and so does more than one job at a time.
  if (!camFree || holding) {
    const wide = !!holding || (!!joined && !segAt(tl, v)?.seg.flow);
    const target = mode === 'play' && !wide ? scene.followCamera(v) : showAll || wide ? scene.wholeCamera() : scene.overviewCamera();
    const ease = snapCamera ? 1 : Math.min(1, dt * (seek ? 6 : 3.5));
    cam = { cx: lerp(cam.cx, target.cx, ease), cy: lerp(cam.cy, target.cy, ease), scale: lerp(cam.scale, target.scale, ease) };
  }
  snapCamera = false;
  scene.applyCamera(cam);

  const shown = mode === 'play' ? v : idleV;
  scene.render(shown);
  scene.drawPacket(shown, peek, pill && pillOpen > 0.02 ? { key: pill, k: pillOpen } : null);
  spyCard.update(spyLine ? spyLog(tl, spyLine, shown, spyFrom) : []);
  realClock.hidden = mode !== 'play';
  if (mode === 'play') setText(realClock, `real time ${formatWait(realAt(tl, v))}`);

  const ch = mode === 'play' ? chapterAt(tl, v) : null;
  if (ch !== shownChapter) {
    shownChapter = ch;
    chapter.hidden = !ch;
    if (!ch) showChapterMenu(false);
    for (const [c, item] of chapterItems) item.classList.toggle('current', c === ch);
    if (ch) {
      chapter.innerHTML = `<span class="chapter-num">${chapterNumber(ch)}</span><span>${chapterName(ch)}</span>`;
      chapter.classList.remove('enter');
      void chapter.offsetWidth;
      chapter.classList.add('enter');
    }
  }

  const stopped = paused || !!peekTarget;
  setText(pauseBtn, stopped ? '▶' : '⏸');
  pauseBtn.setAttribute('aria-label', stopped ? 'Play' : 'Pause');
  svg.classList.toggle('between', canSetUp());
  soundBtn.classList.toggle('off', sound.muted);
  soundBtn.setAttribute('aria-pressed', String(sound.muted));
  // A tall screen starts close on the laptop, so the rest of the network has to be a press away.
  const closeUp = mode !== 'play' && !showAll && scene.overviewCamera().scale > scene.wholeCamera().scale;
  followBtn.hidden = !camFree && !closeUp;
  setText(followBtn, mode === 'play' ? '◎ Follow packet' : '◎ Show all');
  backBtn.disabled = pauseBtn.disabled = nextBtn.disabled = mode !== 'play';
  // The setup is for the next run: it would rewrite what has already happened.
  setupMenu.button.disabled = !canSetUp();
  if (!canSetUp()) setupMenu.setOpen(false);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

if (import.meta.env.DEV) {
  Object.assign(window, {
    __net: {
      get total() {
        return tl.total;
      },
      get v() {
        return v;
      },
      get mode() {
        return mode;
      },
      get revisit() {
        return revisit;
      },
      get segs() {
        return tl.segs.map((s) => ({ kind: s.step.kind, t0: s.t0, t1: s.t1, chapter: s.trip.chapter, device: 'device' in s.step ? s.step.device : 'from' in s.step ? `${s.step.from}→${s.step.to}` : s.step.kind }));
      },
      seek(t: number, open = 0): void {
        mode = 'play';
        v = t;
        paused = true;
        seek = null;
        peek = peekTarget = open;
        snapCamera = true;
        camFree = false;
      },
      /** Drop a card in on the other device, as a hand would. */
      join(job: Wanted): void {
        joinIn(job);
      },
      /** Cut a cable or mend it, as the scissors do. */
      cut(line: string): void {
        toggleCut(line);
      },
      /** Drag the ISP router this many tiles away, as a hand would. */
      stretch(tiles: number): void {
        stretch = Math.max(0, Math.min(MAX_STRETCH, tiles));
        preview();
      },
      /** Shake the Wi-Fi, or calm it. */
      shake(on = true): void {
        noise = on ? NOISY : 0;
        preview();
      },
      get tool() {
        return tool;
      },
      get lines() {
        return { cut: [...cutLines] };
      },
      get reactions() {
        return tl.reactions;
      },
      /** Start a run straight away with these things on the table (for screenshots). */
      start(f: Partial<Features> & { photo?: boolean; call?: boolean; ping?: boolean; trace?: boolean; spy?: string; cut?: string | string[]; slow?: boolean; vpn?: boolean; again?: boolean; from?: Client; noise?: number }): void {
        client = f.from ?? 'laptop';
        if (f.noise !== undefined) noise = f.noise;
        carried = f.call ? 'call' : f.ping ? 'ping' : f.trace ? 'trace' : f.photo ? 'photo' : 'page';
        for (const k of SETTINGS) if (features[k] !== !!f[k]) setSetting(k, !!f[k]);
        for (const l of [...cutLines]) clearLine(l);
        for (const l of [f.cut ?? []].flat()) toggleCut(l);
        setSpyLine(f.spy ?? null);
        if (f.again) known.set(client, { site: siteName(), ip: '', until: Infinity });
        else known.delete(client);
        beginRun();
        runSeed = 1;
        simulate();
        scene.setStory(story, tl);
      },
    },
  });
}

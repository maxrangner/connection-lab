import './app.css';
import { fetchWebPage, runScenario, type Cut, type LossWindow, type ManualFault } from '../sim';
import { el } from './svg';
import { clamp01, easeInOut, easeOutBack, iso, lerp } from './project';
import { drawBolt, drawPadlock, drawPage, drawSatellite, drawScissors, drawShield, drawSpyglass } from './icons';
import { Menu } from './menus';
import { NetworkScene, type Camera } from './NetworkScene';
import { Sound } from './sound';
import { buildStory, type Chapter, type PartKey, type Story } from './story';
import { buildTimeline, chapterAt, seenSoFar, stepTarget, type Timeline } from './timeline';

/**
 * "Get example.com". Drag the site card onto the laptop or the phone. The bar below holds the playback buttons, and
 * popups for the speed, the tools you click lines with, and the setup of the next run.
 * Tap a packet on a cable to knock it off; tap it anywhere else to pop it open. When a run ends the card comes back.
 */

/** A share of the frames on a stormy line is lost. */
const STORM_LOSS = 0.15;
/** Seconds the finished picture stays before the card comes back. */
const LINGER = 1.4;
/** Seconds after the start of a step in which back goes to the step before it. */
const BACK_GRACE = 1;

/** What the next run is like, set from the Setup menu between runs: changing it mid-run would rewrite what happened. */
type Setting = 'https' | 'big' | 'slow' | 'vpn';
type Features = Record<Setting, boolean>;
const SETTINGS: Setting[] = ['https', 'big', 'slow', 'vpn'];
const features: Features = { https: false, big: false, slow: false, vpn: false };
/** The lines with a storm over them. They can change any time, before or during a run. */
const stormLines = new Set<string>();
/** The line the spyglass is on, if any. */
let spyLine: string | null = null;
/** The cables that are cut. They can change any time too. */
const cutLines = new Set<string>();
try {
  const saved = JSON.parse(localStorage.getItem('net.features') ?? '{}') as Partial<Features> & { stormLines?: string[]; spyLine?: string | null; cutLines?: string[] };
  for (const k of SETTINGS) features[k] = !!saved[k];
  for (const l of saved.stormLines ?? []) stormLines.add(l);
  spyLine = saved.spyLine ?? null;
  for (const l of saved.cutLines ?? []) cutLines.add(l);
} catch {
  // Nothing remembered; start plain.
}
function remember(): void {
  try {
    localStorage.setItem('net.features', JSON.stringify({ ...features, stormLines: [...stormLines], spyLine, cutLines: [...cutLines] }));
  } catch {
    // Not remembered; fine.
  }
}
/** Packets the viewer knocked off, and how far along their cable they were (only for drawing the fall). */
const faults: ManualFault[] = [];
const knocks = new Map<string, number>();
/** Each run gets its own weather; knocking a packet off or changing a storm re-runs with the same weather. */
let stormSeed = 1;
/** When (sim time) the storm was on during this run, and what the viewer has already seen happen. */
let stormWindows: LossWindow[] = [];
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
const siteName = (): 'info.cern.ch' | 'example.com' => (features.big ? 'info.cern.ch' : 'example.com');
function remembers(): boolean {
  const k = known.get(client);
  return !!k && k.site === siteName() && performance.now() < k.until;
}
function simulate(): void {
  const scenario = fetchWebPage({ site: siteName(), revisit, slow: features.slow, vpn: features.vpn, https: features.https, from: client, warmArp });
  const plan = { randomLoss: STORM_LOSS, lossWindows: stormWindows, decided, cuts, manual: faults };
  // Long enough for TCP to give up on a dead line (15 resends, backing off to a minute apart).
  story = buildStory(runScenario(scenario, { seed: stormSeed, faults: plan, maxTime: 1000 }));
  tl = buildTimeline(story, knocks);
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
const card = el('g', { class: 'site-card' }, svg);
const cardBody = el('g', {}, card);
el('rect', { x: -88, y: -22, width: 176, height: 44, rx: 10, class: 'site-card-bg' }, cardBody);
el('circle', { cx: -66, cy: 0, r: 9, class: 'site-card-globe' }, cardBody);
el('ellipse', { cx: -66, cy: 0, rx: 4, ry: 9, class: 'site-card-globe' }, cardBody);
const cardText = el('text', { x: 12, y: 0, dy: '0.35em', 'text-anchor': 'middle' }, cardBody);
cardText.textContent = 'example.com';
const hint = el('text', { class: 'hint', 'text-anchor': 'middle', x: 0, y: 40 }, card);
hint.textContent = 'drag me onto the laptop or the phone';
let cardPop = 9;
/** Small badges on the card for what is set up. */
const cardBadges = el('g', {}, card);

scene.setOnTable([home, { sx: home.sx - 110, sy: home.sy + 50 }, { sx: home.sx + 110, sy: home.sy - 40 }]);

/** A setting changed before a run: show the network it will use, with a clean screen. */
function preview(): void {
  remember();
  idleV = -1;
  revisit = remembers();
  simulate();
  scene.setStory(story, tl);
  showFeatures();
}

function showFeatures(): void {
  const site = siteName();
  if (cardText.textContent !== site) {
    cardText.textContent = site;
    cardPop = 0;
  }
  scene.setStorm([...stormLines]);
  cardBadges.replaceChildren();
  SETUP.filter((s) => features[s.id]).forEach((s, i) => {
    const g = el('g', { transform: `translate(${72 - i * 30} -24)` }, cardBadges);
    el('circle', { r: 13, class: 'card-badge' }, g);
    s.draw(el('g', { transform: `scale(${(14 / s.span).toFixed(3)})` }, g));
  });
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

/** A storm on a line, or the end of it. Mid-run the simulation re-runs from this moment on: what was seen stays. */
function toggleStorm(line: string): void {
  const on = !stormLines.has(line);
  if (on) stormLines.add(line);
  else stormLines.delete(line);
  remember();
  if (mode === 'play') {
    const seen = seenSoFar(tl, v);
    decided = { ...decided, ...seen.decided };
    stormWindows = stormWindows.map((w) => (w.to === undefined && w.links?.includes(line) ? { ...w, to: seen.now } : w));
    if (on) stormWindows = [...stormWindows, { from: seen.now, links: [line] }];
    simulate();
    scene.setStory(story, tl);
  }
  showFeatures();
  sound.play(on ? 'zap' : 'snap');
}

/** Cut a cable, or mend it. Like the storm it works mid-run, and a packet on that cable right now falls in. */
function toggleCut(line: string): void {
  const on = !cutLines.has(line);
  if (on) cutLines.add(line);
  else cutLines.delete(line);
  remember();
  if (mode === 'play') {
    const riding = on ? scene.knockable(v) : null;
    if (riding?.link === line) {
      faults.push({ packetId: riding.trip.packetId, linkId: riding.link });
      knocks.set(`${riding.trip.packetId}@${riding.link}`, riding.k);
    }
    const seen = seenSoFar(tl, v);
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
  if (stormLines.has(line)) toggleStorm(line);
  if (cutLines.has(line)) toggleCut(line);
}

let cam: Camera = scene.overviewCamera();

/** Tools come from the Tools menu: pick one, click as many lines as you like, click a line again to undo it. */
type Tool = 'storm' | 'spy' | 'cut';
let tool: Tool | null = null;

/** Put the spyglass on a line, or take it off. It only reads, so nothing about the run changes. */
function setSpyLine(line: string | null): void {
  if (line === spyLine) return;
  spyLine = line;
  scene.setSpy(line);
  remember();
  sound.play('snap');
}
const USE: Record<Tool, (line: string) => void> = { storm: toggleStorm, spy: (l) => setSpyLine(spyLine === l ? null : l), cut: toggleCut };
function pickUp(t: Tool | null): void {
  tool = t;
  for (const id of ['storm', 'spy', 'cut'] as const) {
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

const VPN_LINK = 'bb3';
const SETUP: { id: Setting; label: string; draw: (g: SVGGElement) => void; span: number }[] = [
  { id: 'https', label: 'Secure', draw: drawPadlock, span: 34 },
  { id: 'big', label: 'Bigger page', draw: drawPage, span: 34 },
  { id: 'slow', label: 'Satellite', draw: drawSatellite, span: 56 },
  { id: 'vpn', label: 'VPN', draw: drawShield, span: 34 },
];
function setSetting(id: Setting, on: boolean): void {
  features[id] = on;
  // The line to the ISP becomes radio, which cannot be cut.
  if (id === 'slow' && on && cutLines.has('wan')) toggleCut('wan');
  // The VPN's cable goes with it.
  if (id === 'vpn' && !on) {
    clearLine(VPN_LINK);
    if (spyLine === VPN_LINK) setSpyLine(null);
  }
  showSetup();
  preview();
  sound.play(id === 'https' || id === 'vpn' ? 'lock' : 'snap');
}
/** The Setup menu says what is on, also for what was remembered from last time. */
function showSetup(): void {
  for (const k of SETTINGS) setupMenu.setOn(k, features[k]);
  setupMenu.button.classList.toggle('on', SETTINGS.some((k) => features[k]));
}

const CHAPTERS: Record<Chapter, string> = { dns: 'Find the address', hello: 'Say hello', secret: 'Agree on a secret', page: 'Get the page' };
/** Chapter number in this run (a second visit skips the address, HTTPS adds the secret). */
function chapterNumber(ch: Chapter): number {
  const order: Chapter[] = [];
  for (const s of tl.segs) if (!order.includes(s.trip.chapter)) order.push(s.trip.chapter);
  return order.indexOf(ch) + 1;
}
const chapter = document.createElement('button');
chapter.className = 'chapter';
chapter.hidden = true;
chapter.setAttribute('aria-haspopup', 'true');
root.appendChild(chapter);
let shownChapter: Chapter | null = null;

// Tap the chapter label to jump to any chapter of this run.
const chapterMenu = document.createElement('div');
chapterMenu.className = 'chapter-menu';
chapterMenu.hidden = true;
root.appendChild(chapterMenu);
chapter.addEventListener('click', () => {
  if (!chapterMenu.hidden) {
    chapterMenu.hidden = true;
    return;
  }
  chapterMenu.replaceChildren();
  const seen = new Set<Chapter>();
  for (const s of tl.segs) {
    const ch = s.trip.chapter;
    if (seen.has(ch)) continue;
    seen.add(ch);
    const item = document.createElement('button');
    item.innerHTML = `<span class="chapter-num">${chapterNumber(ch)}</span><span>${CHAPTERS[ch]}</span>`;
    item.classList.toggle('current', ch === shownChapter);
    item.addEventListener('click', () => {
      v = s.t0;
      cueDone = v;
      seek = null;
      paused = false;
      peek = peekTarget = 0;
      camFree = false;
      chapterMenu.hidden = true;
    });
    chapterMenu.appendChild(item);
  }
  chapterMenu.hidden = false;
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
const pauseBtn = button('', 'Pause or play', togglePause);
const nextBtn = button('⏭', 'Step forward', () => step(1));
const speedMenu = new Menu<string>(controls, root, '1×', 'Speed', ['0.5', '1', '2'].map((id) => ({ id, label: `${id}×` })), (id) => {
  speed = Number(id);
  speedMenu.button.textContent = `${id}×`;
  for (const x of ['0.5', '1', '2']) speedMenu.setOn(x, x === id);
  speedMenu.setOpen(false);
});
speedMenu.setOn('1', true);
const toolsMenu = new Menu<Tool>(
  controls,
  root,
  'Tools',
  'Tools',
  [
    { id: 'storm', label: 'Storm', draw: drawBolt, span: 36 },
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
for (const menu of menus) menu.button.addEventListener('click', () => { for (const other of menus) if (other !== menu) other.setOpen(false); });
const placeMenus = (): void => {
  for (const menu of menus) menu.place();
};
const soundBtn = button('♪', 'Sound', () => {
  sound.muted = !sound.muted;
  try {
    localStorage.setItem('net.muted', sound.muted ? '1' : '0');
  } catch {
    // Not remembered; fine.
  }
});
button('↺', 'Reset', reset);
root.appendChild(controls);
// Outside the bar, so the bar never moves.
const followBtn = document.createElement('button');
followBtn.className = 'follow';
followBtn.setAttribute('aria-label', 'Follow the packet');
followBtn.addEventListener('click', () => {
  camFree = false;
});
root.appendChild(followBtn);
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
/** Sounds already played up to this visual time (so a knock doesn't bonk twice). */
let cueDone = 0;
revisit = remembers();
showFeatures();
cardPop = 9;

function toSvg(e: PointerEvent): { sx: number; sy: number } {
  const m = svg.getScreenCTM();
  if (!m) return { sx: 0, sy: 0 };
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  return { sx: p.x, sy: p.y };
}

card.addEventListener('pointerdown', (e) => {
  if (mode !== 'idle' && mode !== 'spring') return;
  const p = toSvg(e);
  grab = { dx: cardPos.sx - p.sx, dy: cardPos.sy - p.sy };
  mode = 'drag';
  card.setPointerCapture(e.pointerId);
  card.classList.add('held');
});
card.addEventListener('pointermove', (e) => {
  if (mode !== 'drag') return;
  const p = toSvg(e);
  cardPos = { sx: p.sx + grab.dx, sy: p.sy + grab.dy };
  card.classList.toggle('over', !!dropTarget());
});

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
card.addEventListener('pointerup', () => {
  if (mode !== 'drag') return;
  card.classList.remove('held', 'over');
  const drop = dropTarget();
  if (drop) client = drop.id === 'phone' ? 'phone' : 'laptop';
  anim = { from: { ...cardPos }, to: drop ?? { ...home }, t: 0, dur: drop ? 0.35 : 0.5 };
  mode = drop ? 'drop' : 'spring';
  if (drop) {
    camFree = false;
    sound.play('pop');
  }
});

// Tap a packet out on a cable to knock it off; anywhere else, tap it to pop it open.
scene.packet.addEventListener('pointerdown', () => {
  if (tool || mode !== 'play' || v >= tl.total) return;
  const target = !paused && !peekTarget && !seek ? scene.knockable(v) : null;
  if (target) knock(target);
  else if (scene.peekable(v)) peekTarget = peekTarget ? 0 : 1;
});

function knock(target: NonNullable<ReturnType<NetworkScene['knockable']>>): void {
  faults.push({ packetId: target.trip.packetId, linkId: target.link });
  knocks.set(`${target.trip.packetId}@${target.link}`, target.k);
  // Re-run the simulation with this frame lost. Everything before this moment comes out the same,
  // so the picture continues seamlessly from here.
  simulate();
  scene.setStory(story, tl);
  sound.play('bonk');
  cueDone = v + 0.05;
}

// Pan and zoom by hand: drag the stage, pinch, or use the wheel. Any of these lets go of the follow camera.
const pointers = new Map<number, { x: number; y: number }>();
/** A press on a device's screen between runs, which is a "forget" if it does not turn into a drag. */
let screenPress: { device: string; x: number; y: number } | null = null;
/** A press with a tool in hand: a click on a line if it does not turn into a drag. */
let toolPress: { x: number; y: number } | null = null;
/** A press on the table: it only takes the view over once it really moves. */
let panPress: { x: number; y: number } | null = null;

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
  // Working the stage leaves the Tools menu open while a tool is in hand; the other popups give way to it.
  for (const menu of menus) if (menu !== toolsMenu || !tool) menu.setOpen(false);
  const target = e.target as Element;
  const chip = target.closest('[data-chip]')?.getAttribute('data-chip') as PartKey | undefined;
  if (chip) {
    pillTarget = pill === chip && pillTarget ? 0 : 1;
    if (pill !== chip) pillOpen = 0;
    pill = chip;
    sound.play('snap');
    return;
  }
  if (target.closest('.site-card') || (!tool && target.closest('.packet'))) return;
  toolPress = tool ? { x: e.clientX, y: e.clientY } : null;
  const device = target.closest('[data-device]')?.getAttribute('data-device');
  screenPress = device && mode === 'idle' && known.has(device) ? { device, x: e.clientX, y: e.clientY } : null;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  svg.setPointerCapture(e.pointerId);
  panPress = !screenPress && !toolPress ? { x: e.clientX, y: e.clientY } : null;
  svg.classList.add('panning');
});
svg.addEventListener('pointermove', (e) => {
  if (tool) scene.setHover(toolLine(e));
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  if (panPress) {
    if (Math.hypot(e.clientX - panPress.x, e.clientY - panPress.y) < 6) return;
    panPress = null;
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
svg.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    camFree = true;
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
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
  card.classList.remove('held', 'over');
  seek = null;
  paused = false;
  peek = peekTarget = 0;
  doneFor = 0;
  camFree = false;
  faults.length = 0;
  knocks.clear();
  decided = {};
  stormWindows = [];
  known.clear();
  client = 'laptop';
  cardPos = { ...home };
  pickUp(null);
  for (const l of [...stormLines, ...cutLines]) clearLine(l);
  setSpyLine(null);
  cuts = [];
  warmArp = false;
  for (const menu of menus) menu.setOpen(false);
  for (const k of SETTINGS) if (features[k]) setSetting(k, false);
  preview();
  sound.play('thud');
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    // A menu item reached by keyboard works like any button; everywhere else Space pauses.
    if (e.target instanceof Element && e.target.matches('.menu-item:focus-visible')) return;
    e.preventDefault();
    togglePause();
  } else if (e.code === 'Escape') {
    pickUp(null);
    for (const menu of menus) menu.setOpen(false);
  }
  else if (e.code === 'ArrowRight') step(1);
  else if (e.code === 'ArrowLeft') step(-1);
});

/** The card has gone into the device: run the simulation with what is on the table, fresh weather and no knocks. */
function beginRun(): void {
  faults.length = 0;
  knocks.clear();
  stormSeed = 1 + Math.floor(Math.random() * 1e6);
  decided = {};
  stormWindows = [...stormLines].map((l) => ({ from: 0, links: [l] }));
  cuts = [...cutLines].map((link) => ({ link, from: 0 }));
  warmArp = cutLines.size > 0;
  revisit = remembers();
  simulate();
  scene.setStory(story, tl);
  showFeatures();
  mode = 'play';
  v = 0;
  cueDone = 0;
  seek = null;
  doneFor = 0;
  paused = false;
  peek = peekTarget = 0;
}

/** The run is over: the device remembers the address until its TTL runs out, and the card floats back. */
function endRun(): void {
  const ip = story.remembered ?? story.dnsAnswer;
  if (ip && !revisit) known.set(client, { site: story.site, ip, until: performance.now() + (story.dnsTtl ?? 0) * 1000 });
  idleV = tl.total;
  const from = scene.dropPoints().find((d) => d.id === client) ?? home;
  anim = { from, to: { ...home }, t: 0, dur: 0.8 };
  mode = 'return';
  camFree = false;
}

let last = performance.now();
let clock = 0;
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
      cueDone = v;
      if (k >= 1) seek = null;
    } else if (!paused && !peekTarget) {
      const next = Math.min(tl.total, v + dt * speed);
      for (const c of tl.cues) if (c.t > Math.max(v, cueDone) && c.t <= next) sound.play(c.sound);
      v = next;
    }
    // A step can land where there is no packet to hold open (a lookup, a timer): carry on.
    if (peekTarget && !scene.peekable(v)) peekTarget = 0;
    doneFor = v >= tl.total && !paused && !seek ? doneFor + dt : 0;
    if (doneFor > LINGER) endRun();
  }
  peek += (peekTarget - peek) * Math.min(1, dt * 10);
  if (!peekTarget) pillTarget = 0;
  pillOpen += (pillTarget - pillOpen) * Math.min(1, dt * 12);

  const bob = mode === 'idle' ? Math.sin(clock * 2.4) * 4 : 0;
  const dropK = mode === 'drop' ? clamp01(anim.t / anim.dur) : 0;
  const riseK = mode === 'return' ? clamp01(anim.t / anim.dur) : 1;
  cardPop += dt;
  const pop = cardPop < 0.4 ? 1 + 0.12 * Math.sin((cardPop / 0.4) * Math.PI) : 1;
  const scale = (mode === 'drop' ? 1 - 0.8 * dropK : mode === 'drag' ? 1.06 : 0.2 + 0.8 * riseK) * pop;
  const cardOp = (1 - dropK) * riseK;
  card.style.display = mode === 'play' ? 'none' : '';
  card.setAttribute('transform', `translate(${cardPos.sx.toFixed(1)} ${(cardPos.sy + bob).toFixed(1)}) scale(${scale.toFixed(3)})`);
  card.setAttribute('opacity', cardOp.toFixed(3));
  hint.style.display = mode === 'idle' ? '' : 'none';
  scene.renderStorm(clock);

  // The camera eases between the whole network (between runs) and a close follow of the packet,
  // unless the viewer has taken it over.
  if (!camFree) {
    const target = mode === 'play' ? scene.followCamera(v) : scene.overviewCamera();
    const ease = snapCamera ? 1 : Math.min(1, dt * (seek ? 6 : 3.5));
    cam = { cx: lerp(cam.cx, target.cx, ease), cy: lerp(cam.cy, target.cy, ease), scale: lerp(cam.scale, target.scale, ease) };
  }
  snapCamera = false;
  scene.applyCamera(cam);

  const shown = mode === 'play' ? v : idleV;
  scene.render(shown);
  scene.drawPacket(shown, peek, pill && pillOpen > 0.02 ? { key: pill, k: pillOpen } : null);
  scene.packet.classList.toggle('knockable', mode === 'play' && !paused && !peekTarget && !seek && !!scene.knockable(v));

  const ch = mode === 'play' ? chapterAt(tl, v) : null;
  if (ch !== shownChapter) {
    shownChapter = ch;
    chapter.hidden = !ch;
    if (!ch) chapterMenu.hidden = true;
    if (ch) {
      chapter.innerHTML = `<span class="chapter-num">${chapterNumber(ch)}</span><span>${CHAPTERS[ch]}</span>`;
      chapter.classList.remove('enter');
      void chapter.offsetWidth;
      chapter.classList.add('enter');
    }
  }

  pauseBtn.textContent = paused || peekTarget ? '▶' : '⏸';
  soundBtn.classList.toggle('off', sound.muted);
  followBtn.hidden = !camFree;
  followBtn.textContent = mode === 'play' ? '◎ Follow packet' : '◎ Show all';
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
        return tl.segs.map((s) => ({ kind: s.step.kind, t0: s.t0, t1: s.t1, chapter: s.trip.chapter, device: 'device' in s.step ? s.step.device : `${s.step.from}→${s.step.to}` }));
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
      /** Cut a cable or mend it, as the scissors do. */
      cut(line: string): void {
        toggleCut(line);
      },
      get tool() {
        return tool;
      },
      get lines() {
        return { storm: [...stormLines], cut: [...cutLines] };
      },
      /** Knock off whatever packet is on a cable at visual time t. */
      knock(t: number): boolean {
        mode = 'play';
        v = t;
        const target = scene.knockable(v);
        if (target) knock(target);
        return !!target;
      },
      get reactions() {
        return tl.reactions;
      },
      /** Start a run straight away with these things on the table (for screenshots). */
      start(f: Partial<Features> & { storm?: string | string[]; spy?: string; cut?: string | string[]; slow?: boolean; vpn?: boolean; again?: boolean; from?: Client }): void {
        client = f.from ?? 'laptop';
        for (const k of SETTINGS) if (features[k] !== !!f[k]) setSetting(k, !!f[k]);
        for (const l of [...stormLines, ...cutLines]) clearLine(l);
        for (const l of [f.storm ?? []].flat()) toggleStorm(l);
        for (const l of [f.cut ?? []].flat()) toggleCut(l);
        setSpyLine(f.spy ?? null);
        if (f.again) known.set(client, { site: siteName(), ip: '', until: Infinity });
        else known.delete(client);
        beginRun();
        stormSeed = 1;
        simulate();
        scene.setStory(story, tl);
      },
    },
  });
}

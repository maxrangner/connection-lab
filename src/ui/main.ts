import './app.css';
import { fetchWebPage, runScenario, type LossWindow, type ManualFault } from '../sim';
import { el } from './svg';
import { clamp01, easeInOut, easeOutBack, iso, lerp } from './project';
import { NetworkScene, type Camera } from './NetworkScene';
import { drawCloud, drawSatellite, Prop, rain } from './props';
import { Sound } from './sound';
import { Stickers, type Features } from './stickers';
import { buildStory, type Chapter, type Story } from './story';
import { buildTimeline, chapterAt, seenSoFar, SKY_HEIGHT, stepTarget, type Timeline } from './timeline';

/**
 * "Get example.com". Everything you change, you change by hand on the table: drag the site card onto the laptop or
 * the phone, stick things on it, put the cloud on a line, put the satellite on the line to the ISP.
 * Tap a packet on a cable to knock it off; tap it anywhere else to pop it open. When a run ends the card comes back.
 */

/** A share of the frames on a stormy line is lost. */
const STORM_LOSS = 0.15;
/** Seconds the finished picture stays before the card comes back. */
const LINGER = 1.4;

let features: Features = { https: false, big: false };
/** The one line the storm cloud hangs over, if any. It can change any time, before or during a run. */
let stormLine: string | null = null;
/** The line to the ISP goes through a satellite. Set before a run: it would change what has already happened. */
let slow = false;
try {
  const saved = JSON.parse(localStorage.getItem('net.features') ?? '{}') as Partial<Features> & { stormLine?: string | null; slow?: boolean };
  features = { https: !!saved.https, big: !!saved.big };
  stormLine = saved.stormLine ?? null;
  slow = !!saved.slow;
} catch {
  // Nothing remembered; start plain.
}
function remember(): void {
  try {
    localStorage.setItem('net.features', JSON.stringify({ ...features, stormLine, slow }));
  } catch {
    // Not remembered; fine.
  }
}
/** Packets the viewer knocked off, and how far along their cable they were (only for drawing the fall). */
const faults: ManualFault[] = [];
const knocks = new Map<string, number>();
/** Each run gets its own weather; knocking a packet off or moving the cloud re-runs with the same weather. */
let stormSeed = 1;
/** When (sim time) the storm was on during this run, and what the viewer has already seen happen. */
let stormWindows: LossWindow[] = [];
let decided: Record<string, boolean> = {};
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
  const scenario = fetchWebPage({ site: siteName(), revisit, slow, https: features.https, from: client });
  const plan = { randomLoss: STORM_LOSS, lossWindows: stormWindows, decided, manual: faults };
  story = buildStory(runScenario(scenario, { seed: stormSeed, faults: plan }));
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
const home = iso(1, 6, 0.5);
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

/** A setting changed on the table before a run: show the network it will use, with a clean screen. */
function preview(): void {
  remember();
  idleV = -1;
  revisit = remembers();
  simulate();
  scene.setStory(story, tl);
  showFeatures();
}

// Stickers lie beside the card: stick one on to switch that feature on.
const stickers = new Stickers(svg, features, (f) => {
  features = f;
  preview();
  sound.play('snap');
});

function showFeatures(): void {
  const site = siteName();
  if (cardText.textContent !== site) {
    cardText.textContent = site;
    cardPop = 0;
  }
  scene.setStorm(stormLine ? [stormLine] : []);
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
/** The line a held thing is over, if any. */
function lineNear(p: { sx: number; sy: number }): string | null {
  let best: string | null = null;
  let bestD = 80;
  for (const l of story.links) {
    const d = toLink(p, l.id);
    if (d < bestD) {
      best = l.id;
      bestD = d;
    }
  }
  return best;
}
const near = (a: { sx: number; sy: number }, b: { sx: number; sy: number }, r: number): boolean => Math.hypot(a.sx - b.sx, a.sy - b.sy) < r;
const canSetUp = (): boolean => mode === 'idle' || mode === 'spring';

/** Move the storm to a line, or end it. Mid-run the simulation re-runs from this moment on: what was seen stays. */
function setStormLine(line: string | null): void {
  if (line === stormLine) return;
  stormLine = line;
  cloud.on = !!line;
  remember();
  if (mode === 'play') {
    const seen = seenSoFar(tl, v);
    decided = { ...decided, ...seen.decided };
    stormWindows = stormWindows.map((w) => (w.to === undefined ? { ...w, to: seen.now } : w));
    if (line) stormWindows = [...stormWindows, { from: seen.now, links: [line] }];
    simulate();
    scene.setStory(story, tl);
  }
  showFeatures();
  sound.play(line ? 'zap' : 'snap');
}

let cam: Camera = scene.overviewCamera();

// The cloud waits by the buttons, always in reach. Put it on a line and that line gets stormy, even mid-run.
const CLOUD_SIZE = 0.75;
const cloudSlot = (): { sx: number; sy: number } => scene.cloudSlot(cam, document.querySelector('.net-controls')?.getBoundingClientRect().right ?? window.innerWidth / 2);
const cloud = new Prop(
  svg,
  {
    label: 'Storm',
    cls: 'cloud-prop',
    draw: drawCloud,
    animate: rain,
    parked: cloudSlot,
    active: () => (stormLine ? scene.linkCloudSpot(stormLine) : cloudSlot()),
    hits: (p) => !!lineNear(p),
    dropped: (p) => setStormLine(p ? lineNear(p) : null),
    ghost: true,
    canMove: () => true,
    pinned: () => (stormLine ? null : { scale: CLOUD_SIZE / cam.scale }),
    waiting: () => CLOUD_SIZE / cam.scale,
    onChange: () => {},
  },
  !!stormLine,
);

// The satellite: put it on the line to the ISP and that line goes through space. Only before a run.
const skySpot = (): { sx: number; sy: number } => {
  const ends = scene.cableEnds('wan');
  return ends ? { sx: (ends[0].sx + ends[1].sx) / 2, sy: (ends[0].sy + ends[1].sy) / 2 - SKY_HEIGHT * 28 } : home;
};
const satellite = new Prop(
  svg,
  {
    label: 'Satellite',
    cls: 'sat-prop',
    draw: drawSatellite,
    parked: () => iso(-6, -3, 3),
    active: skySpot,
    hits: (p) => near(p, skySpot(), 120) || toLink(p, 'wan') < 80,
    canMove: canSetUp,
    hidden: () => !slow && (mode === 'play' || mode === 'drop'),
    onChange: (on) => {
      slow = on;
      preview();
      sound.play('snap');
    },
  },
  slow,
);
scene.setOnTable([home, { sx: home.sx - 110, sy: home.sy + 50 }, { sx: home.sx - 170, sy: home.sy - 110 }, iso(-6, -3, 4.6), { sx: iso(-6, -3, 3).sx - 60, sy: iso(-6, -3, 3).sy }]);

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
const soundBtn = button('♪', 'Sound', () => {
  sound.muted = !sound.muted;
  try {
    localStorage.setItem('net.muted', sound.muted ? '1' : '0');
  } catch {
    // Not remembered; fine.
  }
});
button('↺', 'Reset', reset);
const followBtn = button('◎ Follow packet', 'Follow the packet', () => {
  camFree = false;
});
root.appendChild(controls);

let v = 0;
/** What the table shows between runs: the end of the last run, or a clean table (-1). */
let idleV = -1;
let paused = false;
/** A step button playing the animation through at high speed, playing or paused. */
let seek: { from: number; to: number; t: number; dur: number } | null = null;
/** Seconds since the run reached its end. */
let doneFor = 0;
let peek = 0;
let peekTarget = 0;
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
  if (mode !== 'play' || v >= tl.total) return;
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
  const target = e.target as Element;
  if (target.closest('.site-card, .packet, .prop')) return;
  const device = target.closest('[data-device]')?.getAttribute('data-device');
  screenPress = device && mode === 'idle' && known.has(device) ? { device, x: e.clientX, y: e.clientY } : null;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  svg.setPointerCapture(e.pointerId);
  if (!screenPress) camFree = true;
  svg.classList.add('panning');
});
svg.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
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
  const to = stepTarget(tl, seek?.to ?? v, dir);
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
  setStormLine(null);
  stickers.set('https', false);
  stickers.set('big', false);
  satellite.set(false);
  preview();
  sound.play('thud');
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    togglePause();
  } else if (e.code === 'ArrowRight') step(1);
  else if (e.code === 'ArrowLeft') step(-1);
});

/** The card has gone into the device: run the simulation with what is on the table, fresh weather and no knocks. */
function beginRun(): void {
  faults.length = 0;
  knocks.clear();
  stormSeed = 1 + Math.floor(Math.random() * 1e6);
  decided = {};
  stormWindows = stormLine ? [{ from: 0, links: [stormLine] }] : [];
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
      const next = Math.min(tl.total, v + dt);
      for (const c of tl.cues) if (c.t > Math.max(v, cueDone) && c.t <= next) sound.play(c.sound);
      v = next;
    }
    doneFor = v >= tl.total && !paused && !seek ? doneFor + dt : 0;
    if (doneFor > LINGER) endRun();
  }
  peek += (peekTarget - peek) * Math.min(1, dt * 10);

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
  stickers.update(dt, home, { sx: cardPos.sx, sy: cardPos.sy + bob }, scale, cardOp, mode !== 'play');
  cloud.update(dt, clock);
  satellite.update(dt, clock);
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
  scene.drawPacket(shown, peek);
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
  backBtn.hidden = pauseBtn.hidden = nextBtn.hidden = mode !== 'play';
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
      start(f: Partial<Features> & { storm?: string; slow?: boolean; again?: boolean; from?: Client }): void {
        client = f.from ?? 'laptop';
        for (const k of ['https', 'big'] as const) stickers.set(k, !!f[k]);
        satellite.set(!!f.slow);
        setStormLine(f.storm ?? null);
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

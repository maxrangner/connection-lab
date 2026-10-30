import './app.css';
import { fetchWebPage, runScenario, type LossWindow, type ManualFault } from '../sim';
import { el } from './svg';
import { clamp01, easeInOut, easeOutBack, iso, lerp } from './project';
import { NetworkScene, type Camera } from './NetworkScene';
import { Sound } from './sound';
import { Stickers, type Features } from './stickers';
import { buildStory, type Chapter, type Story } from './story';
import { buildTimeline, chapterAt, seenSoFar, type Timeline } from './timeline';

/**
 * "Get example.com": drag the site card onto the laptop and watch it find the address, say hello and fetch
 * the page. Tap a packet on a cable to knock it off; tap it anywhere else to pop it open.
 */

/** Stormy weather happens on the internet side; the home cable stays calm. */
const STORM_LINKS = ['wan', 'bb1', 'bb2'];
const STORM_LOSS = 0.15;
let features: Features = { big: false, again: false };
/** Stormy weather is a switch you can flip any time, before or during a run. */
let stormy = false;
try {
  const saved = JSON.parse(localStorage.getItem('net.features') ?? '{}') as Partial<Features> & { storm?: boolean };
  features = { big: !!saved.big, again: !!saved.again };
  stormy = !!saved.storm;
} catch {
  // Nothing remembered; start plain.
}
function remember(): void {
  try {
    localStorage.setItem('net.features', JSON.stringify({ ...features, storm: stormy }));
  } catch {
    // Not remembered; fine.
  }
}
/** Packets the viewer knocked off, and how far along their cable they were (only for drawing the fall). */
const faults: ManualFault[] = [];
const knocks = new Map<string, number>();
/** Each run gets its own weather; knocking a packet off or flipping the storm re-runs with the same weather. */
let stormSeed = 1;
/** When (sim time) the storm was on during this run, and what the viewer has already seen happen. */
let stormWindows: LossWindow[] = [];
let decided: Record<string, boolean> = {};
let story: Story;
let tl: Timeline;
function simulate(): void {
  const scenario = fetchWebPage({ site: features.big ? 'info.cern.ch' : 'example.com', revisit: features.again });
  const plan = { randomLoss: STORM_LOSS, lossyLinks: STORM_LINKS, lossWindows: stormWindows, decided, manual: faults };
  story = buildStory(runScenario(scenario, { seed: stormSeed, faults: plan }));
  tl = buildTimeline(story, knocks);
}
simulate();

const root = document.querySelector<HTMLElement>('#app')!;
root.className = 'net';
const scene = new NetworkScene(root, story!, tl!);
const svg = scene.svg;
const sound = new Sound();
try {
  sound.muted = localStorage.getItem('net.muted') === '1';
} catch {
  // Storage can be blocked; sound simply starts on.
}

// The site card you drag onto the laptop.
const home = iso(-4.6, 0.4, 3.0);
const card = el('g', { class: 'site-card' }, svg);
const cardBody = el('g', {}, card);
el('rect', { x: -88, y: -22, width: 176, height: 44, rx: 10, class: 'site-card-bg' }, cardBody);
el('circle', { cx: -66, cy: 0, r: 9, class: 'site-card-globe' }, cardBody);
el('ellipse', { cx: -66, cy: 0, rx: 4, ry: 9, class: 'site-card-globe' }, cardBody);
const cardText = el('text', { x: 12, y: 0, dy: '0.35em', 'text-anchor': 'middle' }, cardBody);
cardText.textContent = 'example.com';
const hint = el('text', { class: 'hint', 'text-anchor': 'middle', x: 0, y: 44 }, card);
hint.textContent = 'drag me onto the laptop';
let cardPop = 9;

// The sticker sheet above the card: switch features on by sticking them onto the card.
const stickers = new Stickers(svg, features, (f) => {
  features = f;
  remember();
  showFeatures();
  sound.play('snap');
});
function showFeatures(): void {
  const site = features.big ? 'info.cern.ch' : 'example.com';
  if (cardText.textContent !== site) {
    cardText.textContent = site;
    cardPop = 0;
  }
  scene.setStorm(stormy ? STORM_LINKS : []);
}
showFeatures();
cardPop = 9;

const CHAPTERS: Record<Chapter, [string, string]> = { dns: ['1', 'Find the address'], hello: ['2', 'Say hello'], page: ['3', 'Get the page'] };
const chapter = document.createElement('div');
chapter.className = 'chapter';
chapter.hidden = true;
root.appendChild(chapter);
let shownChapter: Chapter | null = null;

const controls = document.createElement('div');
controls.className = 'net-controls';
const button = (text: string, onClick: () => void): HTMLButtonElement => {
  const b = document.createElement('button');
  b.textContent = text;
  b.addEventListener('click', onClick);
  controls.appendChild(b);
  return b;
};
const pauseBtn = button('', togglePause);
const speedBtn = button('1×', () => {
  speed = speed === 1 ? 2 : 1;
});
const soundBtn = button('♪', () => {
  sound.muted = !sound.muted;
  try {
    localStorage.setItem('net.muted', sound.muted ? '1' : '0');
  } catch {
    // Not remembered; fine.
  }
});
// The storm switch works any time. Mid-run it re-simulates from this moment on: everything already seen stays.
const stormBtn = button('⚡ Storm', toggleStorm);
function toggleStorm(): void {
  stormy = !stormy;
  remember();
  if (mode === 'play') {
    const seen = seenSoFar(tl, v);
    decided = { ...decided, ...seen.decided };
    if (stormy) stormWindows = [...stormWindows, { from: seen.now }];
    else stormWindows = stormWindows.map((w) => (w.to === undefined ? { ...w, to: seen.now } : w));
    simulate();
    scene.setStory(story, tl);
  }
  showFeatures();
  sound.play(stormy ? 'zap' : 'snap');
}
const followBtn = button('◎ Follow packet', () => {
  camFree = false;
});
const againBtn = button('↺ Again', reset);
// At the end: go round once more, now with the address remembered.
const visitBtn = button('↻ Visit again', visitAgain);
root.appendChild(controls);

type Mode = 'idle' | 'drag' | 'spring' | 'drop' | 'play';
let mode: Mode = 'idle';
let v = 0;
let speed = 1;
let paused = false;
let peek = 0;
let peekTarget = 0;
let cardPos = { ...home };
let anim = { from: { ...home }, to: { ...home }, t: 0, dur: 0.4 };
let grab = { dx: 0, dy: 0 };
let cam: Camera = scene.overviewCamera();
let snapCamera = false;
/** Set once the viewer pans or zooms by hand; the camera stops following until they ask again. */
let camFree = false;
/** Sounds already played up to this visual time (so a knock doesn't bonk twice). */
let cueDone = 0;

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
  const drop = scene.laptopDropPoint();
  card.classList.toggle('over', Math.hypot(cardPos.sx - drop.sx, cardPos.sy - drop.sy) < 130);
});
card.addEventListener('pointerup', () => {
  if (mode !== 'drag') return;
  card.classList.remove('held', 'over');
  const drop = scene.laptopDropPoint();
  const onLaptop = Math.hypot(cardPos.sx - drop.sx, cardPos.sy - drop.sy) < 130;
  anim = { from: { ...cardPos }, to: onLaptop ? drop : { ...home }, t: 0, dur: onLaptop ? 0.35 : 0.5 };
  mode = onLaptop ? 'drop' : 'spring';
  if (onLaptop) {
    camFree = false;
    sound.play('pop');
  }
});

// Tap a packet out on a cable to knock it off; anywhere else, tap it to pop it open.
scene.packet.addEventListener('pointerdown', () => {
  if (mode !== 'play' || v >= tl.total) return;
  const target = !paused && !peekTarget ? scene.knockable(v) : null;
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
  if ((e.target as Element).closest('.site-card, .packet')) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  svg.setPointerCapture(e.pointerId);
  camFree = true;
  svg.classList.add('panning');
});
svg.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
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

function togglePause(): void {
  if (mode !== 'play') return;
  if (peekTarget) peekTarget = 0;
  else paused = !paused;
}
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    togglePause();
  }
});

function reset(): void {
  mode = 'idle';
  v = 0;
  cueDone = 0;
  paused = false;
  peek = peekTarget = 0;
  cardPos = { ...home };
  camFree = false;
}

/** The card has gone into the laptop: run the simulation with the chosen stickers, fresh weather and no knocks. */
function beginRun(): void {
  faults.length = 0;
  knocks.clear();
  stormSeed = 1 + Math.floor(Math.random() * 1e6);
  decided = {};
  stormWindows = stormy ? [{ from: 0 }] : [];
  simulate();
  scene.setStory(story, tl);
  showFeatures();
  mode = 'play';
  v = 0;
  cueDone = 0;
  paused = false;
  peek = peekTarget = 0;
}

/** Back to the start with the "Visit again" sticker on, and the card flies straight into the laptop. */
function visitAgain(): void {
  reset();
  stickers.set('again', true);
  anim = { from: { ...home }, to: scene.laptopDropPoint(), t: -0.5, dur: 0.6 };
  mode = 'drop';
}

let last = performance.now();
let clock = 0;
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  clock += dt;

  if (mode === 'spring' || mode === 'drop') {
    anim.t += dt;
    const k = clamp01(anim.t / anim.dur);
    const e = mode === 'spring' ? easeOutBack(k) : easeInOut(k);
    cardPos = { sx: lerp(anim.from.sx, anim.to.sx, e), sy: lerp(anim.from.sy, anim.to.sy, e) };
    if (k >= 1) {
      if (mode === 'drop') beginRun();
      else mode = 'idle';
    }
  }
  if (mode === 'play' && !paused && !peekTarget) {
    const next = Math.min(tl.total, v + dt * speed);
    for (const c of tl.cues) if (c.t > Math.max(v, cueDone) && c.t <= next) sound.play(c.sound);
    v = next;
  }
  peek += (peekTarget - peek) * Math.min(1, dt * 10);

  const bob = mode === 'idle' ? Math.sin(clock * 2.4) * 4 : 0;
  const dropK = mode === 'drop' ? clamp01(anim.t / anim.dur) : 0;
  cardPop += dt;
  const pop = cardPop < 0.4 ? 1 + 0.12 * Math.sin((cardPop / 0.4) * Math.PI) : 1;
  const scale = (mode === 'drop' ? 1 - 0.8 * dropK : mode === 'drag' ? 1.06 : 1) * pop;
  card.style.display = mode === 'play' ? 'none' : '';
  card.setAttribute('transform', `translate(${cardPos.sx.toFixed(1)} ${(cardPos.sy + bob).toFixed(1)}) scale(${scale.toFixed(3)})`);
  card.setAttribute('opacity', (1 - dropK).toFixed(3));
  hint.style.display = mode === 'idle' ? '' : 'none';
  stickers.update(dt, home, { sx: cardPos.sx, sy: cardPos.sy + bob }, scale, 1 - dropK, mode !== 'play');
  scene.renderStorm(clock);

  // The camera eases between the whole network (before the start) and a close follow of the packet,
  // unless the viewer has taken it over.
  if (!camFree) {
    const target = mode === 'play' ? scene.followCamera(v) : scene.overviewCamera();
    const ease = snapCamera ? 1 : Math.min(1, dt * 3.5);
    cam = { cx: lerp(cam.cx, target.cx, ease), cy: lerp(cam.cy, target.cy, ease), scale: lerp(cam.scale, target.scale, ease) };
  }
  snapCamera = false;
  scene.applyCamera(cam);

  scene.render(mode === 'play' ? v : -1);
  scene.drawPacket(mode === 'play' ? v : -1, peek);
  scene.packet.classList.toggle('knockable', mode === 'play' && !paused && !peekTarget && !!scene.knockable(v));

  const ch = mode === 'play' ? chapterAt(tl, v) : null;
  if (ch !== shownChapter) {
    shownChapter = ch;
    chapter.hidden = !ch;
    if (ch) {
      const [n, name] = CHAPTERS[ch];
      chapter.innerHTML = `<span class="chapter-num">${n}</span><span>${name}</span>`;
      chapter.classList.remove('enter');
      void chapter.offsetWidth;
      chapter.classList.add('enter');
    }
  }

  const done = mode === 'play' && v >= tl.total;
  pauseBtn.textContent = paused || peekTarget ? '▶ Play' : '⏸ Pause';
  pauseBtn.disabled = done;
  speedBtn.textContent = speed === 1 ? '1×' : '2×';
  soundBtn.classList.toggle('off', sound.muted);
  soundBtn.setAttribute('aria-label', sound.muted ? 'Sound off' : 'Sound on');
  againBtn.classList.toggle('big', done);
  visitBtn.hidden = !done;
  visitBtn.classList.toggle('big', done);
  followBtn.hidden = !camFree;
  followBtn.textContent = mode === 'play' ? '◎ Follow packet' : '◎ Show all';
  // Before the start only the follow button can show (after the viewer moved the view).
  pauseBtn.hidden = speedBtn.hidden = againBtn.hidden = mode !== 'play';
  stormBtn.classList.toggle('on', stormy);
  stormBtn.setAttribute('aria-pressed', String(stormy));
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

if (import.meta.env.DEV) {
  Object.assign(window, {
    __net: {
      get total() {
        return tl.total;
      },
      get segs() {
        return tl.segs.map((s) => ({ kind: s.step.kind, t0: s.t0, t1: s.t1, chapter: s.trip.chapter, device: 'device' in s.step ? s.step.device : `${s.step.from}→${s.step.to}` }));
      },
      seek(t: number, open = 0): void {
        mode = 'play';
        v = t;
        paused = true;
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
      reset,
      get reactions() {
        return tl.reactions;
      },
      /** Start a run straight away with these stickers (for screenshots). */
      start(f: Partial<Features> & { storm?: boolean }): void {
        for (const k of ['big', 'again'] as const) stickers.set(k, !!f[k]);
        if (!!f.storm !== stormy) toggleStorm();
        beginRun();
        stormSeed = 1;
        simulate();
        scene.setStory(story, tl);
      },
    },
  });
}

import './network.css';
import { fetchWebPage, runScenario } from '../sim';
import { el } from '../ui/scene/svg';
import { clamp01, easeInOut, easeOutBack, iso, lerp } from '../ui/iso/project';
import { NetworkScene, type Camera } from './NetworkScene';
import { buildStory } from './story';
import { buildTimeline } from './timeline';

/**
 * "Get example.com", the simple version: drag the site card onto the laptop, watch one request go
 * out and the page come back. Click the packet to pop it open.
 */

const story = buildStory(runScenario(fetchWebPage(), { seed: 1 }));
const tl = buildTimeline(story);

const root = document.querySelector<HTMLElement>('#app')!;
root.className = 'net';
const scene = new NetworkScene(root, story, tl);
const svg = scene.svg;

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

const controls = document.createElement('div');
controls.className = 'net-controls';
const pauseBtn = document.createElement('button');
const followBtn = document.createElement('button');
followBtn.textContent = '◎ Follow packet';
const againBtn = document.createElement('button');
againBtn.textContent = '↺ Again';
controls.append(pauseBtn, followBtn, againBtn);
root.appendChild(controls);

type Mode = 'idle' | 'drag' | 'spring' | 'drop' | 'play';
let mode: Mode = 'idle';
let v = 0;
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
  if (onLaptop) camFree = false;
});

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

scene.packet.addEventListener('pointerdown', () => {
  if (mode === 'play' && v < tl.total) peekTarget = peekTarget ? 0 : 1;
});

function togglePause(): void {
  if (mode !== 'play') return;
  if (peekTarget) peekTarget = 0;
  else paused = !paused;
}
pauseBtn.addEventListener('click', togglePause);
followBtn.addEventListener('click', () => {
  camFree = false;
});
againBtn.addEventListener('click', reset);
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    togglePause();
  }
});

function reset(): void {
  mode = 'idle';
  v = 0;
  paused = false;
  peek = peekTarget = 0;
  cardPos = { ...home };
  camFree = false;
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
    if (k >= 1) mode = mode === 'drop' ? 'play' : 'idle';
  }
  if (mode === 'play' && !paused && !peekTarget) v = Math.min(tl.total, v + dt);
  peek += (peekTarget - peek) * Math.min(1, dt * 10);

  const bob = mode === 'idle' ? Math.sin(clock * 2.4) * 4 : 0;
  const dropK = mode === 'drop' ? clamp01(anim.t / anim.dur) : 0;
  const scale = mode === 'drop' ? 1 - 0.8 * dropK : mode === 'drag' ? 1.06 : 1;
  card.style.display = mode === 'play' ? 'none' : '';
  card.setAttribute('transform', `translate(${cardPos.sx.toFixed(1)} ${(cardPos.sy + bob).toFixed(1)}) scale(${scale.toFixed(3)})`);
  card.setAttribute('opacity', (1 - dropK).toFixed(3));
  hint.style.display = mode === 'idle' ? '' : 'none';

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
  scene.packet.classList.toggle('peeking', peekTarget > 0);

  pauseBtn.textContent = paused || peekTarget ? '▶ Play' : '⏸ Pause';
  pauseBtn.disabled = mode !== 'play' || v >= tl.total;
  againBtn.classList.toggle('big', mode === 'play' && v >= tl.total);
  followBtn.hidden = !camFree;
  followBtn.textContent = mode === 'play' ? '◎ Follow packet' : '◎ Show all';
  // Before the start only the follow button can show (after the viewer moved the view).
  pauseBtn.hidden = againBtn.hidden = mode !== 'play';
  controls.style.visibility = mode === 'play' || camFree ? '' : 'hidden';
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

if (import.meta.env.DEV) {
  Object.assign(window, {
    __net: {
      total: tl.total,
      segs: tl.segs.map((s) => ({ kind: s.step.kind, t0: s.t0, t1: s.t1, device: 'device' in s.step ? s.step.device : `${s.step.from}→${s.step.to}` })),
      seek(t: number, open = 0): void {
        mode = 'play';
        v = t;
        paused = true;
        peek = peekTarget = open;
        snapCamera = true;
        camFree = false;
      },
    },
  });
}

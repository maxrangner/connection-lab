// Goes through the page the way a careful viewer would and reports what looks wrong. Needs `npm run dev` running.
//
//   node scripts/look.mjs [out-dir] [--only=text] [--phone] [--small] [--desk] [--every=n]
//
// At each stop it asks the browser what is really drawn at each point, top to bottom, so it works on the true shapes of
// things and needs no borders kept by hand. Then it applies the rules below: a packet may cross a router, but a window may
// not stand on a device. Writes report.json and one picture of the first time each kind of problem shows, and with --every
// a picture of every nth stop as well, for a person to look through.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) ?? 'look-out';
const only = args.find((a) => a.startsWith('--only='))?.slice(7);
mkdirSync(out, { recursive: true });

const SIZES = [
  { name: 'phone', width: 412, height: 800, step: 7 },
  { name: 'small', width: 360, height: 640, step: 7 },
  { name: 'desk', width: 1280, height: 760, step: 11 },
].filter((s, _, all) => !all.some((x) => args.includes(`--${x.name}`)) || args.includes(`--${s.name}`));
const every = Number(args.find((a) => a.startsWith('--every='))?.slice(8) ?? 0);
const HOMES = [
  { name: 'no-smart', setup: {} },
  { name: 'home-broker', setup: { smart: true } },
  { name: 'cloud-broker', setup: { smart: true, cloud: true } },
];
const ATTACKS = [[], ['listen'], ['flood'], ['scan'], ['listen', 'flood', 'scan']];
const JOBS = [
  { name: 'reading', run: { reading: true }, smart: true },
  { name: 'page-laptop', run: {} },
  { name: 'page-phone', run: { from: 'phone' } },
  { name: 'call-phone', run: { call: true, from: 'phone' } },
  { name: 'ping-phone', run: { ping: true, from: 'phone' } },
  { name: 'ping-laptop', run: { ping: true } },
  { name: 'trace-laptop', run: { trace: true } },
  { name: 'page-plus-call', run: {}, join: 'call' },
];
const EXTRAS = [
  { name: 'vpn', run: { vpn: true } },
  { name: 'cold', run: { cold: true } },
  { name: 'https', run: { https: true } },
  { name: 'satellite', run: { slow: true } },
  { name: 'dhcp', run: { dhcp: true, from: 'phone' } },
  { name: 'big', run: { big: true } },
  { name: 'spy', run: { spy: 'wan' } },
  { name: 'cut', run: { cut: 'wan' } },
];
const STOPS = 20;

/** Runs in the page: what is at each point, and who is over whom. */
function look(step) {
  const seen = new WeakMap();
  const faded = (e) => {
    if (seen.has(e)) return seen.get(e);
    const own = Number(e.getAttribute?.('opacity') ?? 1) * Number(e.style?.opacity || 1);
    const gone = own < 0.15 || (e.parentElement ? faded(e.parentElement) : false);
    seen.set(e, gone);
    return gone;
  };
  const OVERLAY = [['button.action-menu', 'pill'], ['.net-controls', 'bar'], ['.chapter', 'chapter'], ['.real-clock', 'clock'], ['.follow', 'follow'], ['.logo', 'logo'], ['.spy-card', 'spy'], ['.menu-panel', 'menu']];
  const ownerOf = (e) => {
    if (faded(e)) return null;
    const dev = e.closest('[data-id]');
    if (dev) return `${e.classList.contains('device-name') ? 'name' : 'device'}:${dev.getAttribute('data-id')}`;
    if (e.closest('.cables, .hover, .spy')) return null;
    if (e.closest('.trays, .packet, .tags, .keys, .pill-panel, .fx')) return 'packet';
    const mood = e.closest('.mood');
    if (mood) return mood.querySelector('.term-bg') ? 'term' : mood.querySelector('.speech-bg') ? 'speech' : mood.querySelector('.hop-bg') ? 'flag' : null;
    if (e.closest('.note')) return null;
    if (e.closest('.site-card, .hint')) return 'card';
    for (const [selector, name] of OVERLAY) if (e.closest(selector)) return name;
    return null;
  };
  const area = {};
  const over = {};
  const points = {};
  const w = window.innerWidth;
  const h = window.innerHeight;
  for (let y = step / 2; y < h; y += step) {
    for (let x = step / 2; x < w; x += step) {
      const stack = [...new Set(document.elementsFromPoint(x, y).map(ownerOf).filter(Boolean))];
      stack.forEach((owner, i) => {
        area[owner] = (area[owner] ?? 0) + 1;
        if (owner.startsWith('device:')) (points[owner] ??= []).push([x, y]);
        for (const under of stack.slice(i + 1)) {
          const key = `${owner}>${under}`;
          over[key] = (over[key] ?? 0) + 1;
        }
      });
    }
  }
  // What sticks out past the edge of the screen, in the real size of each thing.
  const cut = [];
  for (const [selector, name] of [['.packet', 'packet'], ['.tags', 'packet'], ['.mood', 'speech']]) {
    for (const e of document.querySelectorAll(selector)) {
      if (e.closest('[style*="display: none"]') || !e.getBBox) continue;
      // What a device prints stays by it when the camera goes elsewhere.
      if (name === 'speech' && !e.querySelector('.speech-bg')) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 4 || faded(e)) continue;
      const past = Math.max(0, -r.left) + Math.max(0, r.right - w);
      if (past > r.width * 0.2) cut.push(name);
    }
  }
  // Devices the viewer has been told are on the table but cannot see.
  const devices = {};
  for (const e of document.querySelectorAll('[data-id]')) {
    if (e.classList.contains('absent')) continue;
    const r = e.getBoundingClientRect();
    if (r.width) devices[e.getAttribute('data-id')] = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }
  const waiting = [...document.querySelectorAll('.mood.absent .term-red')].length > 0;
  return { area, over, points, cut, devices, waiting, size: [w, h] };
}

const TOP_THINGS = ['pill', 'term', 'speech', 'flag', 'follow', 'clock', 'chapter', 'logo', 'spy'];
const share = (n, of) => (of ? n / of : 0);

/** The rules. `whole`: the camera is meant to be showing the whole table. */
function judge(l, whole, scale, step) {
  const found = [];
  const say = (kind, what, amount) => found.push({ kind, what, amount: Math.round(amount * 100) / 100 });
  const ids = Object.keys(l.points);
  // Devices on devices, and in a whole view devices that nearly touch.
  for (const [key, n] of Object.entries(l.over)) {
    const [top, under] = key.split('>');
    if (top.startsWith('device:') && under.startsWith('device:') && n >= 2) say('devices-overlap', [top, under].sort().join(' + ').replaceAll('device:', ''), n);
    if (under.startsWith('name:') && !top.startsWith('name:') && top !== 'packet' && top !== 'bar') {
      const s = share(n, l.area[under]);
      if (s > 0.15) say('name-hidden', `${top.replace('device:', '')} over ${under.slice(5)}`, s);
    }
    if (under.startsWith('name:') && top.startsWith('name:')) say('names-overlap', [top, under].map((x) => x.slice(5)).sort().join(' + '), n);
    if (TOP_THINGS.includes(top) && under.startsWith('device:')) {
      const s = share(n, l.area[under]);
      if (s > 0.1) say('covers-device', `${top} over ${under.slice(7)}`, s);
    }
    if (top === 'bar' && under.startsWith('device:') && whole && share(n, l.area[under]) > 0.1) say('covers-device', `bar over ${under.slice(7)}`, share(n, l.area[under]));
    if (TOP_THINGS.includes(top) && under === 'packet' && share(n, l.area.packet) > 0.15) say('covers-packet', top, share(n, l.area.packet));
    if (top === 'bar' && under === 'packet' && share(n, l.area.packet) > 0.15) say('covers-packet', 'bar', share(n, l.area.packet));
    if (TOP_THINGS.includes(top) && TOP_THINGS.includes(under) && n >= 3) say('overlays-overlap', [top, under].sort().join(' + '), n);
    if ((top === 'term' || top === 'speech') && under === 'card' && n >= 3) say('overlays-overlap', `${top} + cards`, n);
  }
  for (const c of new Set(l.cut)) say('cut-off', c, 1);
  if (whole) {
    if (l.waiting) say('window-hidden', 'stranger', 1);
    for (const [id, r] of Object.entries(l.devices)) {
      if (r.left < -4 || r.right > l.size[0] + 4 || r.top < -4) say('off-screen', id, 1);
    }
    // The gap between two devices, in the units of the world, so it does not depend on the zoom.
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        let least = Infinity;
        for (const [ax, ay] of l.points[ids[i]]) for (const [bx, by] of l.points[ids[j]]) least = Math.min(least, Math.hypot(ax - bx, ay - by));
        const gap = least / scale;
        if (gap < 28 + step / scale) say('nearly-touching', [ids[i], ids[j]].sort().join(' + ').replaceAll('device:', ''), gap);
      }
    }
  }
  return found;
}

const browser = await chromium.launch();
const problems = new Map();
const errors = [];
let stops = 0;
const started = Date.now();
const note = (where, f, page, shots) => {
  const key = `${f.kind}: ${f.what}`;
  const p = problems.get(key) ?? { ...f, key, count: 0, sizes: new Set(), first: where, picture: null, worst: 0 };
  p.count++;
  p.sizes.add(where.split('/')[0]);
  p.worst = Math.max(p.worst, f.amount);
  problems.set(key, p);
  if (!p.picture) {
    p.picture = `${String(problems.size).padStart(3, '0')}-${f.kind}.png`;
    shots.push(page.screenshot({ path: `${out}/${p.picture}` }));
  }
};

for (const size of SIZES) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, colorScheme: 'dark', hasTouch: size.name !== 'desk' });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:5173/');
  // Everything counts as there, and a button's invisible tap area does not.
  await page.addStyleTag({ content: 'svg *, .net * , .net { pointer-events: auto !important; } button.action-menu::before { display: none !important; }' });
  await page.waitForTimeout(500);
  const frames = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const check = async (where, whole) => {
    await frames();
    const scale = (await page.evaluate(() => window.__net.camera)).scale;
    const l = await page.evaluate(look, size.step);
    stops++;
    const shots = [];
    if (every && stops % every === 0) shots.push(page.screenshot({ path: `${out}/sample-${size.name}-${String(stops).padStart(5, '0')}.png` }));
    for (const f of judge(l, whole, scale, size.step)) note(where, f, page, shots);
    await Promise.all(shots);
  };
  const combos = [];
  for (const home of HOMES) {
    for (const attack of ATTACKS) {
      for (const job of JOBS) if (!job.smart || home.setup.smart) combos.push({ home, attack, job });
    }
  }
  for (const job of EXTRAS) combos.push({ home: HOMES[0], attack: [], job }, { home: HOMES[1], attack: ['listen'], job });
  for (const { home, attack, job } of combos) {
    const name = `${size.name}/${home.name}/${attack.join('+') || 'no-attack'}/${job.name}`;
    if (only && !name.includes(only)) continue;
    await page.evaluate(({ setup, attack }) => {
      window.__net.setup(setup);
      for (const id of ['listen', 'flood', 'scan']) window.__net.attack(id, attack.includes(id));
    }, { setup: home.setup, attack });
    // Before anything has run.
    await page.waitForTimeout(350);
    await check(`${name}/before`, attack.length > 0);
    await page.evaluate(({ run, setup }) => window.__net.start({ ...setup, ...run }), { run: job.run, setup: home.setup });
    await page.waitForTimeout(60);
    if (job.join) {
      await page.evaluate(() => window.__net.seek(window.__net.total * 0.15));
      await frames();
      await page.evaluate((j) => window.__net.join(j), job.join);
      await frames();
    }
    const wide = attack.includes('flood') || attack.includes('scan') || !!job.join;
    const total = await page.evaluate(() => window.__net.total);
    for (let i = 0; i <= STOPS; i++) {
      const t = (total * (job.join ? 0.15 + (0.85 * i) / STOPS : i / STOPS)) * 0.999;
      // Twice: what has come onto the table by then is known a frame after the camera has jumped there.
      await page.evaluate((x) => window.__net.seek(x), t);
      await frames();
      await page.evaluate((x) => window.__net.seek(x), t);
      await check(`${name}/v${t.toFixed(1)}`, wide);
    }
    // The camera on a reading must not bounce between places.
    const bounces = await page.evaluate(() => {
      const path = window.__net.path(0.25);
      const far = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy) * a.scale;
      const screen = Math.min(window.innerWidth, window.innerHeight) * 0.6;
      const found = [];
      for (let i = 4; i + 4 < path.length; i++) {
        const [a, b, c] = [path[i - 4], path[i], path[i + 4]];
        if (far(a, b) > screen && far(b, c) > screen && far(a, c) < screen / 4 && a.scale === b.scale) found.push(b.v);
      }
      return found;
    });
    if (bounces.length) {
      const shots = [];
      note(`${name}/v${bounces[0]}`, { kind: 'camera-bounce', what: job.name, amount: bounces.length }, page, shots);
      await Promise.all(shots);
    }
    await page.evaluate(() => window.__net.finish());
    await page.waitForFunction(() => window.__net.mode === 'idle', null, { timeout: 15000 }).catch(() => errors.push(`never came to rest: ${name}`));
    await page.waitForTimeout(450);
    await check(`${name}/after`, false);
    // Show all, if it is there to press.
    const follow = await page.$('.follow:not([hidden])');
    if (follow) {
      await follow.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1300);
    }
    await check(`${name}/whole`, true);
  }
  await context.close();
}
await browser.close();

const report = [...problems.values()].map((p) => ({ ...p, sizes: [...p.sizes] })).sort((a, b) => a.kind.localeCompare(b.kind) || b.count - a.count);
writeFileSync(`${out}/report.json`, JSON.stringify({ stops, seconds: Math.round((Date.now() - started) / 1000), errors, report }, null, 1));
console.log(`${stops} stops in ${Math.round((Date.now() - started) / 1000)} s, ${report.length} kinds of problem, ${errors.length} errors`);
for (const p of report) console.log(`${String(p.count).padStart(5)}  ${p.key}  (${p.sizes.join(',')})  ${p.picture}  first: ${p.first}`);
for (const e of [...new Set(errors)].slice(0, 20)) console.log('ERROR', e);

// Visual check of the simple network page (network.html): the intro, then key moments of the story.
// Usage: node scripts/screenshot-network.mjs [baseUrl] [outDir] [width] [height]
// Requires `npm run dev` running. Uses the dev-only window.__net hook (see src/network/main.ts).
import { chromium } from 'playwright';
import fs from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5173/network.html';
const out = process.argv[3] ?? 'screenshots/network';
const width = Number(process.argv[4] ?? 1440);
const height = Number(process.argv[5] ?? 900);
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(base);
await page.waitForFunction(() => !!window.__net);
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/00-intro.png` });

const segs = await page.evaluate(() => window.__net.segs);
fs.writeFileSync(`${out}/segs.json`, JSON.stringify(segs, null, 2));
// Each shot: [segment index, progress within it, peek].
const pick = (pred, n = 0) => segs.map((s, i) => [s, i]).filter(([s]) => pred(s))[n]?.[1];
const shots = process.env.SHOTS
  ? process.env.SHOTS.split(',').map((x) => [Number(x), 0, 0, `v${x}`])
  : [
      [pick((s) => s.kind === 'wrap'), 0.75, 0, 'laptop-tcp'],
      [pick((s) => s.kind === 'wrap', 2), 0.7, 0, 'laptop-eth'],
      [pick((s) => s.kind === 'travel'), 0.5, 0, 'wire'],
      [pick((s) => s.kind === 'travel'), 0.5, 1, 'peek'],
      [pick((s) => s.kind === 'unwrap'), 0.7, 0, 'home-eth-off'],
      [pick((s) => s.kind === 'nat'), 0.75, 0, 'home-nat'],
      [pick((s) => s.kind === 'wrap', 4), 0.7, 0, 'isp-new-sleeve'],
      [pick((s) => s.kind === 'unwrap', 4), 0.7, 0, 'server-tcp-off'],
      [pick((s) => s.kind === 'read'), 0.5, 0, 'server-read'],
      [pick((s) => s.kind === 'travel', 4), 0.5, 0, 'response-wire'],
      [segs.length - 1, 1, 0, 'end'],
    ];
let i = 1;
for (const [idx, k, peek, name] of shots) {
  const v = process.env.SHOTS ? idx : segs[idx].t0 + (segs[idx].t1 - segs[idx].t0) * k;
  await page.evaluate(([v, p]) => window.__net.seek(v, p), [v, peek]);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${out}/${String(i++).padStart(2, '0')}-${name}.png` });
}
console.log(`${segs.length} steps`);
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors');
await browser.close();

// Visual check of the page: the intro, then key moments of the story.
// Usage: node scripts/screenshot.mjs [baseUrl] [outDir] [width] [height]
// Requires `npm run dev` running. Uses the dev-only window.__net hook (see src/ui/main.ts).
import { chromium } from 'playwright';
import fs from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5173/';
const out = process.argv[3] ?? 'screenshots/main';
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
// Each shot: [segment index, progress within it, peek, name]. Picks by step kind and chapter.
const pick = (pred, n = 0) => segs.map((s, i) => [s, i]).filter(([s]) => pred(s))[n]?.[1];
const shots = process.env.SHOTS
  ? process.env.SHOTS.split(',').map((x) => [Number(x), 0, 0, `v${x}`])
  : [
      [pick((s) => s.kind === 'wrap'), 0.75, 0, 'dns-pack'],
      [pick((s) => s.kind === 'travel', 1), 0.5, 0, 'dns-wire'],
      [pick((s) => s.kind === 'wrap' && s.device === 'isp'), 0.2, 0, 'dns-turn'],
      [pick((s) => s.kind === 'travel', 2), 0.6, 0, 'dns-to-resolver'],
      [pick((s) => s.kind === 'read' && s.device === 'laptop'), 1, 0, 'dns-answer-on-screen'],
      [pick((s) => s.chapter === 'hello' && s.kind === 'travel', 1), 0.5, 0, 'syn-wire'],
      [pick((s) => s.chapter === 'page' && s.kind === 'travel'), 0.5, 1, 'get-peek'],
      [pick((s) => s.chapter === 'page' && s.kind === 'nat'), 0.75, 0, 'home-nat'],
      [pick((s) => s.chapter === 'page' && s.kind === 'unwrap'), 0.6, 0, 'sleeve-drop'],
      [segs.length - 1, 1, 0, 'end'],
    ];
let i = 1;
for (const [idx, k, peek, name] of shots) {
  const v = process.env.SHOTS ? idx : segs[idx].t0 + (segs[idx].t1 - segs[idx].t0) * k;
  await page.evaluate(([v, p]) => window.__net.seek(v, p), [v, peek]);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${out}/${String(i++).padStart(2, '0')}-${name}.png` });
}

// Knock the GET off the cable to the ISP and follow what happens.
if (!process.env.SHOTS) {
  const getWan = pick((s) => s.chapter === 'page' && s.kind === 'travel', 1);
  const kv = segs[getWan].t0 + (segs[getWan].t1 - segs[getWan].t0) * 0.5;
  await page.evaluate((v) => window.__net.knock(v), kv);
  const after = await page.evaluate(() => window.__net.segs);
  const lost = after.find((s) => s.kind === 'lost');
  const wait = after.find((s) => s.kind === 'wait');
  const moments = [
    [kv + 0.12, 'knock-burst'],
    [kv + 0.45, 'knock-flying'],
    [kv + 1.2, 'knock-apart'],
    [wait.t0 + (wait.t1 - wait.t0) * 0.6, 'timer'],
    [wait.t1 - 0.3, 'surprise'],
    [wait.t1 + 1.6, 'retry'],
  ];
  for (const [v, name] of moments) {
    await page.evaluate((v) => window.__net.seek(v), v);
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${out}/${String(i++).padStart(2, '0')}-${name}.png` });
  }
  console.log(`lost ${lost?.device}, wait ${wait?.device}`);
}
console.log(`${segs.length} steps`);
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors');
await browser.close();

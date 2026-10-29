// Visual check: opens the dev server in headless Chromium and saves screenshots.
// Usage: node scripts/screenshot.mjs [baseUrl] [outDir] [width] [height]
// Requires `npm run dev` running. Uses the dev-only window.__ie hook (see src/ui/App.ts).
import { chromium } from 'playwright';
import fs from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5173/';
const out = process.argv[3] ?? 'screenshots';
const width = Number(process.argv[4] ?? 1440);
const height = Number(process.argv[5] ?? 900);
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => !!window.__ie);
// Optional settings, e.g. SETTINGS='{"mss":536,"loss":0.15,"seed":4}'
if (process.env.SETTINGS) await page.evaluate((s) => window.__ie.settings(JSON.parse(s)), process.env.SETTINGS);
await page.waitForTimeout(2600);
await page.screenshot({ path: `${out}/00-intro.png` });

await page.evaluate(() => window.__ie.start());
await page.waitForTimeout(1800);
const info = await page.evaluate(() => window.__ie.info());
fs.writeFileSync(`${out}/info.json`, JSON.stringify(info, null, 2));

const shots = process.env.SHOTS
  ? process.env.SHOTS.split(',').map(Number)
  : info.bubbles.filter((_, i) => i % Math.ceil(info.bubbles.length / 14) === 0).map((b) => b.v + 0.6);
let i = 1;
for (const v of shots) {
  await page.evaluate((v) => window.__ie.seek(v), v);
  await page.waitForTimeout(1500); // let the follow camera settle
  await page.screenshot({ path: `${out}/${String(i++).padStart(2, '0')}-v${v.toFixed(1)}.png` });
}
console.log(`duration ${info.duration.toFixed(1)}s, ${info.bubbles.length} bubbles, ${info.flights.length} flights, ${info.gates.length} operator gates`);
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors');
await browser.close();

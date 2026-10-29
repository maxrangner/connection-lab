// Visual check of interactive flows (inspector, device panel, packet loss, OSI, tablet layout).
// Usage: node scripts/screenshot-flows.mjs [baseUrl] [outDir]   (requires `npm run dev`)
import { chromium } from 'playwright';
import fs from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5173/';
const out = process.argv[3] ?? 'screenshots/flows';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const errors = [];

async function open(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => !!window.__ie);
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__ie.start());
  await page.waitForTimeout(1500);
  return page;
}
const ie = (page, fn, arg) => page.evaluate(fn, arg);
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png` });

const page = await open(1440, 900);
let info = await ie(page, () => window.__ie.info());
const mid = (f) => (f.v0 + f.v1) / 2;
const http = info.flights.find((f) => f.label.startsWith('HTTP 200') && f.link === 'wan');
const syn = info.flights.find((f) => f.label === 'SYN' && f.link === 'wan');

await ie(page, ([id, v]) => window.__ie.pickFlight(id, v), [syn.id, mid(syn)]);
await page.waitForTimeout(1200);
await shot(page, '01-inspector-clean-syn');
await ie(page, () => window.__ie.settings({ detail: 'full' }));
await page.waitForTimeout(400);
await shot(page, '02-inspector-full-syn');
await ie(page, () => window.__ie.settings({ detail: 'hex' }));
await page.waitForTimeout(400);
await page.hover('.hb >> nth=40');
await shot(page, '03-inspector-hex-syn');
await ie(page, () => window.__ie.settings({ detail: 'clean' }));
await ie(page, ([id, v]) => window.__ie.pickFlight(id, v), [http.id, mid(http)]);
await page.waitForTimeout(1200);
await shot(page, '04-inspector-http');
await ie(page, (v) => window.__ie.seek(v), mid(http));
await ie(page, () => window.__ie.pickDevice('home'));
await page.waitForTimeout(600);
await shot(page, '05-device-home');

// Lose the response on the WAN link and look at the recovery.
await ie(page, (id) => window.__ie.lose(id), http.id);
await page.waitForTimeout(2500);
await shot(page, '06-lost');
info = await ie(page, () => window.__ie.info());
const retx = info.flights.find((f) => f.label.includes('retransmission') && f.link === 'bb2');
if (retx) {
  await ie(page, (v) => window.__ie.seek(v), retx.v0 - 2.5);
  await page.waitForTimeout(1500);
  await shot(page, '07-rto-before-retransmit');
  await ie(page, (v) => window.__ie.seek(v), mid(retx));
  await page.waitForTimeout(1500);
  await shot(page, '08-retransmission');
}

// OSI naming.
await ie(page, () => window.__ie.settings({ model: 'osi' }));
const dnsq = info.flights.find((f) => f.label.startsWith('DNS query') && f.link === 'wan');
await ie(page, (v) => window.__ie.seek(v), dnsq.v0 - 6);
await page.waitForTimeout(1500);
await shot(page, '09-osi');
await page.close();

// Tablet portrait.
const tab = await open(820, 1180);
const info2 = await ie(tab, () => window.__ie.info());
const f2 = info2.flights.find((f) => f.label.startsWith('DNS response') && f.link === 'lan');
await ie(tab, ([id, v]) => window.__ie.pickFlight(id, v), [f2.id, mid(f2)]);
await tab.waitForTimeout(1500);
await shot(tab, '10-tablet-inspector');
await tab.click('.inspector .icon-btn');
await tab.click('text=Settings');
await tab.waitForTimeout(500);
await shot(tab, '11-tablet-settings');
await tab.close();

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors');
await browser.close();

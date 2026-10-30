// Visual check of interactive flows: inspector, device panel, packet loss, operator gates, step-through, receipt,
// OSI names, tablet layout. Usage: node scripts/screenshot-flows.mjs [baseUrl] [outDir]   (requires `npm run dev`)
import { chromium } from 'playwright';
import fs from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5173/';
const out = process.argv[3] ?? 'screenshots/flows';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const errors = [];

async function open(width, height, settings) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => !!window.__ie);
  if (settings) await page.evaluate((s) => window.__ie.settings(s), settings);
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__ie.start());
  await page.waitForFunction(() => window.__ie.info().started, null, { timeout: 10000 });
  await page.waitForTimeout(300);
  return page;
}
const ie = (page, fn, arg) => page.evaluate(fn, arg);
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png` });
const mid = (f) => (f.v0 + f.v1) / 2;

// ── inspector + device + loss ──
{
  const page = await open(1440, 900);
  let info = await ie(page, () => window.__ie.info());
  const http = info.flights.find((f) => f.label.startsWith('HTTP 200') && f.link === 'wan');
  const syn = info.flights.find((f) => f.label === 'SYN' && f.link === 'wan');
  await ie(page, ([id, v]) => window.__ie.pickFlight(id, v), [syn.id, mid(syn)]);
  await page.waitForTimeout(1500);
  await shot(page, '01-inspector-clean-syn');
  await ie(page, () => window.__ie.settings({ detail: 'hex' }));
  await page.waitForTimeout(400);
  await shot(page, '02-inspector-hex-syn');
  await ie(page, () => window.__ie.settings({ detail: 'clean' }));
  await ie(page, (v) => window.__ie.seek(v), mid(http));
  await page.waitForTimeout(1500);
  await ie(page, () => window.__ie.pickDevice('home'));
  await page.waitForTimeout(600);
  await shot(page, '03-device-home');
  await ie(page, (id) => window.__ie.lose(id), http.id);
  await page.waitForTimeout(2200);
  await shot(page, '04-lost');
  info = await ie(page, () => window.__ie.info());
  const retx = info.flights.find((f) => f.label.includes('retransmission') && f.link === 'bb2');
  if (retx) {
    await ie(page, (v) => window.__ie.seek(v), retx.v0 - 2.5);
    await page.waitForTimeout(1500);
    await shot(page, '05-before-retransmit');
  }
  await ie(page, () => window.__ie.receipt());
  await page.waitForTimeout(500);
  await shot(page, '06-receipt');
  await ie(page, () => window.__ie.receipt());
  await ie(page, () => window.__ie.settings({ model: 'osi', camera: 'overview' }));
  await page.waitForTimeout(1500);
  await shot(page, '07-osi-overview');
  await page.close();
}

// ── operator mode: play into each gate, screenshot the waiting machine, release ──
{
  const page = await open(1440, 900, { operator: true });
  const info = await ie(page, () => window.__ie.info());
  for (const g of info.gates) {
    await ie(page, (v) => window.__ie.seek(v), g.v - 0.4);
    await ie(page, () => window.__ie.play());
    await page.waitForTimeout(1800);
    const blocked = await ie(page, () => window.__ie.info().blockedAt);
    console.log(`gate ${g.action}: blockedAt=${blocked?.toFixed?.(2)} (expected ${g.v.toFixed(2)})`);
    await shot(page, `08-operator-${g.action}`);
    await ie(page, () => window.__ie.release());
    await page.waitForTimeout(300);
  }
  await page.close();
}

// ── step-through bubbles ──
{
  const page = await open(1440, 900, { stepBubbles: true });
  // Only results and trouble are bubbles now: jump to just before the first one and play into it.
  const first = (await ie(page, () => window.__ie.info())).bubbles.find((b) => b.shown);
  await ie(page, (v) => window.__ie.seek(v), first.v - 0.5);
  await ie(page, () => window.__ie.play());
  await page.waitForTimeout(2000);
  const blocked = await ie(page, () => window.__ie.info().blockedAt);
  console.log(`step-through: blockedAt=${blocked?.toFixed?.(2)}`);
  await shot(page, '09-step-bubble');
  await page.click('.bubble.gate .bubble-ok');
  await page.waitForTimeout(1200);
  const after = await ie(page, () => window.__ie.info().blockedAt);
  console.log(`after click: blockedAt=${after?.toFixed?.(2) ?? 'none'}`);
  await page.close();
}

// ── tablet portrait ──
{
  const tab = await open(820, 1180);
  const info = await ie(tab, () => window.__ie.info());
  const f2 = info.flights.find((f) => f.label.startsWith('DNS response') && f.link === 'lan');
  await ie(tab, ([id, v]) => window.__ie.pickFlight(id, v), [f2.id, mid(f2)]);
  await tab.waitForTimeout(1500);
  await shot(tab, '10-tablet-inspector');
  await tab.click('.inspector .icon-btn');
  await ie(tab, (v) => window.__ie.seek(v), mid(f2));
  await tab.waitForTimeout(1500);
  await shot(tab, '11-tablet-scene');
  await tab.close();
}

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors');
await browser.close();

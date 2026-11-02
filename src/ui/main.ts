import './app.css';
import { version } from '../../package.json';
import { crossingKey, EVERY_JOB, fetchWebPage, OFFLINE_AT, RTP_SAMPLES_PER_PACKET, runScenario, ulawDecodeAll, type Attack, type Cut, type Job, type ManualFault } from '../sim';
import { el, setAttr, setText } from './svg';
import { clamp01, easeInOut, easeOutBack, iso, ISO_X, ISO_Y, lerp, U } from './project';
import { HexCard } from './hexCard';
import logoDark from './logo/logo-dark.png';
import logoLight from './logo/logo-light.png';
import { drawDoor, drawEar, drawGlobe, drawHandset, drawMoon, drawPadlock, drawPage, drawPause, drawPhoto, drawPing, drawPlay, drawPipe, drawSatellite, drawScissors, drawShield, drawSnowflake, drawSpyglass, drawSun, drawSwarm, drawTag, drawTalk, drawThermometer, drawTrace } from './icons';
import { KeepAwake } from './awake';
import { Menu } from './menus';
import { NetworkScene, type Camera, type CutSpan } from './NetworkScene';
import { Sound } from './sound';
import { SpyCard } from './spyCard';
import { buildStory, type Chapter, type PartKey, type Story } from './story';
import { buildTimeline, chapterAt, formatWait, joinAt, MAX_STRETCH, NO_PAST, pastAt, pduAt, realAt, ridingOn, seenSoFar, segAt, spyLog, stepTarget, wanDelayFor, type Past, type Timeline } from './timeline';

/**
 * Connection Lab. Drag a card onto the laptop or the phone. The bar below holds the playback buttons, and popups for the
 * speed, the tools you click lines with, the setup of the next run, and the attackers on the table.
 * Tap a packet to pop it open. When a run ends the card comes back. During a run every device with nothing to do has a
 * "+ action" button, which starts something on it alongside.
 */

/** Seconds the finished picture stays before the card comes back. */
const LINGER = 1.4;
/** Seconds after the start of a step in which back goes to the step before it. */
const BACK_GRACE = 1;

/** What this browser remembers. Storage can be blocked, or hold anything: then nothing is remembered, and the page starts plain. */
const load = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const loadJson = <T>(key: string): Partial<T> => {
  try {
    return (JSON.parse(load(key) ?? '{}') ?? {}) as Partial<T>;
  } catch {
    return {};
  }
};
const save = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered; fine.
  }
};

/** What the next run is like, set from the Setup menu between runs: changing it mid-run would rewrite what happened. */
const SETTINGS = ['https', 'big', 'slow', 'vpn', 'dhcp', 'cold', 'thin', 'smart'] as const;
type Setting = (typeof SETTINGS)[number];
type Features = Record<Setting, boolean>;
// Only the Setup is remembered across visits: a cable left cut or a spyglass left out would make the next visit fail for no visible reason.
const savedFeatures = loadJson<Features>('net.features');
const features = Object.fromEntries(SETTINGS.map((k) => [k, !!savedFeatures[k]])) as Features;
/** The line the spyglass is on, if any. */
let spyLine: string | null = null;
/** The visual time it was put there: it can only read what passes from then on. */
let spyFrom = -Infinity;
/** The cables that are cut. They can change any time, before or during a run. */
const cutLines = new Set<string>();
/** Packets that fell when their cable was cut, and how far along it they were (only for drawing the fall). */
const faults: ManualFault[] = [];
const knocks = new Map<string, number>();
/** Each run gets its own seed; cutting a cable re-runs with the same one. */
let runSeed = 1;
/** What the viewer has already seen happen in this run. */
let decided: Record<string, boolean> = {};
/** What this run has shown, which a mended cable must not take back. */
let past: Past = NO_PAST;
/** When the cut cables are cut, for the picture. */
let cutSpans: CutSpan[] = [];
/** When (sim time) cables were cut during this run. */
let cuts: Cut[] = [];
/** A cable was already cut at the start of the run, so the ARP that would not get through is left out of it. */
let warmArp = false;
let story: Story;
let tl: Timeline;
/** Which device the card was dropped on: the laptop (Ethernet cable) or the phone (Wi-Fi). */
let client = 'laptop';
/** What each device still remembers from an earlier visit, until the DNS record's real TTL runs out. */
const known = new Map<string, { site: string; ip: string; until: number }>();
/** All a device remembers, per device and site: `known` is only what its screen shows. */
const memory = new Map<string, { site: string; ip: string; until: number }>();
/** This run is a second visit: the address is remembered, so there is nothing to look up. */
let revisit = false;
/** The address it remembers, held for the whole run: the memory itself can run out before the run does. */
let knownIp: string | undefined;
/** What a card on the table asks for: the page, or the photo. */
const isProbe = (w: Job): boolean => w === 'ping' || w === 'trace';
/** This run is the sensor taking a reading, not a card on a device. */
let reading = false;
/** The smart home's broker is out on the internet instead of at home, and how sure a reading is of arriving. */
const savedSmart = loadJson<{ cloud: boolean; qos: number }>('net.smart');
let cloud = !!savedSmart.cloud;
let qos: 0 | 1 | 2 = savedSmart.qos === 1 || savedSmart.qos === 2 ? savedSmart.qos : 0;
/** The card picked up last. */
let carried: Job = 'page';
const pageSite = (): 'info.cern.ch' | 'example.com' => (features.big ? 'info.cern.ch' : 'example.com');
const siteName = (): 'info.cern.ch' | 'example.com' | 'httpbin.org' => (carried === 'photo' ? 'httpbin.org' : pageSite());
/** The name the device will look up: a site, the friend to call, or the server a ping or trace goes to. */
const wantedName = (): string => (carried === 'call' ? 'sam.example' : isProbe(carried) ? 'example.com' : siteName());
const memoryKey = (device: string, site: string): string => `${device} ${site}`;
function remembers(): boolean {
  const k = memory.get(memoryKey(client, wantedName()));
  return !!k && performance.now() < k.until;
}
function recall(): void {
  revisit = remembers();
  const k = revisit ? memory.get(memoryKey(client, wantedName())) : undefined;
  knownIp = k?.ip;
  if (k) known.set(client, k);
}
/** Forget everything a device remembers. */
function forgetAll(device: string): void {
  known.delete(device);
  for (const key of memory.keys()) if (key.startsWith(`${device} `)) memory.delete(key);
}
function noteDown(device: string, k: { site: string; ip: string; until: number }): void {
  known.set(device, k);
  memory.set(memoryKey(device, k.site), k);
}
/** How far the ISP router has been dragged away, in tiles: the fibre gets longer and so does its delay. */
let stretch = 0;
/** The Wi-Fi has been shaken: this share of its frames is lost to interference, and the radio sends them again. */
let noise = 0;
const NOISY = 0.4;
/** Actions added during this run, each on a device of its own: what it asks for, and when in sim time and in visual time. */
let joined: { device: string; job: Job; at: number; v: number }[] = [];
const drops = (): Map<string, number> => new Map(joined.map((j) => [j.device, j.v]));
/** The attackers on the table. They stay from run to run, until they are switched off. */
const attacks = new Set<Attack>();
function simulate(): void {
  const scenario = fetchWebPage({
    // A ping or a trace goes to example.com's server, whatever page the Setup would fetch.
    site: reading || isProbe(carried) ? 'example.com' : siteName(),
    ...(reading ? { reading } : carried === 'ping' ? { probe: 'ping' as const } : carried === 'trace' ? { probe: 'traceroute' as const } : {}),
    revisit,
    ...(knownIp ? { knownIp } : {}),
    slow: features.slow,
    // A reading is the sensor's own connection: what the Setup does for a browser's is not part of it.
    vpn: features.vpn && !reading,
    https: features.https && !reading,
    from: client,
    warmArp,
    joins: joined,
    ...(attacks.size ? { attacks: [...attacks] } : {}),
    dhcp: features.dhcp && !reading,
    cold: features.cold && !reading,
    thin: features.thin,
    smart: features.smart,
    cloud,
    qos,
    call: carried === 'call' && !reading,
    ...(stretch > 0 ? { wanDelay: wanDelayFor(stretch) } : {}),
    ...(noise > 0 ? { noise } : {}),
  });
  const plan = { randomLoss: 0, decided, cuts, manual: faults };
  // Long enough for TCP to give up on a dead line (15 resends, backing off to a minute apart).
  // A device new on the network knows nobody yet, so it finds the router as well as getting an address.
  story = buildStory(runScenario(scenario, { seed: runSeed, faults: plan, maxTime: 1000 }), { arp: features.dhcp && !reading });
  tl = buildTimeline(story, knocks, stretch, drops(), past);
}
simulate();

const root = document.querySelector<HTMLElement>('#app')!;
root.className = 'net';
const scene = new NetworkScene(root, story!, tl!);
scene.setRemembered(known);
const svg = scene.svg;
const sound = new Sound();
const awake = new KeepAwake();
/** No speech bubbles. It changes nothing about a run, so unlike the Setup it can change during one. */
let quiet = load('net.quiet') === '1';
sound.muted = load('net.muted') === '1';

type Mode = 'idle' | 'drag' | 'spring' | 'drop' | 'play' | 'return';
let mode: Mode = 'idle';

// The cards rest on the table beside your devices, the middle of the stack level with the middle of the two of them.
const STACK_TOP = -60;
const STACK_BOTTOM = 270;
const middleOfYours = (iso(0, 0).sy + iso(8, 8).sy) / 2 - 30;
const home = { sx: iso(0, 7.4, 0.5).sx, sy: middleOfYours - (STACK_TOP + STACK_BOTTOM) / 2 };
const HOMES: Record<Job, { sx: number; sy: number }> = {
  page: home,
  photo: { sx: home.sx, sy: home.sy + 62 },
  call: { sx: home.sx, sy: home.sy + 124 },
  ping: { sx: home.sx, sy: home.sy + 186 },
  trace: { sx: home.sx, sy: home.sy + 248 },
};
const CARD_W = 176;
/** The widest a card gets on screen. The camera sets its size, which on a big screen would pass 300px. */
const CARD_MAX_PX = 160;
/** How far the cards are drawn down to keep to that, and the stack with them, around its middle: below that camera scale they are as they are. */
let cardFit = 1;
const stackMiddle = home.sy + 124;
const restAt = (job: Job): { sx: number; sy: number } => ({ sx: HOMES[job].sx, sy: stackMiddle + (HOMES[job].sy - stackMiddle) * cardFit });
/** Whether a run has started: until then the hint names a first thing to try. */
let played = false;
// Above the stack, as it goes for every card in it. The first card's badges stick out above it, so this clears them.
const HINT_OVER = 46;
const hint = el('text', { class: 'cards-hint', 'text-anchor': 'middle' }, svg);
const card = (text: string, draw: (g: SVGGElement) => void, transform: string): SVGGElement => {
  const c = el('g', { class: 'site-card' }, svg);
  const body = el('g', {}, c);
  el('rect', { x: -CARD_W / 2, y: -22, width: CARD_W, height: 44, rx: 10, class: 'site-card-bg' }, body);
  draw(el('g', { transform, class: 'site-card-globe' }, body));
  el('text', { x: 12, y: 0, dy: '0.35em', 'text-anchor': 'middle' }, body).textContent = text;
  return c;
};
const pageCard = card('example.com', drawGlobe, 'translate(-66 0)');
const cardText = pageCard.querySelector('text')!;
let cardPop = 9;
/** Small badges on the card for what is set up. */
const cardBadges = el('g', {}, pageCard);

// The photo card: the same kind of card, with a little picture on it.
const photoCard = card('photo.jpg', drawPhoto, 'translate(-65 0)');
const photoBadges = el('g', {}, photoCard);

// The call card: a handset, and the friend's name.
const callCard = card('call Sam', drawHandset, 'translate(-69 -2) scale(0.36)');
const callBadges = el('g', {}, callCard);

// Two small tools as cards too: a ping, and a trace of the path.
const TOOL_ICON = 'translate(-66 0) scale(0.42)';
const CARDS: Record<Job, SVGGElement> = { page: pageCard, photo: photoCard, call: callCard, ping: card('ping', drawPing, TOOL_ICON), trace: card('trace route', drawTrace, TOOL_ICON) };

/** What each card does, in a beginner's words: it goes along to the right of the card for as long as the card is held. */
const CARD_HELP: Record<Job, [string, string]> = {
  page: ['Open a website using packets:', 'small messages you can tap open'],
  photo: ['Fetch a photo:', 'too big for one packet'],
  call: ['Make a voice call', 'over the internet'],
  ping: ['Ask a server if it is there', 'and how fast it answers'],
  trace: ['Find the stops that answer', 'on the way to a server'],
};
const CARD_HELP_W = 224;
const CARD_HELP_H = 50;
/** The camera scale below which the help grows, to stay as readable as it is at this one. */
const HELP_FLOOR = 0.85;
const cardHelp = el('g', { class: 'card-help' }, svg);
el('rect', { x: -CARD_HELP_W / 2, y: 0, width: CARD_HELP_W, height: CARD_HELP_H, rx: 12 }, cardHelp);
const cardHelpLines = [17, 36].map((y) => el('text', { y, 'text-anchor': 'middle' }, cardHelp));

scene.setOnTable([{ sx: home.sx - 110, sy: home.sy + STACK_TOP }, { sx: home.sx + 110, sy: home.sy + STACK_BOTTOM }]);

/** A setting changed before a run: show the network it will use, with a clean screen. */
function preview(): void {
  save('net.features', JSON.stringify(features));
  joined = [];
  idleV = -1;
  if (reading) {
    reading = false;
    client = 'laptop';
  }
  recall();
  simulate();
  scene.setStory(story, tl);
  showFeatures();
}

function showFeatures(): void {
  const site = pageSite();
  if (cardText.textContent !== site) {
    cardText.textContent = site;
    cardPop = 0;
  }
  for (const [badges, skip] of [[cardBadges, null], [photoBadges, 'big'], [callBadges, 'big']] as const) {
    badges.replaceChildren();
    // A smart home changes nothing about the card's run, so it has nothing to say about it.
    SETUP.filter((s) => features[s.id] && s.id !== skip && s.id !== 'smart').forEach((s, i) => {
      const g = el('g', { transform: `translate(${72 - i * 30} -24)` }, badges);
      el('circle', { r: 13, class: 'card-badge' }, g);
      s.draw(el('g', { transform: `scale(${(14 / s.span).toFixed(3)})` }, g));
    });
  }
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

const firstFrameAt = (t: Timeline): number => {
  for (const s of t.segs) if (s.step.kind === 'travel') return s.step.at;
  return 0;
};

/** Cut a cable, or mend it. It works mid-run too: the simulation re-runs from this moment on, what was seen stays, and whatever is on that cable right now falls in. */
function toggleCut(line: string): void {
  const on = !cutLines.has(line);
  if (on) cutLines.add(line);
  else cutLines.delete(line);
  // With every packet done there is nothing left for it to change.
  if (mode === 'play' && v < tl.settled) {
    // A step under way was aimed at the old timeline.
    seek = null;
    for (const r of on ? ridingOn(tl, v, line) : []) {
      faults.push({ packetId: r.packetId, linkId: line, crossing: r.crossing });
      knocks.set(crossingKey(r.packetId, line, r.crossing), r.k);
    }
    const seen = seenSoFar(tl, v, line);
    decided = { ...decided, ...seen.decided };
    past = pastAt(tl, v, past);
    cuts = cuts.map((c) => (c.to === undefined && c.link === line ? { ...c, to: seen.now } : c));
    // Before the first frame only what the run doesn't show has moved: a device finding its router, which a cut there would stop.
    if (on) cuts = [...cuts, { link: line, from: Math.max(seen.now, firstFrameAt(tl)) }];
    simulate();
    scene.setStory(story, tl);
  }
  const during = mode === 'play';
  if (on) cutSpans = [...cutSpans, { link: line, from: during ? v : -Infinity }];
  else cutSpans = during ? cutSpans.map((s) => (s.link === line && s.to === undefined ? { ...s, to: v } : s)) : cutSpans.filter((s) => s.link !== line);
  scene.setCut(cutSpans);
  sound.play(on ? 'snip' : 'snap');
}

/** Take a line back to normal. */
function clearLine(line: string): void {
  if (cutLines.has(line)) toggleCut(line);
}
/** These lines go from the table: mended, and the spyglass off them. */
function clearLines(lines: string[]): void {
  for (const l of lines) clearLine(l);
  if (spyLine && lines.includes(spyLine)) setSpyLine(null);
}

let cam: Camera = scene.overviewCamera();

/** Tools come from the Tools menu: pick one, click as many lines as you like, click a line again to undo it. */
type Tool = 'spy' | 'cut';
let tool: Tool | null = null;

/** Put the spyglass on a line, or take it off. It only reads, so nothing about the run changes. */
function setSpyLine(line: string | null): void {
  if (line === spyLine) return;
  spyLine = line;
  spyFrom = mode === 'play' ? v : idleV;
  scene.setSpy(line);
  spyCard.reset();
  sound.play('snap');
}
const USE: Record<Tool, (line: string) => void> = { spy: (l) => setSpyLine(spyLine === l ? null : l), cut: toggleCut };
function pickUp(t: Tool | null): void {
  tool = t;
  for (const id of ['spy', 'cut'] as const) {
    toolsMenu.setOn(id, t === id);
    svg.classList.toggle(`tool-${id}`, t === id);
  }
  toolsMenu.button.classList.toggle('on', !!t);
  scene.setHover(null);
}
/** The line under the pointer that the tool in hand can work on. Radio cannot be cut. */
const toolLine = (e: PointerEvent): string | null => lineNear(toSvg(e), tool === 'cut', 26 / cam.scale);
scene.setSpy(spyLine);
cutSpans = [...cutLines].map((link) => ({ link, from: -Infinity }));
scene.setCut(cutSpans);

const VPN_LINKS = ['bb3', 'bb4', 'bb5'];
const COLD_LINKS = ['up1', 'up2', 'up3'];
const SETUP_ROWS: Record<Setting, { label: string; hint: string; draw: (g: SVGGElement) => void; span: number }> = {
  https: { label: 'Secure page (HTTPS)', hint: "Hides the page, not where it's going", draw: drawPadlock, span: 34 },
  big: { label: 'Bigger page', hint: 'Too big for one packet', draw: drawPage, span: 34 },
  slow: { label: 'Satellite internet', hint: 'To space and back: long waits', draw: drawSatellite, span: 64 },
  vpn: { label: 'VPN', hint: 'Sealed tunnel past your provider', draw: drawShield, span: 34 },
  dhcp: { label: 'New on the network', hint: 'Gets an address, then finds the router', draw: drawTag, span: 34 },
  cold: { label: 'DNS has to ask around', hint: "The site's address isn't saved yet", draw: drawSnowflake, span: 34 },
  thin: { label: 'Slow home line', hint: 'Queues fill up and drop packets', draw: drawPipe, span: 34 },
  smart: { label: 'Smart home', hint: 'A sensor that reports to apps', draw: drawThermometer, span: 34 },
};
const SETUP = SETTINGS.map((id) => ({ id, ...SETUP_ROWS[id] }));
/** The lines that go when the smart home changes. */
const SMART_LINKS = ['wlan2', 'lan2', 'broker-link'];
function setSetting(id: Setting, on: boolean): void {
  features[id] = on;
  if (id === 'smart' && !on) clearLines(SMART_LINKS);
  // The line to the ISP becomes radio, which cannot be cut.
  if (id === 'slow' && on && cutLines.has('wan')) toggleCut('wan');
  // The servers a lookup walks go with it, and their cables.
  if (id === 'cold' && !on) clearLines(COLD_LINKS);
  // The VPN's cables go with it.
  if (id === 'vpn' && !on) clearLines(VPN_LINKS);
  showSetup();
  preview();
  sound.play(id === 'https' || id === 'vpn' ? 'lock' : 'snap');
}
/** The Setup menu says what is on, also for what was remembered from last time. */
function showSetup(): void {
  for (const k of SETTINGS) setupMenu.setOn(k, features[k]);
  setupMenu.button.classList.toggle('on', SETTINGS.some((k) => features[k]));
}

const CHAPTERS: Record<Chapter, string> = { address: 'Get an address', arp: 'Find the router', dns: "Find the site's address", hello: 'Say hello', secret: 'Check and agree', page: 'Get the page', call: 'Make a call', ping: 'Ping the server', trace: 'Trace the path', traffic: 'All at once', attack: 'Attack' };
/** Chapter number in this run (a second visit skips the address, HTTPS adds the secret). */
const chapterName = (ch: Chapter): string => {
  if (ch === 'dns' && story.voice) return "Find Sam's address";
  if (ch === 'dns' && story.reading) return 'Find the broker';
  return ch === 'page' && story.reading ? 'Send the reading' : ch === 'page' && story.photo ? 'Get the photo' : CHAPTERS[ch];
};
/** What each chapter is for, under the current one in the list. It stays up whatever happens, so it says what is being tried, never that it worked. */
const CHAPTER_ABOUT: Record<Chapter, string> = {
  address: 'Your device has no address yet, so it asks the home router for one.',
  arp: 'To send anything to the home router, your device needs its hardware address, so it calls out on the home network and asks.',
  dns: 'Computers find each other by address, not by name, so your device asks a name server for this one.',
  hello: 'Before sending anything, the two ends check that they can hear each other.',
  secret: "Your device checks the server's proof of who it is, and both try to work out a key that only they have.",
  page: 'Your device asks the server for the page, and waits for it to come back in packets.',
  call: 'Your voices go both ways as a stream of small packets. A lost one is a gap, and nothing is sent again.',
  ping: 'Your device sends the server small packets to answer, and times how long each answer takes.',
  trace: 'Each probe can only make a set number of stops. The router where it runs out answers, and that shows the path.',
  traffic: 'Everything still going runs side by side, each device in its own colour.',
  attack: 'The attackers are sending packets of their own.',
};
const chapterAbout = (ch: Chapter): string => {
  if (ch === 'page' && story.reading) return 'The sensor sends its reading to the broker, whose job is to pass a copy to every app listening.';
  return ch === 'page' && story.photo ? 'Your device asks the server for the photo, and waits for it to come back in many packets, as it is too big for one.' : CHAPTER_ABOUT[ch];
};

function chapterNumber(ch: Chapter): number {
  const order: Chapter[] = [];
  for (const s of tl.segs) if (!order.includes(s.trip.chapter)) order.push(s.trip.chapter);
  return order.indexOf(ch) + 1;
}
const chapter = document.createElement('button');
chapter.className = 'chapter';
chapter.hidden = true;
chapter.setAttribute('aria-haspopup', 'true');
chapter.setAttribute('aria-expanded', 'false');
root.appendChild(chapter);
let shownChapter: Chapter | null = null;

// Tap the chapter label to jump to any chapter of this run.
const chapterMenu = document.createElement('div');
chapterMenu.className = 'chapter-menu';
chapterMenu.hidden = true;
root.appendChild(chapterMenu);
/** The list's items by chapter, so the current one can be marked as the run moves on. */
const chapterItems = new Map<Chapter, HTMLButtonElement>();
const chapterLine = document.createElement('p');
chapterLine.className = 'chapter-about';
/** Mark the chapter the run is in, with what it is for right under it. */
function markChapter(ch: Chapter | null): void {
  for (const [c, item] of chapterItems) item.classList.toggle('current', c === ch);
  const item = ch && chapterItems.get(ch);
  if (!ch || !item) {
    chapterLine.remove();
    return;
  }
  chapterLine.textContent = chapterAbout(ch);
  item.after(chapterLine);
}
function showChapterMenu(open: boolean): void {
  chapterMenu.hidden = !open;
  chapter.setAttribute('aria-expanded', String(open));
}
chapter.addEventListener('click', () => {
  if (!chapterMenu.hidden) {
    showChapterMenu(false);
    return;
  }
  chapterMenu.replaceChildren();
  chapterItems.clear();
  for (const s of tl.segs) {
    const ch = s.trip.chapter;
    if (chapterItems.has(ch)) continue;
    const item = document.createElement('button');
    item.innerHTML = `<span class="chapter-num">${chapterNumber(ch)}</span><span>${chapterName(ch)}</span>`;
    item.addEventListener('click', () => {
      // Jumping keeps the viewer's pause: they land at the chapter's start, playing or not as before.
      v = s.t0;
      seek = null;
      peek = peekTarget = 0;
      camFree = false;
      showChapterMenu(false);
    });
    chapterItems.set(ch, item);
    chapterMenu.appendChild(item);
  }
  markChapter(shownChapter);
  showChapterMenu(true);
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
/** An icon for the bar. Some phones draw the pause sign as an orange emoji, so it cannot be a character. */
const barIcon = (draw: (g: SVGGElement) => void): SVGSVGElement => {
  const icon = el('svg', { viewBox: '-12 -12 24 24', width: 24, height: 24, 'aria-hidden': 'true' });
  draw(el('g', {}, icon));
  return icon;
};
const backBtn = button('⏮', 'Step back', () => step(-1));
const pauseBtn = button('', 'Pause', togglePause);
const nextBtn = button('⏭', 'Step forward', () => step(1));
// 0.25× is for a stream: slow enough to see the window of packets go out and the ACKs let the next ones out.
const SPEEDS = ['0.25', '0.5', '1', '2'];
const speedMenu = new Menu<string>(controls, root, '1×', 'Speed', SPEEDS.map((id) => ({ id, label: `${id}×` })), (id) => {
  speed = Number(id);
  speedMenu.button.textContent = `${id}×`;
  for (const x of SPEEDS) speedMenu.setOn(x, x === id);
  speedMenu.setOpen(false);
});
speedMenu.setOn('1', true);
speedMenu.button.classList.add('speed-button');
const toolsMenu = new Menu<Tool>(
  controls,
  root,
  'Tools',
  'Tools',
  [
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
// What kind of smart home: an arrow beside it in the Setup, with a popup of its own.
type SmartOption = 'home' | 'cloud' | 'qos0' | 'qos1' | 'qos2';
const smartMenu = new Menu<SmartOption>(
  setupMenu.row('smart'),
  root,
  '›',
  'Smart home options',
  [
    { id: 'home', label: 'Broker at home', hint: 'Readings stay in the house' },
    { id: 'cloud', label: 'Broker in the cloud', hint: 'Out through your router and back' },
    { id: 'qos0', label: 'QoS 0', hint: 'No receipt, so it can be lost' },
    { id: 'qos1', label: 'QoS 1', hint: 'Confirmed, can arrive twice' },
    { id: 'qos2', label: 'QoS 2', hint: 'Extra checks stop it arriving twice' },
  ],
  (id) => {
    if (id === 'home' || id === 'cloud') {
      cloud = id === 'cloud';
      clearLines(['lan2', 'broker-link']);
    } else qos = Number(id.slice(3)) as 0 | 1 | 2;
    saveSmart();
    showSmart();
    if (features.smart) preview();
    else setSetting('smart', true);
    sound.play('snap');
  },
);
smartMenu.mark('smart-menu');
setupMenu.hold(smartMenu);
const saveSmart = (): void => save('net.smart', JSON.stringify({ cloud, qos }));
function showSmart(): void {
  // Anything but the plain choice shows without opening the popup.
  smartMenu.button.classList.toggle('on', cloud || qos > 0);
  smartMenu.setOn('home', !cloud);
  smartMenu.setOn('cloud', cloud);
  for (const n of [0, 1, 2] as const) smartMenu.setOn(`qos${n}`, qos === n);
}
showSmart();
/** The height of a device's "+ action" (see app.css), and how high it can go during a run: clear of the chapter name. */
const ACTION_H = 34;
const ACTION_TOP = 110;
/** What can start on a device with nothing to do, in the white of the cards. */
const ACTIONS: Record<Job, { label: string; draw: (g: SVGGElement) => void }> = {
  page: { label: 'Page', draw: drawGlobe },
  photo: { label: 'Photo', draw: drawPhoto },
  // The handset is not drawn around the origin: this centres it, or it runs out of its tile.
  call: { label: 'Call', draw: (g) => drawHandset(el('g', { transform: 'translate(-3.2 -2.4) scale(0.4)' }, g)) },
  ping: { label: 'Ping', draw: (g) => drawPing(el('g', { transform: 'scale(0.42)' }, g)) },
  trace: { label: 'Trace', draw: (g) => drawTrace(el('g', { transform: 'scale(0.42)' }, g)) },
};
// A device with nothing to do has a button of its own during a run, opening what it can do.
const canStart = story!.devices.filter((d) => d.actions.some((a) => a !== 'reading'));
const deviceActions = canStart.map(({ id: device, actions }) => {
  const menu = new Menu<Job>(
    root,
    root,
    '+ action',
    `Add an action on the ${device}`,
    actions.filter((a) => a !== 'reading').map((id) => ({ id, label: ACTIONS[id].label, span: 16, draw: (g) => ACTIONS[id].draw(el('g', { class: 'site-card-globe' }, g)) })),
    (id) => {
      menu.setOpen(false);
      joinIn(device, id);
    },
  );
  menu.mark('action-menu');
  menu.button.hidden = true;
  return { device, menu };
});
/** A device can take on an action during a run while it has nothing to do. */
const canAdd = (device: string): boolean => !reading && device !== client && !joined.some((j) => j.device === device);
// Under the sensor between runs: what is sent is whatever the sensor reads right now.
const readingBtn = document.createElement('button');
readingBtn.className = 'action-menu';
readingBtn.textContent = 'Take reading';
readingBtn.hidden = true;
readingBtn.addEventListener('click', takeReading);
root.appendChild(readingBtn);
showSetup();
const ATTACK_LINKS: Record<Attack, string[]> = { listen: [], flood: ['bot1-link', 'bot2-link', 'bot3-link'], scan: ['scanner-link'] };
const attackMenu = new Menu<Attack>(
  controls,
  root,
  'Attack',
  'Attackers',
  [
    { id: 'listen', label: 'Stranger', hint: 'Listens in on the open Wi-Fi', draw: drawEar, span: 32 },
    { id: 'flood', label: 'Botnet', hint: 'Floods the web server', draw: drawSwarm, span: 30 },
    { id: 'scan', label: 'Scanner', hint: "Tries the server's doors", draw: drawDoor, span: 32 },
  ],
  (id) => setAttack(id, !attacks.has(id)),
);
attackMenu.mark('attack-menu');
function setAttack(id: Attack, on: boolean): void {
  if (on) attacks.add(id);
  else attacks.delete(id);
  attackMenu.setOn(id, on);
  // Its cables go with it.
  if (!on) clearLines(ATTACK_LINKS[id]);
  preview();
  sound.play(on ? 'pop' : 'thud');
}
/** Where to find me. A link goes here once its address is known; nothing shows a dead one. */
const LINKS = [{ label: 'GitHub', url: 'https://github.com/maxrangner/connection-lab' }];
/** True of the page as it stands. Anything that stores more or sends anything, cookies included, has to change this first. */
const PRIVACY = "This page sets no cookies and doesn't track you. Your theme, sound, Quiet devices and Setup choices are saved in this browser only and are never sent anywhere. The site hosting the page may have its own rules.";
const aboutBtn = document.createElement('button');
aboutBtn.className = 'about-button';
aboutBtn.textContent = '?';
aboutBtn.setAttribute('aria-label', 'About Connection Lab');
aboutBtn.setAttribute('aria-expanded', 'false');
const aboutCard = document.createElement('div');
aboutCard.className = 'about-card';
aboutCard.hidden = true;
aboutCard.tabIndex = -1;
const aboutText = (tag: string, text: string): HTMLElement => {
  const e = document.createElement(tag);
  e.textContent = text;
  aboutCard.appendChild(e);
  return e;
};
aboutText('h2', 'Connection Lab');
aboutText('p', 'See how the internet really works. Every packet is built and read byte by byte, right here in your browser. Nothing touches the real network.');
aboutText('h3', 'Made by Max Rangner');
const aboutLinks = aboutText('div', '');
aboutLinks.className = 'about-links';
for (const { label, url } of LINKS) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = label;
  aboutLinks.appendChild(a);
}
aboutText('h3', 'Cookies and privacy');
aboutText('p', PRIVACY);
aboutText('p', `v${version}`).className = 'about-version';
root.append(aboutCard);
const about = {
  button: aboutBtn,
  get isOpen(): boolean {
    return !aboutCard.hidden;
  },
  setOpen(open: boolean): void {
    if (open === this.isOpen) return;
    if (!open && aboutCard.contains(document.activeElement)) aboutBtn.focus();
    aboutCard.hidden = !open;
    aboutBtn.setAttribute('aria-expanded', String(open));
    if (open) aboutCard.focus();
  },
  place(): void {},
};
aboutBtn.addEventListener('click', () => about.setOpen(!about.isOpen));
const menus: { isOpen: boolean; setOpen(open: boolean): void; place(): void; button: HTMLButtonElement }[] = [speedMenu, toolsMenu, setupMenu, attackMenu, ...deviceActions.map((a) => a.menu), about];
for (const menu of menus) {
  menu.button.addEventListener('click', () => {
    for (const other of menus) if (other !== menu) other.setOpen(false);
    showChapterMenu(false);
  });
}
const placeMenus = (): void => {
  for (const menu of menus) menu.place();
  smartMenu.place();
  const bar = controls.getBoundingClientRect();
  scene.setBar(window.innerHeight - bar.top);
  aboutCard.style.bottom = `${window.innerHeight - bar.top + 10}px`;
  spyCard.place(controls);
};
const soundBtn = button('♪', 'Mute', () => {
  sound.muted = !sound.muted;
  save('net.muted', sound.muted ? '1' : '0');
});
soundBtn.classList.add('sound-button');
const quietBtn = button('', 'Quiet devices', () => {
  quiet = !quiet;
  scene.setQuiet(quiet);
  showQuiet();
  save('net.quiet', quiet ? '1' : '0');
});
quietBtn.appendChild(barIcon(drawTalk));
const showQuiet = (): void => {
  quietBtn.classList.toggle('off', quiet);
  quietBtn.setAttribute('aria-pressed', String(quiet));
};
scene.setQuiet(quiet);
showQuiet();
const logo = document.createElement('img');
logo.className = 'logo';
logo.alt = 'Connection Lab';
root.appendChild(logo);
/** Dark as the system is, until the viewer chooses. */
const savedTheme = load('net.theme');
let dark = savedTheme ? savedTheme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
const showTheme = (): void => {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  logo.src = dark ? logoDark : logoLight;
  themeBtn.setAttribute('aria-label', dark ? 'Light theme' : 'Dark theme');
  themeBtn.replaceChildren(barIcon(dark ? drawSun : drawMoon));
};
const themeBtn = button('', 'Dark theme', () => {
  dark = !dark;
  themeChosen = true;
  showTheme();
  save('net.theme', dark ? 'dark' : 'light');
});
showTheme();
// Until a theme is chosen here, it follows the system's.
let themeChosen = !!savedTheme;
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (themeChosen) return;
  dark = e.matches;
  showTheme();
});
button('↺', 'Reset', reset);
// On a narrow screen the bar breaks into two rows here (see app.css).
controls.appendChild(Object.assign(document.createElement('span'), { className: 'bar-break' }));
root.appendChild(controls);
// A wide screen has room for the "?" alone in the corner. A narrower bar has none beside it, so there it stays in the bar (see app.css).
const wideEnough = window.matchMedia('(min-width: 900px)');
const placeAbout = (): void => void (wideEnough.matches ? root : controls).appendChild(aboutBtn);
placeAbout();
wideEnough.addEventListener('change', placeAbout);

/** The sensor takes a reading and publishes it: to the broker, and from there to every app listening. */
function takeReading(): void {
  if (mode !== 'idle') return;
  reading = true;
  client = story.devices.find((d) => d.actions.includes('reading'))!.id;
  camFree = false;
  sound.play('pop');
  beginRun();
}

/** This device starts on this job now: what has been shown stays, and from the next step on everything runs at once. */
function joinIn(device: string, job: Job): void {
  const seen = seenSoFar(tl, v);
  decided = { ...decided, ...seen.decided };
  joined = [...joined, { device, job, at: joinAt(tl, v), v }];
  // A device joining in looks everything up afresh: it remembers nothing from before.
  forgetAll(device);
  seek = null;
  camFree = false;
  simulate();
  scene.setStory(story, tl);
  sound.play('pop');
}

// Outside the bar, so the bar never moves.
const followBtn = document.createElement('button');
followBtn.className = 'follow';
followBtn.setAttribute('aria-label', 'Follow the packet');
followBtn.addEventListener('click', () => {
  camFree = false;
  showAll = mode !== 'play';
});
root.appendChild(followBtn);
const spyCard = new SpyCard(root, () => setSpyLine(null));
const hexCard = new HexCard(root, () => hexCard.hide());
// The animation takes its time so you can watch; this says how long it really took.
const realClock = document.createElement('div');
realClock.className = 'real-clock';
realClock.hidden = true;
root.appendChild(realClock);
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
let showsPlay: boolean | null = null;
placeMenus();
/** Set once the viewer pans or zooms by hand; the camera stops following until they ask again. */
let camFree = false;
/** "Show all" was pressed: between runs the camera keeps the whole network in view until the next run. */
let showAll = false;
recall();
showFeatures();
cardPop = 9;

function toSvg(e: PointerEvent): { sx: number; sy: number } {
  const m = svg.getScreenCTM();
  if (!m) return { sx: 0, sy: 0 };
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
  return { sx: p.x, sy: p.y };
}

for (const wanted of EVERY_JOB) {
  const g = CARDS[wanted];
  g.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (mode !== 'idle' && mode !== 'spring')) return;
    // A card still springing back lands at once, so the other one can be picked up.
    if (wanted !== carried) {
      carried = wanted;
      cardPos = restAt(wanted);
    }
    const p = toSvg(e);
    grab = { dx: cardPos.sx - p.sx, dy: cardPos.sy - p.sy };
    mode = 'drag';
    CARD_HELP[wanted].forEach((line, i) => (cardHelpLines[i]!.textContent = line));
    g.setPointerCapture(e.pointerId);
    g.classList.add('held');
  });
  g.addEventListener('pointermove', (e) => {
    if (mode !== 'drag') return;
    const p = toSvg(e);
    cardPos = { sx: p.sx + grab.dx, sy: p.sy + grab.dy };
    g.classList.toggle('over', !!dropTarget());
  });
  g.addEventListener('pointerup', dropCard);
  // A drag the browser takes over (a second finger, a palm, leaving the page) still puts the card down.
  g.addEventListener('pointercancel', dropCard);
  g.addEventListener('lostpointercapture', dropCard);
}

/** The laptop or phone the card is over, if any. */
function dropTarget(): { id: string; sx: number; sy: number } | null {
  let best: { id: string; sx: number; sy: number } | null = null;
  let bestD = 85;
  for (const d of scene.dropPoints()) {
    if (!d.actions.includes(carried)) continue;
    const dist = Math.hypot(cardPos.sx - d.sx, cardPos.sy - d.sy);
    if (dist < bestD) {
      best = d;
      bestD = dist;
    }
  }
  return best;
}
function dropCard(): void {
  if (mode !== 'drag') return;
  CARDS[carried].classList.remove('held', 'over');
  const drop = dropTarget();
  if (drop) {
    client = drop.id;
    reading = false;
  }
  anim = { from: { ...cardPos }, to: drop ?? restAt(carried), t: 0, dur: drop ? 0.35 : 0.5 };
  mode = drop ? 'drop' : 'spring';
  if (drop) {
    camFree = false;
    sound.play('pop');
  }
}

// Tap a packet to pop it open.
scene.packet.addEventListener('pointerdown', () => {
  if (tool || mode !== 'play' || v >= tl.settled) return;
  if (scene.peekable(v)) peekTarget = peekTarget ? 0 : 1;
});

// Pan and zoom by hand: drag the stage, pinch, or use the wheel. Any of these lets go of the follow camera.
const pointers = new Map<number, { x: number; y: number }>();
/** A press on the stage that has not turned into a drag yet: it only takes the view over once it really moves. */
let press: {
  x: number;
  y: number;
  /** On the Wi-Fi arc between runs: it shakes the radio if it stays a tap. */
  air: boolean;
  /** On the ISP router between runs: along its cable it stretches the fibre, any other way it pans. */
  grab: boolean;
  /** With a tool in hand: a click on a line if it stays a tap. */
  tool: boolean;
  /** On a device's screen between runs: a "forget" if it stays a tap. */
  device: string | null;
} | null = null;
/** The ISP router being dragged along its cable, from where. */
let stretchPress: { x: number; y: number; from: number } | null = null;
/** How closely a drag must follow the cable to stretch it (the cosine of the angle between them). */
const ALONG_CABLE = 0.9;
/** A drag along the cable to the ISP (+x, right and down on screen), in screen pixels. */
const alongCable = (dx: number, dy: number): number => dx * ISO_X + dy * ISO_Y;

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
  if (e.button !== 0) return;
  // The first finger of a new touch: any other still listed lost its pointerup, and would turn every drag into a pinch.
  if (e.isPrimary) pointers.clear();
  // Working the stage leaves the Tools menu open while a tool is in hand; the other popups give way to it.
  for (const menu of menus) if (menu !== toolsMenu || !tool) menu.setOpen(false);
  showChapterMenu(false);
  const target = e.target as Element;
  // The last row of an open pill: the bytes themselves.
  const hex = target.closest('[data-hex]')?.getAttribute('data-hex') as PartKey | undefined;
  if (hex) {
    const hit = segAt(tl, v);
    const pdu = hit && pduAt(hit.seg, hit.k);
    if (pdu) hexCard.show(pdu, hex);
    sound.play('snap');
    return;
  }
  const chip = target.closest('[data-chip]')?.getAttribute('data-chip') as PartKey | undefined;
  if (chip) {
    pillTarget = pill === chip && pillTarget ? 0 : 1;
    if (pill !== chip) pillOpen = 0;
    pill = chip;
    sound.play('snap');
    return;
  }
  if (target.closest('.site-card') || (!tool && target.closest('.packet'))) return;
  // One finger only: a second one down means a pinch, whatever the first was on.
  const onTable = !tool && canSetUp() && e.isPrimary;
  const device = target.closest('[data-device]')?.getAttribute('data-device');
  press = {
    x: e.clientX,
    y: e.clientY,
    // A tap on the Wi-Fi arc between runs shakes it: noisy, or calm again. A drag from there pans, like anywhere else.
    air: onTable && !!target.closest('[data-air]'),
    // The ISP router can be dragged further away between runs: the fibre to it gets longer.
    grab: onTable && !!target.closest('[data-grab]'),
    tool: !!tool,
    device: device && !tool && mode === 'idle' && known.has(device) ? device : null,
  };
  // Listed only once captured: a finger that cannot be followed must not stay listed as down.
  svg.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  svg.classList.add('panning');
});
svg.addEventListener('pointermove', (e) => {
  if (tool) scene.setHover(toolLine(e));
  if (press?.grab) {
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    const moved = Math.hypot(dx, dy);
    if (moved < 6) return;
    press.grab = false;
    if (Math.abs(alongCable(dx, dy)) >= moved * ALONG_CABLE) {
      stretchPress = { x: press.x, y: press.y, from: stretch };
      press = null;
      // The view holds still while the router moves, so nothing zooms under the finger.
      camFree = true;
    }
  }
  if (stretchPress) {
    // Along the cable, in tiles: the layout moves with the pointer, the simulation catches up when the router is let go.
    const tiles = alongCable(e.clientX - stretchPress.x, e.clientY - stretchPress.y) / (Math.hypot(U, U / 2) * cam.scale);
    const next = Math.round(Math.max(0, Math.min(MAX_STRETCH, stretchPress.from + tiles)));
    if (next !== stretch) {
      stretch = next;
      tl = buildTimeline(story, knocks, stretch, drops(), past);
      if (idleV >= 0) idleV = tl.total;
      scene.setStory(story, tl);
    }
    return;
  }
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  if (press) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) return;
    press = null;
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
  if (stretchPress) {
    stretchPress = null;
    preview();
    sound.play('snap');
  }
  const tap = e.type === 'pointerup' ? press : null;
  press = null;
  if (tap?.air) {
    noise = noise > 0 ? 0 : NOISY;
    preview();
    sound.play(noise > 0 ? 'bonk' : 'snap');
  }
  if (tap?.device) forget(tap.device);
  if (tap?.tool && tool) {
    const line = toolLine(e);
    if (line) USE[tool](line);
  }
};
svg.addEventListener('pointerup', release);
svg.addEventListener('pointercancel', release);
// However a finger stops being followed, it is no longer down.
svg.addEventListener('lostpointercapture', (e) => {
  pointers.delete(e.pointerId);
  if (!pointers.size) svg.classList.remove('panning');
});
svg.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    camFree = true;
    // Wheel steps come in pixels, lines or pages depending on the browser and mouse.
    const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
    zoomAt(e.clientX, e.clientY, Math.exp(-px * 0.0015));
  },
  { passive: false },
);

/** Tap a screen between runs: the device forgets what it remembers, and the next visit starts from scratch. */
function forget(device: string): void {
  forgetAll(device);
  if (device === client) {
    idleV = -1;
    recall();
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
  CARDS[carried].classList.remove('held', 'over');
  carried = 'page';
  seek = null;
  paused = false;
  peek = peekTarget = 0;
  doneFor = 0;
  camFree = false;
  showAll = false;
  faults.length = 0;
  knocks.clear();
  decided = {};
  past = NO_PAST;
  known.clear();
  memory.clear();
  client = 'laptop';
  reading = false;
  cardPos = { ...home };
  pickUp(null);
  // Everything goes back at once: one simulation and one sound, not one of each per thing undone.
  cutLines.clear();
  cutSpans = [];
  scene.setCut([]);
  if (spyLine) {
    spyLine = null;
    scene.setSpy(null);
    spyCard.reset();
  }
  cuts = [];
  warmArp = false;
  stretch = 0;
  noise = 0;
  attacks.clear();
  scene.setRevealed([]);
  for (const id of Object.keys(ATTACK_LINKS) as Attack[]) attackMenu.setOn(id, false);
  cloud = false;
  qos = 0;
  saveSmart();
  showSmart();
  for (const menu of menus) menu.setOpen(false);
  showChapterMenu(false);
  for (const k of SETTINGS) features[k] = false;
  showSetup();
  preview();
  sound.play('thud');
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    // A button reached by keyboard works like any button; everywhere else Space pauses.
    if (e.target instanceof Element && e.target.closest('button')) return;
    e.preventDefault();
    togglePause();
  } else if (e.code === 'Escape') {
    pickUp(null);
    for (const menu of menus) menu.setOpen(false);
    showChapterMenu(false);
    hexCard.hide();
  }
  else if (e.code === 'ArrowRight') step(1);
  else if (e.code === 'ArrowLeft') step(-1);
});

/** The card has gone into the device: run the simulation with what is on the table and a fresh seed. */
function beginRun(): void {
  faults.length = 0;
  knocks.clear();
  runSeed = 1 + Math.floor(Math.random() * 1e6);
  decided = {};
  past = NO_PAST;
  // Sam's cable is only there for a call: a cut on it goes with it.
  if (carried !== 'call') {
    cutLines.delete('bb6');
    if (spyLine === 'bb6') setSpyLine(null);
  }
  cutSpans = [...cutLines].map((link) => ({ link, from: -Infinity }));
  scene.setCut(cutSpans);
  // A line already cut when a reading is taken has been out for a while, long enough for everyone to have noticed.
  cuts = [...cutLines].map((link) => ({ link, from: reading ? OFFLINE_AT : 0 }));
  warmArp = !reading && cutLines.size > 0;
  recall();
  joined = [];
  // Every run starts from your own devices and finds the network again.
  scene.setRevealed([]);
  simulate();
  scene.setStory(story, tl);
  showFeatures();
  spyCard.reset();
  spyFrom = -Infinity;
  mode = 'play';
  played = true;
  v = 0;
  seek = null;
  doneFor = 0;
  paused = false;
  peek = peekTarget = 0;
  showAll = false;
}

/** The run is over: the device remembers the address until its TTL runs out, and the card floats back. */
function endRun(): void {
  const ip = story.remembered ?? story.dnsAnswer;
  if (ip && !revisit && !reading) noteDown(client, { site: story.site, ip, until: performance.now() + (story.dnsTtl ?? 0) * 1000 });
  // A call over: hear what came through, holes and all.
  if (story.voice) sound.playVoice(story.voice.heard.map((b) => (b ? ulawDecodeAll(b) : null)), RTP_SAMPLES_PER_PACKET);
  idleV = tl.total;
  // Over: a cable cut during it is simply cut now.
  cutSpans = [...cutLines].map((link) => ({ link, from: -Infinity }));
  scene.setCut(cutSpans);
  scene.setRevealed(tl.reveals.keys());
  // No card went in for a reading, so none comes out of the sensor: it was on the table all along.
  const from = (reading ? null : scene.dropPoints().find((d) => d.id === client)) ?? (reading ? restAt(carried) : home);
  anim = { from, to: restAt(carried), t: 0, dur: 0.8 };
  mode = 'return';
  camFree = false;
}

let last = performance.now();
let clock = 0;
/** The viewer asked their system for less motion: the idle card keeps still. */
const stillness = window.matchMedia('(prefers-reduced-motion: reduce)');
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
      if (k >= 1) seek = null;
    } else if (!paused && !peekTarget) {
      const next = Math.min(tl.total, v + dt * speed);
      for (const c of tl.cues) if (c.t > v && c.t <= next) sound.play(c.sound, c.hz);
      v = next;
    }
    // A step can land where there is no packet to hold open (a lookup, a timer): carry on.
    if (peekTarget && !scene.peekable(v)) peekTarget = 0;
    doneFor = v >= tl.settled && !paused && !seek ? doneFor + dt : 0;
    if (doneFor > LINGER && v >= tl.total) endRun();
  }
  peek += (peekTarget - peek) * Math.min(1, dt * 10);
  if (!peekTarget) pillTarget = 0;
  // The bytes go with the pill they came out of.
  if (!pillTarget && hexCard.isOpen) hexCard.hide();
  pillOpen += (pillTarget - pillOpen) * Math.min(1, dt * 12);

  cardFit = Math.min(1, CARD_MAX_PX / (CARD_W * cam.scale));
  if (mode === 'idle') cardPos = restAt(carried);
  const bob = mode === 'idle' && !stillness.matches ? Math.sin(clock * 2.4) * 4 * cardFit : 0;
  const dropK = mode === 'drop' ? clamp01(anim.t / anim.dur) : 0;
  const riseK = mode === 'return' ? clamp01(anim.t / anim.dur) : 1;
  cardPop += dt;
  const pop = cardPop < 0.4 ? 1 + 0.12 * Math.sin((cardPop / 0.4) * Math.PI) : 1;
  const scale = (mode === 'drop' ? 1 - 0.8 * dropK : mode === 'drag' ? 1.06 : 0.2 + 0.8 * riseK) * pop;
  const cardOp = (1 - dropK) * riseK;
  const moving = CARDS[carried];
  moving.style.display = mode === 'play' ? 'none' : '';
  setAttr(moving, 'transform', `translate(${cardPos.sx.toFixed(1)} ${(cardPos.sy + bob).toFixed(1)}) scale(${(scale * cardFit).toFixed(3)})`);
  setAttr(moving, 'opacity', cardOp.toFixed(3));
  cardHelp.style.display = mode === 'drag' ? '' : 'none';
  if (mode === 'drag') {
    // Readable however far back the camera is. To the right of the card, away from the finger holding it, even past the screen's edge.
    const size = Math.max(cardFit, HELP_FLOOR / cam.scale);
    const x = cardPos.sx + 12 + (CARD_W / 2) * cardFit + (CARD_HELP_W / 2) * size;
    const y = cardPos.sy - (CARD_HELP_H / 2) * size;
    setAttr(cardHelp, 'transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${size.toFixed(3)})`);
  }
  for (const w of EVERY_JOB) {
    if (w === carried) continue;
    const resting = CARDS[w];
    const rest = restAt(w);
    resting.style.display = mode === 'play' ? 'none' : '';
    setAttr(resting, 'transform', `translate(${rest.sx.toFixed(1)} ${(rest.sy + bob).toFixed(1)}) scale(${cardFit.toFixed(3)})`);
    setAttr(resting, 'opacity', '1');
  }
  hint.style.display = mode === 'idle' ? '' : 'none';
  setAttr(hint, 'transform', `translate(${home.sx.toFixed(1)} ${(restAt('page').sy - HINT_OVER * cardFit).toFixed(1)}) scale(${cardFit.toFixed(3)})`);
  setText(hint, played ? 'drag a card onto a device' : `Start: drag ${pageSite()} onto Laptop`);

  // The camera eases between the whole network (between runs) and a close follow of the packet,
  // unless the viewer has taken it over. More than one action at a time needs the whole network.
  const wide = mode === 'play' && (joined.length > 0 || story.attackers.length > 0);
  if (!camFree) {
    const aim = wide ? scene.busyCamera() : mode === 'play' ? scene.followCamera(v) : showAll || attacks.size ? scene.wholeCamera() : scene.overviewCamera();
    const target = peekTarget ? scene.fitChips(aim) : aim;
    const ease = snapCamera ? 1 : Math.min(1, dt * (seek ? 6 : 3.5));
    cam = { cx: lerp(cam.cx, target.cx, ease), cy: lerp(cam.cy, target.cy, ease), scale: lerp(cam.scale, target.scale, ease) };
  }
  snapCamera = false;
  scene.applyCamera(cam);
  const lowest = (spyCard.top ?? window.innerHeight - scene.barHeight) - ACTION_H / 2 - 8;
  /** A button stands by its device and moves only as the device does: out of view with it, and not over the bar. Says whether it is in view. */
  const putAction = (b: HTMLButtonElement, device: string): boolean => {
    const spot = scene.actionSpot(device);
    const size = scene.actionSize();
    b.style.transform = `translate(${spot.x.toFixed(0)}px, ${spot.y.toFixed(0)}px) scale(${size.toFixed(3)})`;
    b.style.setProperty('--size', size.toFixed(3));
    b.dataset.points = spot.points;
    return spot.y >= (mode === 'play' ? ACTION_TOP : 0) && spot.y <= lowest;
  };
  for (const { device, menu } of deviceActions) {
    // It needs something left to run alongside. Closed first: the popup hands focus back to the button.
    const free = mode === 'play' && v < tl.settled && canAdd(device);
    if (!free) menu.setOpen(false);
    // Open, it stays put: the run goes on, and what you are aiming for must not move.
    menu.button.hidden = !free || (!menu.isOpen && !putAction(menu.button, device));
  }
  const reader = mode === 'idle' ? story.devices.find((d) => d.actions.includes('reading')) : undefined;
  readingBtn.hidden = !reader || !putAction(readingBtn, reader.id);

  const shown = mode === 'play' ? v : idleV;
  scene.render(shown, mode === 'play' ? 0 : riseK);
  scene.drawPacket(shown, peek, pill && pillOpen > 0.02 ? { key: pill, k: pillOpen } : null);
  spyCard.update(spyLine ? spyLog(tl, spyLine, shown, spyFrom) : []);
  realClock.hidden = mode !== 'play';
  if (mode === 'play') setText(realClock, `real time ${formatWait(realAt(tl, v))}`);

  const ch = mode === 'play' ? chapterAt(tl, v) : null;
  if (ch !== shownChapter) {
    shownChapter = ch;
    chapter.hidden = !ch;
    if (!ch) showChapterMenu(false);
    markChapter(ch);
    if (ch) {
      chapter.innerHTML = `<span class="chapter-num">${chapterNumber(ch)}</span><span>${chapterName(ch)}</span>`;
      chapter.classList.remove('enter');
      void chapter.offsetWidth;
      chapter.classList.add('enter');
    }
  }

  const stopped = paused || !!peekTarget;
  if (stopped !== showsPlay) {
    showsPlay = stopped;
    pauseBtn.replaceChildren(barIcon(stopped ? drawPlay : drawPause));
    pauseBtn.setAttribute('aria-label', stopped ? 'Play' : 'Pause');
  }
  svg.classList.toggle('between', canSetUp());
  soundBtn.classList.toggle('off', sound.muted);
  setAttr(soundBtn, 'aria-pressed', String(sound.muted));
  awake.set(mode === 'play' && !paused);
  // A tall screen starts close on the laptop, so the rest of the network has to be a press away.
  const closeUp = mode !== 'play' && !showAll && !attacks.size && scene.anythingRevealed && scene.overviewCamera().scale > scene.wholeCamera().scale;
  followBtn.hidden = !camFree && !closeUp;
  setText(followBtn, mode === 'play' && !wide ? '◎ Follow packet' : '◎ Show all');
  backBtn.disabled = pauseBtn.disabled = nextBtn.disabled = mode !== 'play';
  // The setup is for the next run: it would rewrite what has already happened.
  for (const menu of [setupMenu, attackMenu]) {
    menu.button.disabled = !canSetUp();
    if (!canSetUp()) menu.setOpen(false);
  }
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
        return tl.segs.map((s) => ({ kind: s.step.kind, t0: s.t0, t1: s.t1, chapter: s.trip.chapter, device: 'device' in s.step ? s.step.device : 'from' in s.step ? `${s.step.from}→${s.step.to}` : s.step.kind }));
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
      /** Put an attacker on the table or take it off, as a red card does. */
      attack(id: Attack, on = true): void {
        setAttack(id, on);
      },
      /** Start an action on the next device with nothing to do, as its "+ action" does. */
      join(job: Job): void {
        const free = deviceActions.find((a) => canAdd(a.device));
        if (free) joinIn(free.device, job);
      },
      /** Cut a cable or mend it, as the scissors do. */
      cut(line: string): void {
        toggleCut(line);
      },
      /** Drag the ISP router this many tiles away, as a hand would. */
      stretch(tiles: number): void {
        stretch = Math.max(0, Math.min(MAX_STRETCH, tiles));
        preview();
      },
      /** Shake the Wi-Fi, or calm it. */
      shake(on = true): void {
        noise = on ? NOISY : 0;
        preview();
      },
      get tool() {
        return tool;
      },
      get lines() {
        return { cut: [...cutLines] };
      },
      get reactions() {
        return tl.reactions;
      },
      get camera() {
        return cam;
      },
      /** Run to the end, and on into what comes after it. */
      finish(): void {
        v = tl.total;
        paused = false;
        peek = peekTarget = 0;
        doneFor = LINGER;
      },
      /** Where the camera means to be all through a run. */
      path(step: number): (Camera & { v: number })[] {
        const stops: (Camera & { v: number })[] = [];
        for (let t = 0; t < tl.total; t += step) stops.push({ ...scene.followCamera(t), v: t });
        return stops;
      },
      /** Set the Setup for the next run, as the popups do. */
      setup(f: Partial<Features> & { cloud?: boolean; qos?: 0 | 1 | 2 }): void {
        cloud = !!f.cloud;
        qos = f.qos ?? 0;
        showSmart();
        for (const k of SETTINGS) if (features[k] !== !!f[k]) setSetting(k, !!f[k]);
        preview();
      },
      /** Start a run straight away with these things on the table (for screenshots). */
      start(f: Partial<Features> & { photo?: boolean; call?: boolean; ping?: boolean; trace?: boolean; spy?: string; cut?: string | string[]; slow?: boolean; vpn?: boolean; again?: boolean; from?: string; noise?: number; reading?: boolean; cloud?: boolean; qos?: 0 | 1 | 2 }): void {
        reading = false;
        cloud = !!f.cloud;
        qos = f.qos ?? 0;
        client = f.from ?? 'laptop';
        if (f.noise !== undefined) noise = f.noise;
        carried = f.call ? 'call' : f.ping ? 'ping' : f.trace ? 'trace' : f.photo ? 'photo' : 'page';
        for (const k of SETTINGS) if (features[k] !== !!f[k]) setSetting(k, !!f[k]);
        for (const l of [...cutLines]) clearLine(l);
        for (const l of [f.cut ?? []].flat()) toggleCut(l);
        setSpyLine(f.spy ?? null);
        if (f.reading) {
          reading = true;
          client = 'sensor';
        }
        if (f.again) noteDown(client, { site: siteName(), ip: '', until: Infinity });
        else forgetAll(client);
        beginRun();
        runSeed = 1;
        simulate();
        scene.setStory(story, tl);
      },
    },
  });
}

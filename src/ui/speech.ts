import { WAN_DELAY } from '../sim';
import { SLOW_DELAY, type Heard, type Story, type Trip } from './story';
import type { Seg } from './timeline';

/**
 * What the devices say: one short line in plain words as a packet sets off, so a run can be followed without knowing any
 * protocol. Every line comes from what the packet really is. Routers only speak up the first time they do something.
 */
export interface Bubble {
  t0: number;
  t1: number;
  device: string;
  text: string;
}

/** Seconds a line stays up at the least, and how long reading a character of a long one takes. */
const SAY = 3.5;
const SAY_CHAR = 0.1;
/** A line cut shorter than this by the same device's next one is not worth showing. */
const SHORTEST = 0.6;
/** Seconds a run's last line stays up after the last packet is done, so that a run ends rather than stops. */
const END_HOLD = 3.5;
/** A last line this close to the end of a run (seconds) stays up until then; one further off is said again there. */
const NEAR_END = 2;
/** The voice packet that says why a call isn't resent: far enough in for its hello to be read. */
const WHY_NO_RESEND = 20;
const NO_FLOOD_ON_CALL = 'That flood never touched my call';
/** Whoever runs an app, and hears of a reading. */
const APPS = new Set(['laptop', 'phone']);

const DHCP: Record<string, (rest: string) => string> = {
  DISCOVER: () => 'Can anyone give me an address?',
  OFFER: (ip) => `You can have ${ip}`,
  REQUEST: () => "I'll take it",
  ACK: () => "It's yours",
};

/** What each step of a QoS exchange, or of an app coming back, comes down to. */
const MQTT: Record<string, string> = {
  PUBACK: 'Got it',
  PUBREC: 'I have it, and only once',
  PUBREL: 'Good, I can forget mine',
  PUBCOMP: 'All done',
  CONNECT: "I'm back!",
  CONNACK: 'Welcome back',
};

/**
 * What has been said so far that changes what comes next. A resolver going from server to server says why once, and knows
 * when an answer is one it went looking for; the resolver says what it is once; and a device says so when it has its answer.
 */
interface Walk {
  asked: Set<string>;
  looking: boolean;
  explained: boolean;
  answered: Set<string>;
}

/** What the resolver says as it asks a server. */
function asking(name: string, walk: Walk): string {
  walk.looking = true;
  if (walk.asked.has(name)) return `Where is ${name}?`;
  walk.asked.add(name);
  return "I don't have it saved. I'll ask around.";
}

const isBye = (t: Trip): boolean => t.card === 'bye' || t.l4Label.includes('FIN');

/** The plain meaning of a packet, if it has one worth saying. */
function lineOf(t: Trip, walk: Walk, story: Story): string | null {
  if (t.chapter === 'attack') {
    if (t.card === 'junk') return 'Flood it!';
    if (t.l4Label === 'SYN') return 'Anyone home?';
    if (t.l4Label === 'SYN-ACK') return "Yes, that one's open";
    return t.l4Label.includes('RST') ? (t.outward ? 'Noted. Bye.' : 'Nobody here') : null;
  }
  if (t.retry) return 'Sending that again';
  const card = t.card ?? '';
  if (isBye(t)) return t.chapter === 'page' && t.origin === t.client ? 'Bye! Closing our connection' : 'Bye!';
  if (t.message?.kind === 'reading' && t.outward) return `It's ${card}. ${QOS_ASK[story.qos]}`;
  if (t.l4Label.includes('RST')) return 'No, sorry';
  if (card === 'unreachable') return "Can't get there";
  if (t.message?.kind === 'mqtt-control') return MQTT[card] ?? null;
  // The broker says this once, for everyone: it sends a copy to each app.
  if (t.message?.kind === 'reading') return 'A copy for everyone listening';
  switch (t.chapter) {
    case 'address': {
      const [kind = '', ip = ''] = card.split(' ');
      return DHCP[kind]?.(ip) ?? null;
    }
    case 'arp':
      return card.startsWith('who has') ? `Which of you is ${card.slice(8, -1)}?` : "That's me!";
    case 'dns':
      if (card.endsWith('?')) return t.origin === 'resolver' ? asking(card.slice(0, -1), walk) : 'First I need its address. Who knows it?';
      if (card.startsWith('ask ')) return card.startsWith('ask .') ? `Not me. Ask the ${card.slice(4)} server.` : 'Not me. Ask its name server.';
      if (card === 'DNS') return null;
      if (t.origin !== 'resolver') return `That's mine: ${card}`;
      walk.answered.add(t.client);
      if (walk.looking) {
        walk.looking = false;
        return `Found it! It's ${card}`;
      }
      if (walk.explained) return `It's ${card}`;
      walk.explained = true;
      return `I'm like a phone book. It's ${card}`;
    case 'hello':
      if (t.l4Label === 'SYN') return walk.answered.delete(t.client) ? 'Got the address! Hi, can we talk?' : story.remembered && t.client === story.client ? 'I remember the address! Hi, can we talk?' : 'Hi, can we talk?';
      if (t.l4Label === 'SYN-ACK') return story.vpn && t.client === story.client ? 'This came from the VPN server' : "Hi! Yes, let's.";
      return t.hello ? 'Great!' : null;
    case 'secret':
      if (/^hello( 1\/\d+)?$/.test(card)) return t.outward ? "Let's agree on a secret nobody else can read" : 'OK, work it out from this';
      if (t.identity) return 'It really is me';
      return card.startsWith('certificate') ? "Here's my ID" : null;
    case 'page':
      if (t.message?.kind === 'http-request') return `${t.locked ? 'Locked now: please' : 'Please'} send the ${t.message.path.startsWith('/image') ? 'photo' : 'page'}`;
      if (t.part && t.part.of > 1) return t.part.n === 1 ? "Too big for one packet: here's part 1" : null;
      return t.part || t.message?.kind === 'http-response' ? 'Here it is' : null;
    case 'call':
      if (t.part?.n === WHY_NO_RESEND && t.outward) return 'Tiny packets: no time to resend any';
      return t.part?.n === 1 ? (t.outward ? 'Hello?' : 'Hello!') : null;
    case 'ping':
      if (card.startsWith('ping 1/')) return 'Are you there?';
      return card.startsWith('pong 1/') ? "Yes, I'm here!" : null;
    case 'trace':
      if (t.probeTtl !== undefined) return `Go ${t.probeTtl} ${t.probeTtl === 1 ? 'hop' : 'hops'}, then stop`;
      if (card === 'TTL ran out') return 'Stopped here. This is me.';
      return card === 'no such port' ? 'You made it to me!' : null;
    case 'traffic':
      return null;
  }
}

/** What the stranger makes of what it hears: once for what it can read, once for the site's name, once for scrambled bytes. */
export function listenerSpeech(device: string, heard: Heard[], heardAt: ReadonlyMap<string, number>): Bubble[] {
  const lines = { open: 'I can read this!', name: "I can see the site's name", scrambled: 'The rest is scrambled', empty: '' };
  const firsts = new Map<Heard['seen']['kind'], number>();
  for (const h of heard) {
    const t = heardAt.get(h.packetId);
    if (t !== undefined && h.seen.kind !== 'empty' && t < (firsts.get(h.seen.kind) ?? Infinity)) firsts.set(h.seen.kind, t);
  }
  return [...firsts].map(([kind, t]) => ({ device, t0: t, t1: t + SAY, text: lines[kind] }));
}

/** What the device starting the run sets out to do. */
function opening(story: Story, kindOf: Map<string, string>): string | null {
  if (story.reading) return null;
  if (story.probe) return story.probe.kind === 'ping' ? `Is ${story.probe.to} there?` : `What's the way to ${story.probe.to}?`;
  const how = story.vpn ? ' through my VPN' : kindOf.get(story.client) === 'phone' ? ' over Wi-Fi' : '';
  if (story.call) return `I want to call Sam${how}`;
  return `I want to ${story.image ? 'get a photo' : `open ${story.site}`}${how}`;
}

const QOS_ASK = ['Sent once, no receipt', 'Send me a receipt', 'Exactly once, please'] as const;

/** One-way seconds on the line out of the house. */
const wanDelayOf = (story: Story): number => story.links.find((l) => l.id === 'wan')?.delay ?? 0;

/** What the attackers set out to do. Three bots are one plan: the first says it. */
function attackPlans(story: Story, kindOf: Map<string, string>): [string, string][] {
  const first = (kind: string): string | undefined => story.attackers.find((d) => kindOf.get(d) === kind);
  const bot = first('bot');
  const scanner = first('scanner');
  return [
    ...(bot ? ([[bot, "Let's flood the web server!"]] as [string, string][]) : []),
    ...(scanner ? ([[scanner, "Let's try all the server's doors"]] as [string, string][]) : []),
    ...(story.listener ? ([[story.listener, "Let's listen to the Wi-Fi"]] as [string, string][]) : []),
  ];
}

/** What the client can say of an attack at the end, even if it made no difference. */
function attackOutcome(story: Story, flooded: boolean, hurt: boolean, jammed: boolean): string | null {
  const done = story.probe?.done;
  const finished = story.call || story.fetched.includes(story.client) || (done ? (story.probe!.kind === 'ping' ? done.received === done.sent : done.reached) : false);
  if (!flooded) return finished && !hurt ? "I didn't notice a thing" : null;
  if (jammed) return story.fetched.includes(story.client) ? 'Got it, now the flood is over' : 'That flood got in my way';
  // What went wrong then was something else, and the client's own last line says so.
  if (hurt || !finished) return null;
  if (story.call) return NO_FLOOD_ON_CALL;
  return story.vpn && !story.probe ? 'The flood missed me: I went another way' : 'That flood never touched me';
}

/** What the broker knows of the apps a reading could not reach. */
function awayLine(story: Story, away: Story['away']): string {
  const who = away.map((a) => story.devices.find((d) => d.id === a.device)?.label.toLowerCase()).join(' and ');
  const kept = away.every((a) => a.kept);
  if (away.length > 1) return `The ${who} are away. ${kept ? "I'll keep this for them" : 'They miss this one'}`;
  return `The ${who} is away. ${kept ? "I'll keep this for it" : 'It misses this one'}`;
}

/** What came of the run for its client: the page was in parts, a part was lost before it arrived, noise, lost sound. */
interface Outcome {
  many: boolean;
  dropped: boolean;
  noisy: boolean;
  soundLost: boolean;
}

/** What the run's client says at the end, whatever came of it. */
function closing(story: Story, { many, dropped, noisy, soundLost }: Outcome): string {
  if (story.probe) {
    const done = story.probe.done;
    if (!done) return "I couldn't find it";
    if (story.probe.kind === 'ping') return done.received === done.sent ? `It answered every time, in ${Math.round(Number(done.avgMs))} ms!` : done.received ? 'It answered only some of the time' : 'It never answered';
    if (!done.reached) return "I couldn't get all the way there";
    return story.vpn ? 'The tunnel hid the stops in between' : "That's every stop that answered!";
  }
  if (story.call) {
    if (!story.voice?.heard.some(Boolean)) return "I couldn't reach Sam";
    return soundLost || story.voice.heard.includes(null) ? 'Lost sound stays lost. Bye!' : 'Every sound got through. Bye!';
  }
  const thing = story.image ? 'photo' : 'page';
  if (!story.fetched.includes(story.client)) return `I couldn't get the ${thing}`;
  const wan = wanDelayOf(story);
  if (wan >= SLOW_DELAY) return 'Got it! Slow, because it went via space';
  if (dropped) return 'Got it, once the lost part came again';
  if (noisy) return 'Got it! Noisy air, but it got through';
  if (story.thin) return `Got it! This ${thing} fit down the slow line`;
  if (wan > WAN_DELAY) return 'Got it! The long cable made it slower';
  return `${many ? 'Got every part!' : 'Got it!'} Now I can show the ${thing}`;
}

export function buildSpeech(story: Story, segs: Seg[], settled = segs[segs.length - 1]?.t1): Bubble[] {
  const bubbles: Bubble[] = [];
  const say = (device: string, t0: number, text: string, until = 0): Bubble => {
    const bubble = { device, t0, t1: Math.max(until, t0 + Math.max(SAY, text.length * SAY_CHAR)), text };
    bubbles.push(bubble);
    return bubble;
  };
  const spoken = new Set<string>();
  const once = (key: string): boolean => {
    if (spoken.has(key)) return false;
    spoken.add(key);
    return true;
  };
  const kindOf = new Map(story.devices.map((d) => [d.id, d.kind]));
  const walk: Walk = { asked: new Set(), looking: false, explained: false, answered: new Set() };
  const first = segs[0];
  const opens = opening(story, kindOf);
  if (opens && first) say(story.client, 0, opens, first.t0);
  if (first) for (const [device, plan] of attackPlans(story, kindOf)) say(device, 0, plan, first.t0);
  const flooded = story.attackers.some((d) => kindOf.get(d) === 'bot');
  const home = story.devices.find((d) => d.kind === 'home-router')?.id;
  const webServer = story.devices.find((d) => d.kind === 'web-server')?.id ?? 'server';
  /** The devices that lost a packet of theirs, when each of them was last at it, and those that made a call. */
  const hurt = new Set<string>();
  const lastAt = new Map<string, number>();
  const callers = new Set<string>();
  /** A packet of the client's was turned away at a full line: that is the flood, where a cut cable is not. */
  let jammed = false;
  let scanDone = 0;
  const sent = segs.flatMap((s) => [s.trip, ...(s.flow ?? []).map((p) => p.trip)]);
  const many = sent.some((t) => t.chapter === 'page' && t.client === story.client && (t.part?.of ?? 0) > 1);
  /** When the client lost something of its page, or anything to noisy air; and whether a call of its lost sound either way. */
  const losses: { at: number; noise: boolean }[] = [];
  let soundLost = false;
  const ownerOf = (seg: Seg): string | undefined => story.devices.find((d) => d.id === seg.trip.client)?.label.toLowerCase();
  /** The first moment a device can speak again without cutting off a line it is still saying. */
  const free = (device: string, t0: number): number => Math.max(t0, ...bubbles.filter((b) => b.device === device).map((b) => b.t1));
  /** What a stretch of Wi-Fi or a router's queue did, said where it happened. */
  const said = (p: Trip, at: number): void => {
    const fall = p.steps.find((x) => x.kind === 'lost');
    if (!fall || fall.kind !== 'lost') return;
    const noise = story.noise > 0 && story.links.find((l) => l.id === fall.link)?.medium === 'wifi';
    if (p.client === story.client) {
      if (p.chapter === 'call') soundLost = true;
      if (noise || (p.chapter === 'page' && (p.part || p.message))) losses.push({ at, noise });
    }
    if (noise && once('noise')) say(fall.from, at, 'Noisy air! Trying that again');
    if (p.droppedAtQueue && !flooded && once('queue')) say(fall.from, at, 'My queue is full! That one is lost');
  };
  const waits = new Map<string, number>();
  /** How many times each device has sent the thing it is waiting on an answer for. */
  const tries = new Map<string, number>();
  /** When what the run set out to get has reached the device that wanted it. */
  let got = 0;

  for (const seg of segs) {
    const s = seg.step;
    for (const t of [seg.trip, ...(seg.flow ?? []).map((p) => p.trip)]) if (!t.retry) tries.delete(t.origin);
    for (const p of seg.flow ?? []) {
      // The quick repeats of a trace say nothing new.
      const line = p.trip.chapter === 'trace' ? null : lineOf(p.trip, walk, story);
      // An attack goes too fast to read line by line: each says what it is once.
      if (line && (p.trip.chapter !== 'attack' || once(`${p.trip.origin}|${line}`))) say(p.trip.origin, p.t0, line);
      if (p.trip.chapter === 'page' && !p.trip.outward && p.trip.client === story.client && !p.trip.steps.some((x) => x.kind === 'lost')) got = Math.max(got, p.t1);
      if (p.trip.chapter === 'attack' && kindOf.get(p.trip.client) === 'scanner') scanDone = Math.max(scanDone, p.t1);
      said(p.trip, p.t1);
      if (story.joiners.includes(p.trip.client) && home && once('sharing')) say(home, p.t0, 'Two devices, one address: ports sort them out');
      if (p.trip.chapter !== 'attack') {
        lastAt.set(p.trip.client, Math.max(lastAt.get(p.trip.client) ?? 0, p.t1));
        if (p.trip.steps.some((x) => x.kind === 'lost')) hurt.add(p.trip.client);
        if (p.trip.droppedAtQueue && p.trip.client === story.client) jammed = true;
        if (p.trip.chapter === 'call') callers.add(p.trip.client);
      }
      if (flooded && p.trip.droppedAtQueue && once('line full')) say(webServer, p.t1, 'So much junk! My line is full');
      if (flooded && !story.call && !story.probe && p.trip.retry && p.trip.client === story.client && once('stuck')) say(story.client, p.t0, `Where's my ${story.image ? 'photo' : 'page'}? It's stuck`);
    }
    if (s.kind === 'read' && seg.trip.chapter === 'page' && !seg.trip.outward && seg.trip.client === story.client) got = seg.t1;
    for (const w of [...(seg.waits ?? []).map((x) => ({ step: x.step, t0: x.t0 })), ...(s.kind === 'wait' ? [{ step: s, t0: seg.t0 }] : [])]) {
      const longer = w.step.seconds > (waits.get(w.step.device) ?? Infinity) && once(`longer ${w.step.device}`);
      waits.set(w.step.device, w.step.seconds);
      const tried = (tries.get(w.step.device) ?? 0) + 1;
      tries.set(w.step.device, tried);
      // An app that loses its connection gives up on that one and opens another, and only the last time is it over.
      const again = story.reading && segs.some((x) => x.t0 > w.t0 && x.trip.origin === w.step.device && x.trip.chapter === 'hello' && !x.trip.retry);
      const silence = w.step.giveUp ? (story.probe ? 'No answer' : again ? "No answer. I'll start over" : 'No answer. I give up.') : longer ? 'Still nothing. Waiting longer this time' : tried > 1 ? `Try ${tried}: still nothing` : 'No answer yet...';
      say(w.step.device, w.t0, silence);
    }
    // A server finds what was asked first, and speaks when it has it.
    if (!seg.flow && s.kind !== 'lookup' && s.kind !== 'wait' && once(seg.trip.packetId)) {
      const line = lineOf(seg.trip, walk, story);
      const leaves = segs.find((x) => x.trip === seg.trip && (x.step.kind === 'travel' || x.step.kind === 'lost'));
      // A certificate takes several packets, and it only needs saying once.
      if (line && ((seg.trip.chapter !== 'secret' && seg.trip.message?.kind !== 'reading') || once(line))) say(seg.trip.origin, seg.t0, line, leaves?.t0);
    }
    if (s.kind === 'lost') said(seg.trip, seg.t0);
    if (s.kind === 'nat' && kindOf.get(s.device) !== 'vpn-server' && once(`nat-${s.which}`)) {
      const out = wanDelayOf(story) >= SLOW_DELAY ? "Under our home's address, up to space it goes" : "Sending this out under our home's address";
      say(s.device, seg.t0, s.which === 'from' ? out : `This reply is for the ${ownerOf(seg)}`, seg.t1);
    }
    if (s.kind === 'unwrap' && kindOf.get(s.device) === 'router' && once('pass')) say(s.device, seg.t0, seg.trip.tunnel ? "It's locked. I can only pass it on" : 'Not for me, pass it on');
    if (s.kind === 'wrap' && s.layer === 'vpn' && s.device === seg.trip.client && once('vpn lock')) say(s.device, free(s.device, seg.t0), 'Locked! Only the VPN server can open this');
    if (s.kind === 'unwrap' && s.layer === 'vpn' && kindOf.get(s.device) === 'vpn-server' && once('vpn')) say(s.device, seg.t0, "Unlocking this. I'll send it on for you");
    if (s.kind === 'wrap' && s.layer === 'vpn' && kindOf.get(s.device) === 'vpn-server' && once('vpn reply')) say(s.device, seg.t0, `Locking the reply for your ${ownerOf(seg)}`);
  }

  const end = settled;
  /** The last lines of a run, which nothing of the same device's talks over. */
  const finals: Bubble[] = [];
  /** Those said long before the end: what the device has to say in the meantime waits for them. */
  const early: Bubble[] = [];
  /** A last line stays up to the end if that is near. If not, the run goes on, and it is said again to end on. */
  const finish = (device: string, t0: number, text: string, stop: number, ending = text): void => {
    const line = say(device, t0, text);
    if (line.t1 + NEAR_END >= stop) {
      line.t1 = Math.max(line.t1, stop + END_HOLD);
      finals.push(line);
    } else {
      early.push(line);
      finals.push(say(device, stop, ending, stop + END_HOLD));
    }
  };
  if (end !== undefined && story.reading) {
    const told = story.trips.filter((t) => t.message?.kind === 'reading').flatMap((t) => t.steps.flatMap((x) => (x.kind === 'read' && APPS.has(kindOf.get(x.device) ?? '') ? [x.device] : [])));
    const broker = story.devices.find((d) => d.kind === 'mqtt-broker')?.id;
    if (broker && story.away.length) finish(broker, end, awayLine(story, story.away), end);
    if (told[0]) finish(told[0], end, 'I never asked. The broker just told me', end);
    else finish(story.client, end, 'Nobody heard that reading', end);
  } else if (end !== undefined) {
    const outcome = story.attackers.length ? attackOutcome(story, flooded, hurt.has(story.client), jammed) : null;
    const last = lastAt.get(story.client) ?? end;
    const at = story.fetched.includes(story.client) ? got || end : story.call || outcome ? last : end;
    // Someone who joined in ends the run if it finished; anyone else gets to the end on the client's word.
    const others = story.joiners.filter((d) => lastAt.has(d) && !hurt.has(d));
    const before = losses.filter((l) => l.at < got);
    // The page came, and only then did the line go. The client tried to the last, and can't know how far its goodbye got.
    const lastBye = sent.filter((t) => t.chapter === 'page' && t.origin === story.client && isBye(t)).at(-1);
    const unanswered = story.fetched.includes(story.client) && !!lastBye?.steps.some((x) => x.kind === 'lost');
    const text = outcome ?? closing(story, { many, dropped: before.some((l) => !l.noise), noisy: before.some((l) => l.noise), soundLost });
    if (others.length) finals.push(say(story.client, at, text));
    else finish(story.client, at, text, end, !outcome && unanswered ? 'Got it! My bye got no answer' : text);
    for (const d of others) finish(d, lastAt.get(d)!, callers.has(d) ? (flooded ? NO_FLOOD_ON_CALL : 'Call done. Bye!') : story.fetched.includes(d) ? 'Got it too!' : 'All done', end);
  }
  if (scanDone) say(webServer, scanDone, 'Someone tried all my doors');
  if (story.listener && end !== undefined && !story.heard.some((h) => h.seen.kind !== 'empty')) say(story.listener, end, "I can't hear a thing: that's a cable");

  for (const f of early) {
    for (const b of bubbles.filter((x) => x !== f && x.device === f.device && x.t0 >= f.t0 && x.t0 < f.t1)) {
      b.t1 += f.t1 - b.t0;
      b.t0 = f.t1;
    }
  }

  // One device says one thing at a time: the next line takes over.
  const sorted = bubbles.filter((b) => finals.includes(b) || !finals.some((f) => f.device === b.device && b.t0 >= f.t0 && b.t0 < f.t1)).sort((a, b) => a.t0 - b.t0);
  sorted.forEach((b, i) => {
    const next = sorted.slice(i + 1).find((x) => x.device === b.device);
    if (next) b.t1 = Math.min(b.t1, next.t0);
  });
  return sorted.filter((b) => b.t1 - b.t0 >= SHORTEST);
}

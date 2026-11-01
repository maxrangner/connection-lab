import type { Heard, Story, Trip } from './story';
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

/** Seconds a line stays up at the least. */
const SAY = 2.2;
/** A line cut shorter than this by the same device's next one is not worth showing. */
const SHORTEST = 0.6;

const DHCP: Record<string, (rest: string) => string> = {
  DISCOVER: () => 'Can anyone give me an address?',
  OFFER: (ip) => `You can have ${ip}`,
  REQUEST: () => "I'll take it",
  ACK: () => "It's yours",
};

/** The plain meaning of a packet, if it has one worth saying. */
function lineOf(t: Trip): string | null {
  if (t.chapter === 'attack') {
    if (t.card === 'junk') return 'Flood it!';
    if (t.l4Label === 'SYN') return 'Anyone home?';
    if (t.l4Label === 'SYN-ACK') return "Yes, that one's open";
    return t.l4Label.includes('RST') ? (t.outward ? 'Noted. Bye.' : 'Nobody here') : null;
  }
  if (t.retry) return 'Sending that again';
  const card = t.card ?? '';
  if (card === 'bye' || t.l4Label.includes('FIN')) return 'Bye!';
  if (t.l4Label.includes('RST')) return 'No, sorry';
  if (card === 'unreachable') return "Can't get there";
  // The broker says this once, for everyone: it sends a copy to each app.
  if (t.message?.kind === 'reading') return t.outward ? `It's ${card}` : 'A copy for everyone listening';
  switch (t.chapter) {
    case 'address': {
      const [kind = '', ip = ''] = card.split(' ');
      return DHCP[kind]?.(ip) ?? null;
    }
    case 'arp':
      return card.startsWith('who has') ? `W${card.slice(1)}` : "That's me!";
    case 'dns':
      if (card.endsWith('?')) return `What's the address of ${card.slice(0, -1)}?`;
      if (card.startsWith('ask ')) return `Not me. A${card.slice(1)}`;
      return card === 'DNS' ? null : `It's ${card}`;
    case 'hello':
      if (t.l4Label === 'SYN') return 'Hi, can we talk?';
      if (t.l4Label === 'SYN-ACK') return "Hi! Yes, let's.";
      return t.hello ? 'Great!' : null;
    case 'secret':
      if (/^hello( 1\/\d+)?$/.test(card)) return t.outward ? "Let's agree on a secret" : "OK, here's my half";
      if (t.identity) return 'It really is me';
      return card.startsWith('certificate') ? "Here's my ID" : null;
    case 'page':
      if (t.message?.kind === 'http-request') return t.message.path.startsWith('/image') ? 'Please send the photo' : 'Please send the page';
      return (t.part ? t.part.n === 1 : t.message?.kind === 'http-response') ? 'Here it is' : null;
    case 'call':
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

export function buildSpeech(story: Story, segs: Seg[]): Bubble[] {
  const bubbles: Bubble[] = [];
  const say = (device: string, t0: number, text: string, until = 0): void => {
    bubbles.push({ device, t0, t1: Math.max(until, t0 + SAY), text });
  };
  const spoken = new Set<string>();
  const once = (key: string): boolean => {
    if (spoken.has(key)) return false;
    spoken.add(key);
    return true;
  };
  const kindOf = new Map(story.devices.map((d) => [d.id, d.kind]));

  for (const seg of segs) {
    const s = seg.step;
    for (const p of seg.flow ?? []) {
      // The quick repeats of a trace say nothing new.
      const line = p.trip.chapter === 'trace' ? null : lineOf(p.trip);
      // An attack goes too fast to read line by line: each says what it is once.
      if (line && (p.trip.chapter !== 'attack' || once(`${p.trip.origin}|${line}`))) say(p.trip.origin, p.t0, line);
    }
    for (const w of [...(seg.waits ?? []).map((x) => ({ step: x.step, t0: x.t0 })), ...(s.kind === 'wait' ? [{ step: s, t0: seg.t0 }] : [])]) {
      say(w.step.device, w.t0, w.step.giveUp ? 'No answer. I give up.' : 'No answer yet...');
    }
    // A server finds what was asked first, and speaks when it has it.
    if (!seg.flow && s.kind !== 'lookup' && s.kind !== 'wait' && once(seg.trip.packetId)) {
      const line = lineOf(seg.trip);
      const leaves = segs.find((x) => x.trip === seg.trip && (x.step.kind === 'travel' || x.step.kind === 'lost'));
      // A certificate takes several packets, and it only needs saying once.
      if (line && ((seg.trip.chapter !== 'secret' && seg.trip.message?.kind !== 'reading') || once(line))) say(seg.trip.origin, seg.t0, line, leaves?.t0);
    }
    if (s.kind === 'nat' && once(`nat-${s.which}`)) say(s.device, seg.t0, s.which === 'from' ? "I'll put my address on it" : 'Back to the right device', seg.t1);
    if (s.kind === 'unwrap' && kindOf.get(s.device) === 'router' && once('pass')) say(s.device, seg.t0, 'Not for me, pass it on');
    if (s.kind === 'unwrap' && s.layer === 'vpn' && kindOf.get(s.device) === 'vpn-server' && once('vpn')) say(s.device, seg.t0, 'Opening this, sending it on');
  }

  // One device says one thing at a time: the next line takes over.
  const sorted = bubbles.sort((a, b) => a.t0 - b.t0);
  sorted.forEach((b, i) => {
    const next = sorted.slice(i + 1).find((x) => x.device === b.device);
    if (next) b.t1 = Math.min(b.t1, next.t0);
  });
  return sorted.filter((b) => b.t1 - b.t0 >= SHORTEST);
}

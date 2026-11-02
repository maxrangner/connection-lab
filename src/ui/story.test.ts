import { describe, expect, it } from 'vitest';
import { fetchWebPage, runScenario, type ManualFault } from '../sim';
import { buildStory, cardLabel, dhcpCardLabel, dnsCardLabel, type Story, type Trip } from './story';
import { addressBefore, buildTimeline, chapterAt, detailsAt, formatWait, lockPose, packetPose, realAt, seenSoFar, spyLog, stepTarget, swapLanding, swapMoment, trayAngle } from './timeline';

const run = (manual: ManualFault[] = []) => buildStory(runScenario(fetchWebPage(), { seed: 1, faults: { randomLoss: 0, manual } }));
const story = run();
const kinds = (t: Trip): string[] => t.steps.map((s) => (s.kind === 'wrap' || s.kind === 'unwrap' ? `${s.kind}:${s.layer}` : s.kind));
const get = (card: string | null, label?: string): Trip => story.trips.find((t) => t.card === card && (!label || t.l4Label === label))!;

describe('network story', () => {
  it('tells three chapters: find the address, say hello, get the page', () => {
    expect(story.trips.map((t) => [t.chapter, t.card ?? t.l4Label])).toEqual([
      ['dns', 'example.com?'],
      ['dns', '104.20.23.154'],
      ['hello', 'SYN'],
      ['hello', 'SYN-ACK'],
      ['hello', 'ACK'],
      ['page', 'GET /'],
      ['page', 'ACK'],
      ['page', '200 OK'],
      ['page', 'ACK'],
    ]);
  });

  it('packs the request at the laptop, re-sleeves it at routers and unpacks it at the server', () => {
    expect(kinds(get('GET /'))).toEqual([
      'appear', 'wrap:l4', 'wrap:ip', 'wrap:eth', 'travel',
      'unwrap:eth', 'nat', 'wrap:eth', 'travel',
      'unwrap:eth', 'wrap:eth', 'travel',
      'unwrap:eth', 'unwrap:ip', 'unwrap:l4', 'read',
    ]);
    // An empty segment has no card to show or read.
    expect(kinds(get(null, 'SYN'))[0]).toBe('wrap:l4');
    expect(kinds(get(null, 'SYN'))).not.toContain('read');
  });

  it('sends the DNS question over UDP to the resolver and back', () => {
    const q = story.trips[0]!;
    expect(q.l4).toBe('udp');
    expect(q.header.l4).toBe(8);
    expect(q.steps.filter((s) => s.kind === 'travel').map((s) => s.kind === 'travel' && s.to)).toEqual(['home', 'isp', 'resolver']);
    expect(story.dnsAnswer).toBe('104.20.23.154');
  });

  it('uses real header sizes and addresses', () => {
    const get1 = get('GET /');
    expect(get1.header).toEqual({ eth: 14, ip: 20, l4: 32 });
    expect(get1.trailer).toBe(4);
    expect(get1.from).toBe('192.168.1.23');
    expect(get1.steps.find((s) => s.kind === 'nat')).toMatchObject({ device: 'home', which: 'from', after: '203.0.113.7' });
    expect(get('200 OK').steps.find((s) => s.kind === 'nat')).toMatchObject({ device: 'home', which: 'to', after: '192.168.1.23' });
    expect(story.pageTitle).toBe('Example Domain');
  });

  it('follows the ARP exchange only when asked, as its own chapter with no IP or transport pieces', () => {
    expect(story.trips.some((t) => t.chapter === 'arp')).toBe(false);
    const withArp = buildStory(runScenario(fetchWebPage(), { seed: 1, faults: { randomLoss: 0, manual: [] } }), { arp: true });
    const arp = withArp.trips.filter((t) => t.chapter === 'arp');
    expect(arp.map((t) => [t.origin, t.card])).toEqual([
      ['laptop', 'who has 192.168.1.1?'],
      ['home', 'at a4:91:b1:7d:02:01'],
    ]);
    expect(arp[0]).toMatchObject({ l4: 'none', l4Label: '', header: { eth: 14, ip: 0, l4: 0 }, dataBytes: 28, from: '192.168.1.23', to: '192.168.1.1' });
    expect(kinds(arp[0]!)).toEqual(['appear', 'wrap:eth', 'travel', 'unwrap:eth', 'read']);
    expect(arp[1]!.outward).toBe(false);
    expect(withArp.trips.indexOf(arp[1]!)).toBeLessThan(withArp.trips.findIndex((t) => t.chapter === 'dns'));
    // Everything else is as without.
    expect(withArp.trips.filter((t) => t.chapter !== 'arp').map((t) => t.card ?? t.l4Label)).toEqual(story.trips.map((t) => t.card ?? t.l4Label));
  });

  it('keeps the exact bytes each step leaves, for the hex view', () => {
    const t = get('GET /');
    const appear = t.steps.find((s) => s.kind === 'appear')!;
    expect(appear.pdu?.layers.map((l) => l.protocol)).toEqual(['ipv4', 'tcp', 'http']);
    const framed = t.steps.find((s) => s.kind === 'wrap' && s.layer === 'eth')!;
    expect(framed.pdu?.layers[0]?.protocol).toBe('ethernet');
    const nat = t.steps.find((s) => s.kind === 'nat')!;
    expect(nat.pdu?.layers.find((l) => l.protocol === 'ipv4')?.fields.find((f) => f.key === 'ipv4.src')?.display).toBe('203.0.113.7');
  });

  it('turns summaries into card labels', () => {
    expect(cardLabel('HTTP GET / HTTP/1.1')).toBe('GET /');
    expect(cardLabel('HTTP HTTP/1.1 200 OK')).toBe('200 OK');
    expect(dnsCardLabel('DNS query 0x85bb: example.com A?')).toBe('example.com?');
    expect(dnsCardLabel('DNS response 0x85bb: example.com A 104.20.23.154, 172.66.147.243')).toBe('104.20.23.154');
    expect(dnsCardLabel('DNS referral 0xb8c1: example.com → com NS l.gtld-servers.net, j.gtld-servers.net, …')).toBe('ask .com');
    expect(dnsCardLabel('DNS referral 0x80dd: example.com → example.com NS hera.ns.cloudflare.com, elliott.ns.cloudflare.com')).toBe('ask name server');
    expect(dnsCardLabel('DNS referral 0x80dd: info.cern.ch → cern.ch NS scsnms.switch.ch, ext-dns-1.cern.ch, …')).toBe('ask name server');
    expect(dnsCardLabel('DNS referral 0x80dd: httpbin.org → httpbin.org NS ns-173.awsdns-21.com, ns-884.awsdns-46.net, …')).toBe('ask name server');
  });
});

describe('a voice call in the story', () => {
  const call = (manual: ManualFault[] = []) => buildStory(runScenario(fetchWebPage({ call: true }), { seed: 1, faults: { randomLoss: 0, manual } }));
  const s = call();
  const flow = (x: Story): Trip[] => x.trips.flatMap((t) => t.steps.flatMap((y) => (y.kind === 'flow' ? y.packets : [])));

  it('tells two chapters: find the address, then the call as one flow of every voice packet both ways', () => {
    expect(s.trips.map((t) => [t.chapter, t.card ?? t.l4Label])).toEqual([
      ['dns', 'sam.example?'],
      ['dns', '198.51.100.42'],
      ['call', 'voice'],
    ]);
    const stream = s.trips[2]!;
    expect(stream.kind).toBe('call');
    expect(stream.part).toBeUndefined();
    expect(stream.steps.map((x) => x.kind)).toEqual(['flow']);
    const packets = flow(s);
    expect(packets).toHaveLength(100);
    for (const outward of [true, false]) {
      const side = packets.filter((t) => t.outward === outward);
      expect(side.map((t) => t.part!.n)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
      expect(side.every((t) => t.part!.of === 50 && t.card === 'voice' && t.l4 === 'udp' && t.chapter === 'call' && t.client === 'laptop' && t.dataBytes === 172 && t.audio?.length === 160)).toBe(true);
      expect(side[0]!.origin).toBe(outward ? 'laptop' : 'friend');
    }
    expect(packets[0]!.header).toEqual({ eth: 14, ip: 20, l4: 8 });
    expect(packets.every((t) => !t.retry && !t.timedOut)).toBe(true);
  });

  it('is a call, not a page: no title, the friend’s address from DNS, the sound both ways', () => {
    expect(s.call).toBe(true);
    expect(s.site).toBe('sam.example');
    expect(s.pageTitle).toBeNull();
    expect(s.image).toBeNull();
    expect(s.dnsAnswer).toBe('198.51.100.42');
    expect(s.dnsTtl).toBe(300);
    expect(s.voice!.sent).toHaveLength(8000);
    expect(s.voice!.heard).toHaveLength(50);
    expect(s.voice!.heard.every((h) => h?.length === 160)).toBe(true);
    expect(s.names['198.51.100.42']).toBe("Friend's phone");
    expect(story.call).toBe(false);
    expect(story.voice).toBeUndefined();
  });

  it('a lost packet falls off the cable and leaves a hole nobody fills: no retry, no timer', () => {
    const third = flow(s).find((t) => t.part?.n === 3 && !t.outward)!;
    const x = call([{ packetId: third.packetId, linkId: 'bb6' }]);
    const packets = flow(x);
    expect(packets).toHaveLength(100);
    const lost = packets.filter((t) => t.lost);
    expect(lost.map((t) => [t.origin, t.part!.n])).toEqual([['friend', 3]]);
    expect(lost[0]!.steps.at(-1)).toMatchObject({ kind: 'lost', link: 'bb6' });
    expect(packets.some((t) => t.retry || t.timedOut)).toBe(false);
    expect(x.voice!.heard.map((h, i) => (h ? null : i + 1)).filter((n) => n)).toEqual([3]);
    expect(x.voice!.heard.filter((h) => h)).toHaveLength(49);
    expect(() => buildTimeline(x)).not.toThrow();
  });

  it('a snoop on the line hears plain voice', () => {
    const first = flow(s)[0]!;
    const travel = first.steps.find((x) => x.kind === 'travel');
    expect(travel?.kind === 'travel' && travel.seen).toMatchObject({ kind: 'open', lines: ['voice, 160 bytes (20 ms)'] });
    expect(first.steps[0]?.details?.card?.map((row) => row.name)).toEqual(['Version', 'Payload type', 'Sequence number', 'Timestamp', 'SSRC', 'Audio']);
  });
});

describe('a cold resolver in the story', () => {
  const s = buildStory(runScenario(fetchWebPage({ cold: true }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
  const dns = s.trips.filter((t) => t.chapter === 'dns');

  it('follows the walk root → .com → the site’s own server before the answer comes back', () => {
    expect(dns.map((t) => [t.origin, t.card])).toEqual([
      ['laptop', 'example.com?'],
      ['resolver', 'example.com?'],
      ['root', 'ask .com'],
      ['resolver', 'example.com?'],
      ['tld', 'ask name server'],
      ['resolver', 'example.com?'],
      ['auth', '104.20.23.154'],
      ['resolver', '104.20.23.154'],
    ]);
    expect(dns.every((t) => t.card!.length <= 20)).toBe(true);
    expect(s.trips[8]!.l4Label).toBe('SYN');
  });

  it('the same question to one server after another is not a retry', () => {
    expect(dns.some((t) => t.retry || t.timedOut)).toBe(false);
    expect(dns.filter((t) => t.outward)).toHaveLength(1);
  });

  it('every server looks the name up before it answers, and says what it found', () => {
    const lookups = s.trips.flatMap((t) => t.steps.flatMap((x) => (x.kind === 'lookup' && x.what === 'dns' ? [[x.device, x.ask, x.found]] : [])));
    expect(lookups).toEqual([
      ['root', 'example.com', 'ask .com'],
      ['tld', 'example.com', 'ask name server'],
      ['auth', 'example.com', '104.20.23.154'],
      ['resolver', 'example.com', '104.20.23.154'],
    ]);
  });

  it('the answer the laptop keeps is the resolver’s, with the authoritative TTL', () => {
    expect(s.dnsAnswer).toBe('104.20.23.154');
    expect(s.dnsTtl).toBe(300);
    expect(s.remembered).toBeNull();
    expect(s.pageTitle).toBe('Example Domain');
    expect(s.names['198.41.0.4']).toBe('Root server');
  });

  it('lays out on a timeline, with trips over the resolver’s own cables', () => {
    const tl = buildTimeline(s);
    const links = new Set(tl.segs.flatMap((x) => (x.step.kind === 'travel' ? [x.step.link] : [])));
    for (const l of ['up1', 'up2', 'up3']) expect(links.has(l)).toBe(true);
    expect(tl.reactions.filter((r) => r.device === 'resolver' && r.face === 'thumbs').length).toBeGreaterThanOrEqual(1);
  });
});

describe('knocking a packet off a cable', () => {
  const getTrip = get('GET /');
  const knocked = run([{ packetId: getTrip.packetId, linkId: 'wan' }]);

  it('ends that trip with a fall on that cable, and the laptop sends a new GET', () => {
    const lost = knocked.trips.find((t) => t.packetId === getTrip.packetId)!;
    expect(lost.lost).toBe(true);
    expect(lost.steps[lost.steps.length - 1]).toMatchObject({ kind: 'lost', from: 'home', to: 'isp' });
    const retry = knocked.trips[knocked.trips.indexOf(lost) + 1]!;
    expect(retry).toMatchObject({ card: 'GET /', retry: true, origin: 'laptop' });
    expect(retry.start - lost.start).toBeGreaterThanOrEqual(1); // RFC 6298: at least 1 s
    expect(knocked.pageTitle).toBe('Example Domain');
  });

  it('waits for the timer at the resender, then tries again', () => {
    const tl = buildTimeline(knocked, new Map([[`${getTrip.packetId}@wan`, 0.5]]));
    const wait = tl.segs.find((s) => s.step.kind === 'wait')!;
    expect(wait.step).toMatchObject({ device: 'laptop', giveUp: false });
    expect(tl.cues.some((c) => c.sound === 'bonk')).toBe(true);
  });

  it('does not change anything that happened before the knock', () => {
    const plain = buildTimeline(story);
    const tl = buildTimeline(knocked, new Map([[`${getTrip.packetId}@wan`, 0.5]]));
    const lostAt = tl.segs.findIndex((s) => s.step.kind === 'lost');
    expect(tl.segs.slice(0, lostAt).map((s) => [s.step.kind, s.t0, s.t1])).toEqual(plain.segs.slice(0, lostAt).map((s) => [s.step.kind, s.t0, s.t1]));
    expect(tl.segs[lostAt]!.t0).toBe(plain.segs[lostAt]!.t0);
  });

  it('a lost DNS question is asked again after 5 s', () => {
    const q = story.trips[0]!;
    const s = run([{ packetId: q.packetId, linkId: 'lan' }]);
    const retry = s.trips[1]!;
    expect(retry).toMatchObject({ card: 'example.com?', retry: true });
    expect(retry.start - s.trips[0]!.start).toBeCloseTo(5, 3);
  });
});

describe('setup options', () => {
  it('bigger page: the first website comes back in numbered parts', () => {
    const s = buildStory(runScenario(fetchWebPage({ site: 'info.cern.ch' }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
    expect(s.site).toBe('info.cern.ch');
    expect(s.trips.find((t) => t.chapter === 'page')?.card).toBe('GET …/TheProject.html');
    const parts = s.trips.filter((t) => t.part);
    expect(parts.map((t) => t.card)).toEqual(['200 OK 1/2', '2/2']);
    expect(s.pageTitle).toBe('The World Wide Web project');
  });

  it('visit again: no address lookup, the laptop remembers it', () => {
    const s = buildStory(runScenario(fetchWebPage({ revisit: true }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
    expect(s.trips.some((t) => t.chapter === 'dns')).toBe(false);
    expect(s.remembered).toBe('104.20.23.154');
    expect(s.trips[0]!.l4Label).toBe('SYN');
  });

  it('random loss on the internet side: each loss is followed by a retry or a give-up', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const s = buildStory(runScenario(fetchWebPage(), { seed, faults: { randomLoss: 0.15, lossyLinks: ['wan', 'bb1', 'bb2'], manual: [] } }));
      for (const t of s.trips.filter((x) => x.lost)) {
        const last = t.steps[t.steps.length - 1]!;
        expect(last.kind === 'lost' && ['wan', 'bb1', 'bb2'].includes(last.link)).toBe(true);
      }
      const waits = buildTimeline(s).segs.flatMap((x) => (x.step.kind === 'wait' ? [x.step] : []));
      expect(waits.filter((w) => !w.giveUp)).toHaveLength(s.trips.filter((x) => x.timedOut).length);
      for (const t of s.trips.filter((x) => x.lost && x.l4Label !== 'ACK')) {
        // A lost SYN needs nothing more once the other side's own resend has got through.
        const answered = t.l4Label === 'SYN' && s.trips.some((x) => x.l4Label === 'SYN-ACK' && x.retry && !x.lost);
        expect(answered || s.trips.some((x) => x.retransmitOf === t.packetId || (x.retry && x.chapter === 'dns')) || waits.some((w) => w.giveUp)).toBe(true);
      }
    }
  });
});

describe('packet facing', () => {
  const tl = buildTimeline(story);
  const angleDiff = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

  it('never jumps within a trip, and lies along the stations inside every device', () => {
    for (const trip of story.trips) {
      const segs = tl.segs.filter((s) => s.trip === trip && s.step.kind !== 'wait');
      let prev: number | null = null;
      for (const seg of segs) {
        for (let i = 0; i <= 400; i++) {
          const { angle } = packetPose(tl, seg, i / 400);
          if (prev !== null) expect(angleDiff(angle, prev)).toBeLessThan(0.05);
          prev = angle;
          if (seg.step.kind !== 'travel' && seg.step.kind !== 'lost') expect(angleDiff(angle, trayAngle(trip))).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('turns only on the cable that branches off to the resolver', () => {
    const turned = new Set<string>();
    for (const seg of tl.segs) {
      if (seg.step.kind !== 'travel') continue;
      const mid = packetPose(tl, seg, 0.5).angle;
      if (angleDiff(mid, trayAngle(seg.trip)) > 0.1) turned.add(seg.step.link);
    }
    expect([...turned]).toEqual(['bb1']);
  });
});

describe('emoji statuses', () => {
  it('thumbs up for replies and the final ACK, love when the page is in', () => {
    const tl = buildTimeline(story);
    expect(tl.reactions.map((r) => `${r.device}:${r.face}`)).toEqual(['laptop:thumbs', 'laptop:thumbs', 'server:thumbs', 'laptop:love']);
  });

  it('confused when part 2 arrives before part 1, love once the gap is filled', () => {
    const plain = buildStory(runScenario(fetchWebPage({ site: 'info.cern.ch' }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
    const first = plain.trips.find((t) => t.part?.n === 1)!;
    const s = buildStory(runScenario(fetchWebPage({ site: 'info.cern.ch' }), { seed: 1, faults: { randomLoss: 0, manual: [{ packetId: first.packetId, linkId: 'bb2' }] } }));
    const faces = buildTimeline(s).reactions.filter((r) => r.device === 'laptop').map((r) => r.face);
    expect(faces.slice(-2)).toEqual(['confused', 'love']);
  });

  it('angry when the resend is lost too, crying when it gives up', () => {
    const q = story.trips[0]!;
    const once = buildStory(runScenario(fetchWebPage(), { seed: 1, faults: { randomLoss: 0, manual: [{ packetId: q.packetId, linkId: 'lan' }] } }));
    const retry = once.trips[1]!;
    const twice = buildStory(
      runScenario(fetchWebPage(), { seed: 1, faults: { randomLoss: 0, manual: [{ packetId: q.packetId, linkId: 'lan' }, { packetId: retry.packetId, linkId: 'lan' }] } }),
    );
    const moods = buildTimeline(twice).segs.flatMap((x) => (x.step.kind === 'wait' ? [x.step.mood] : []));
    expect(moods).toEqual(['surprise', 'cry']);
    const get = story.trips.find((t) => t.card === 'GET /')!;
    const s1 = buildStory(runScenario(fetchWebPage(), { seed: 1, faults: { randomLoss: 0, manual: [{ packetId: get.packetId, linkId: 'wan' }] } }));
    const get2 = s1.trips.find((t) => t.card === 'GET /' && t.retry)!;
    const s2 = buildStory(
      runScenario(fetchWebPage(), { seed: 1, faults: { randomLoss: 0, manual: [{ packetId: get.packetId, linkId: 'wan' }, { packetId: get2.packetId, linkId: 'wan' }] } }),
    );
    expect(buildTimeline(s2).segs.flatMap((x) => (x.step.kind === 'wait' ? [x.step.mood] : []))).toEqual(['surprise', 'angry']);
  });
});

describe('cutting and mending a cable mid-run', () => {
  const run = (seed: number, cuts: { link: string; from: number; to?: number }[], decided: Record<string, boolean>) =>
    buildTimeline(buildStory(runScenario(fetchWebPage(), { seed, faults: { randomLoss: 0, decided, cuts, manual: [] }, maxTime: 1000 })));
  const same = (a: ReturnType<typeof run>, b: ReturnType<typeof run>, v: number) => {
    const pick = (tl: ReturnType<typeof run>) => tl.segs.filter((s) => s.t0 <= v).map((s) => [s.step.kind, s.trip.packetId, s.t0, s.t1]);
    expect(pick(b)).toEqual(pick(a));
  };

  it('never changes what was already seen, cutting or mending', () => {
    let changed = 0;
    for (const link of ['wan', 'bb2']) {
      const clear = run(1, [], {});
      const cut = run(1, [{ link, from: 0 }], {});
      for (const frac of [0.15, 0.4, 0.7]) {
        const v = clear.total * frac;
        const a = seenSoFar(clear, v, link);
        const on = run(1, [{ link, from: a.now }], a.decided);
        same(clear, on, v);
        if (on.segs.some((s) => s.step.kind === 'lost')) changed++;
        const w = cut.total * frac;
        const b = seenSoFar(cut, w, link);
        same(cut, run(1, [{ link, from: 0, to: b.now }], b.decided), w);
      }
    }
    // And the cut really does something after it starts.
    expect(changed).toBeGreaterThan(0);
  });
});

describe('satellite line in the timeline', () => {
  it('arches the home→ISP hop into the sky and takes longer to cross it', () => {
    const s = buildStory(runScenario(fetchWebPage({ slow: true }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
    const tl = buildTimeline(s);
    expect([...tl.sky.keys()]).toEqual(['wan']);
    const wan = tl.segs.find((x) => x.step.kind === 'travel' && x.step.link === 'wan')!;
    const lan = tl.segs.find((x) => x.step.kind === 'travel' && x.step.link === 'lan')!;
    expect(wan.t1 - wan.t0).toBeGreaterThan(2 * (lan.t1 - lan.t0));
    const top = packetPose(tl, wan, 0.5).pos.z;
    expect(top).toBeGreaterThan(5);
  });
});

describe('phone over Wi-Fi in the story', () => {
  const s = buildStory(runScenario(fetchWebPage({ from: 'phone' }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
  const tl = buildTimeline(s);

  it('starts at the phone, never visits the laptop', () => {
    expect(s.client).toBe('phone');
    expect(s.trips[0]!.origin).toBe('phone');
    expect(s.trips.some((t) => t.steps.some((x) => ('device' in x ? x.device : 'from' in x ? x.from + x.to : '').includes('laptop')))).toBe(false);
  });

  it('the home router takes off the Wi-Fi frame and puts on an Ethernet one', () => {
    const get = s.trips.find((t) => t.card === 'GET /')!;
    const frames = get.steps.flatMap((x) => (x.kind === 'wrap' || x.kind === 'unwrap') && x.frame ? [`${x.kind}:${x.device}:${x.frame.l2}:${x.frame.head}`] : []);
    expect(frames.slice(0, 3)).toEqual(['wrap:phone:wifi:32', 'unwrap:home:wifi:32', 'wrap:home:ethernet:14']);
  });

  it('the packet turns smoothly onto the Wi-Fi hop and lies along the stations again', () => {
    const angleDiff = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    for (const trip of s.trips) {
      let prev: number | null = null;
      for (const seg of tl.segs.filter((x) => x.trip === trip && x.step.kind !== 'wait')) {
        for (let i = 0; i <= 400; i++) {
          const { angle } = packetPose(tl, seg, i / 400);
          if (prev !== null) expect(angleDiff(angle, prev)).toBeLessThan(0.05);
          prev = angle;
        }
      }
    }
  });
});

describe('noisy Wi-Fi in the story', () => {
  const noisy = (noise: number, warmArp = false) => runScenario(fetchWebPage({ from: 'phone', noise, warmArp }), { seed: 1, faults: { randomLoss: 0, manual: [] }, maxTime: 1000 });
  const r = noisy(0.5);
  const s = buildStory(r);
  const onWlan = (t: Trip) => t.steps.filter((x): x is Extract<Trip['steps'][number], { kind: 'travel' | 'lost' }> => (x.kind === 'travel' || x.kind === 'lost') && x.link === 'wlan');

  it('says how noisy the radio is, and follows no Ack frames', () => {
    expect(s.noise).toBe(0.5);
    expect(story.noise).toBe(0);
    expect(buildStory(runScenario(fetchWebPage({ from: 'phone' }), { seed: 1, faults: { randomLoss: 0, manual: [] } })).noise).toBe(0);
    for (const t of s.trips) expect(r.packets.get(t.packetId)!.kind).not.toBe('wifi-ack');
    expect(s.pageTitle).toBe('Example Domain');
  });

  it('a frame lost to interference is a fall and then the same packet travels the Wi-Fi again, as a retry, with the Retry bit in its bytes', () => {
    const retried = s.trips.filter((t) => onWlan(t).some((x) => x.kind === 'lost') && onWlan(t).some((x) => x.kind === 'travel'));
    expect(retried.length).toBeGreaterThan(0);
    for (const t of retried) {
      const steps = onWlan(t);
      expect(steps[0]!.kind).toBe('lost');
      expect(steps.at(-1)).toMatchObject({ kind: 'travel', retry: true });
      for (const x of steps.slice(1)) expect(x.kind === 'travel' ? x.retry : true).toBe(true);
      // A mid-way fall does not lose the trip, and it is no resend by TCP or DNS.
      expect(t.lost).toBe(false);
      expect(t.retry).toBe(false);
      expect(t.timedOut).toBe(false);
      expect(t.steps.at(-1)!.kind).not.toBe('lost');
      const again = steps.at(-1)!;
      expect(again.pdu?.layers[0]?.summary).toContain('retry');
      expect(again.details?.ethH?.some((row) => row.name === 'Retry' && row.value === '1 (sent again)')).toBe(true);
      expect(again.seen).toBeTruthy();
    }
    // Every copy of a frame that got across was acknowledged, one way or another.
    expect(s.trips.some((t) => onWlan(t).some((x) => x.kind === 'travel' && x.acked))).toBe(true);
    const first = s.trips.find((t) => onWlan(t).length === 1 && onWlan(t)[0]!.kind === 'travel')!;
    expect(onWlan(first)[0]).not.toHaveProperty('retry');
  });

  it('lays out on a timeline: a fall off the air, then the retry crossing it, and the page arriving', () => {
    const tl = buildTimeline(s);
    const segs = tl.segs.filter((x) => (x.step.kind === 'lost' || x.step.kind === 'travel') && x.step.link === 'wlan');
    const i = segs.findIndex((x, n) => x.step.kind === 'lost' && segs[n + 1]?.step.kind === 'travel' && segs[n + 1]!.trip === x.trip);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(segs[i + 1]!.t0).toBeGreaterThanOrEqual(segs[i]!.t1);
    expect(tl.reactions.at(-1)).toMatchObject({ device: 'phone', face: 'love' });
    expect(tl.segs.filter((x) => x.step.kind === 'wait')).toHaveLength(0);
  });

  it('a radio that gives up loses the packet for good: the trip ends with the last fall', () => {
    // With the router's MAC known already, or the question would never reach the air: ARP fails first.
    const dead = buildStory(noisy(1, true));
    expect(dead.noise).toBe(1);
    expect(dead.pageTitle).toBeNull();
    const asked = dead.trips.filter((t) => t.chapter === 'dns' && t.outward);
    expect(asked.length).toBeGreaterThan(0);
    for (const t of asked) {
      expect(t.lost).toBe(true);
      expect(t.steps.at(-1)).toMatchObject({ kind: 'lost', link: 'wlan', from: 'phone', to: 'home' });
      expect(onWlan(t).every((x) => x.kind === 'lost')).toBe(true);
      expect(onWlan(t)).toHaveLength(1 + 7);
    }
    expect(() => buildTimeline(dead)).not.toThrow();
  });
});

describe('HTTPS in the story', () => {
  const s = buildStory(runScenario(fetchWebPage({ https: true }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));

  it('adds an "agree on a secret" chapter between the hello and the page', () => {
    const order = [...new Set(s.trips.map((t) => t.chapter))];
    expect(order).toEqual(['dns', 'hello', 'secret', 'page']);
  });

  it('the hellos travel open; the certificate, the GET and the page travel locked', () => {
    const byCard = (re: RegExp) => s.trips.filter((t) => re.test(t.card ?? ''));
    expect(byCard(/^hello/).length).toBeGreaterThanOrEqual(2);
    expect(byCard(/^hello/).every((t) => !t.locked)).toBe(true);
    expect(byCard(/^certificate/).every((t) => t.locked)).toBe(true);
    expect(byCard(/^GET \/$/)).toHaveLength(1);
    expect(byCard(/^GET \/$/)[0]!.locked).toBe(true);
    expect(byCard(/^200 OK/).every((t) => t.locked)).toBe(true);
    expect(s.pageTitle).toBe('Example Domain');
  });

  it('only the last packet of a handshake flight gets a thumbs up', () => {
    const faces = buildTimeline(s).reactions.map((r) => `${r.device}:${r.face}`);
    expect(faces.filter((f) => f === 'laptop:thumbs').length).toBe(3); // DNS answer, SYN-ACK, end of the server's hello
    expect(faces[faces.length - 1]).toBe('laptop:love');
  });
});

describe('padlock and key', () => {
  const s = buildStory(runScenario(fetchWebPage({ https: true }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
  const tl = buildTimeline(s);
  const get = s.trips.find((t) => t.card === 'GET /')!;

  it('locks right after the card appears and unlocks just before it is read', () => {
    const kinds = get.steps.map((x) => x.kind);
    expect(kinds.indexOf('lock')).toBe(kinds.indexOf('appear') + 1);
    expect(kinds.indexOf('unlock')).toBe(kinds.indexOf('read') - 1);
    expect(s.trips.filter((t) => !t.locked).some((t) => t.steps.some((x) => x.kind === 'lock'))).toBe(false);
  });

  it('both ends get the key before they first need it, the server first', () => {
    const first = (kind: 'lock' | 'unlock', device: string): number => tl.segs.find((x) => x.step.kind === kind && x.step.device === device)!.t0;
    expect(tl.keys.get('server')!).toBeLessThan(tl.keys.get('laptop')!);
    expect(tl.keys.get('server')!).toBeLessThanOrEqual(first('lock', 'server'));
    expect(tl.keys.get('laptop')!).toBeLessThanOrEqual(first('unlock', 'laptop'));
  });

  it('plain HTTP has no keys', () => {
    expect(buildTimeline(story).keys.size).toBe(0);
  });

  it('the card stays open until the lock shuts, stays dark on the way, and opens at the other end', () => {
    const seg = (kind: string) => tl.segs.find((x) => x.trip === get && x.step.kind === kind)!;
    expect(lockPose(seg('appear'), 0.5)).toMatchObject({ show: false, dark: 0 });
    expect(lockPose(seg('lock'), 0)).toMatchObject({ show: true, dark: 0, open: 1, drop: 1 });
    expect(lockPose(seg('lock'), 1)).toMatchObject({ show: true, dark: 1, open: 0, drop: 0 });
    expect(lockPose(seg('travel'), 0.5)).toMatchObject({ show: true, dark: 1, open: 0 });
    expect(lockPose(seg('unlock'), 0)).toMatchObject({ show: true, dark: 1, open: 0 });
    expect(lockPose(seg('unlock'), 1)).toMatchObject({ show: false, dark: 0 });
    expect(lockPose(seg('read'), 0.5)).toMatchObject({ show: false, dark: 0 });
  });

  it('the key is in the keyhole when it turns, and home again when it stops', () => {
    for (const kind of ['lock', 'unlock'] as const) {
      const seg = tl.segs.find((x) => x.trip === get && x.step.kind === kind)!;
      for (let i = 0; i <= 100; i++) {
        const key = lockPose(seg, i / 100).key;
        if (key && key.turn > 0.5) expect(key.to).toBeGreaterThan(0.5);
      }
    }
  });
});

describe('step buttons', () => {
  const tl = buildTimeline(story);

  it('go to the next action, and back to the start of this one or the last', () => {
    const a = tl.segs[3]!;
    const b = tl.segs[4]!;
    expect(stepTarget(tl, a.t0, 1)).toBe(b.t0);
    expect(stepTarget(tl, b.t0 + 0.5, -1)).toBe(b.t0);
    expect(stepTarget(tl, b.t0, -1)).toBe(a.t0);
  });

  it('go one further back when pressed just after a start, so the packet never loops', () => {
    const a = tl.segs[3]!;
    const b = tl.segs[4]!;
    const grace = (b.t1 - b.t0) * 0.8;
    expect(stepTarget(tl, b.t0 + grace / 2, -1, grace)).toBe(a.t0);
    expect(stepTarget(tl, b.t0 + grace, -1, grace)).toBe(b.t0);
  });

  it('stop at both ends', () => {
    expect(stepTarget(tl, tl.total, 1)).toBe(tl.total);
    expect(stepTarget(tl, 0, -1)).toBe(0);
  });
});

describe('what a server does before it answers', () => {
  const steps = (s: ReturnType<typeof run>) => s.trips.flatMap((t) => t.steps.filter((x) => x.kind === 'lookup').map((x) => ({ t, x })));

  it('looks the name up in the book, and the answer is what goes back', () => {
    const [dns] = steps(story);
    expect(dns!.x).toMatchObject({ what: 'dns', device: dns!.t.origin, ask: 'example.com', found: story.dnsAnswer });
    expect(dns!.t.card).toBe(story.dnsAnswer);
    expect(dns!.t.steps[0]).toBe(dns!.x);
  });

  it('takes the file off the shelf once, before the reply, also for a page in parts or over HTTPS', () => {
    for (const options of [{}, { site: 'info.cern.ch' as const }, { https: true }]) {
      const s = buildStory(runScenario(fetchWebPage(options), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
      const web = steps(s).filter(({ x }) => x.kind === 'lookup' && x.what === 'web');
      expect(web.length).toBe(1);
      expect(web[0]!.x).toMatchObject({ ask: expect.stringMatching(/^(\/|…\/)/), found: s.pageTitle });
      expect(s.trips.slice(0, s.trips.indexOf(web[0]!.t)).some((t) => t.outward && t.card?.startsWith('GET'))).toBe(true);
    }
  });
});

describe('the details in a pill', () => {
  const tl = buildTimeline(story);
  const atStep = (card: string, match: (s: { kind: string }) => boolean) => tl.segs.find((x) => x.trip.card === card && match(x.step))!;
  const value = (rows: { name: string; value: string }[] | undefined, name: string) => rows?.find((r) => r.name === name)?.value;

  it('come from the frame on this stretch: the address changes at the router, the TTL drops', () => {
    const links = tl.segs.filter((x) => x.trip.card === 'GET /' && x.step.kind === 'travel');
    const start = detailsAt(links[0]!, 0.5);
    const after = detailsAt(links[2]!, 0.5);
    expect(value(start.ip, 'Source IP')).toBe('192.168.1.23');
    expect(value(after.ip, 'Source IP')).not.toBe('192.168.1.23');
    expect(parseInt(value(after.ip, 'Time to Live')!)).toBeLessThan(parseInt(value(start.ip, 'Time to Live')!));
    expect(value(start.ethH, 'Source MAC')).not.toBe(value(after.ethH, 'Source MAC'));
  });

  it('change at the moment the router translates, not before', () => {
    const nat = atStep('GET /', (s) => s.kind === 'nat');
    expect(value(detailsAt(nat, 0.1).ip, 'Source IP')).toBe('192.168.1.23');
    expect(value(detailsAt(nat, 0.9).ip, 'Source IP')).not.toBe('192.168.1.23');
  });

  it('are there before the first cable, and say what the card carries', () => {
    const d = detailsAt(atStep('GET /', (s) => s.kind === 'appear'), 0.5);
    expect(value(d.card, 'Request line')).toBe('GET / HTTP/1.1');
    expect(value(d.l4, 'Destination port')).toContain('80');
    // The frame only exists once it is wrapped.
    expect(d.ethT).toBeUndefined();
    expect(detailsAt(atStep('GET /', (s) => s.kind === 'travel'), 0.5).ethT?.length).toBeGreaterThan(0);
  });

  it('under a VPN only the case can be read on the line, and the sender still knows what is inside', () => {
    const s = buildStory(runScenario(fetchWebPage({ vpn: true }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
    const t = buildTimeline(s);
    const seg = t.segs.find((x) => x.trip.card === 'GET /' && x.step.kind === 'travel')!;
    const on = seg.step.kind === 'travel' ? seg.step.details! : {};
    expect(value(on.vpn, 'Message type')).toContain('transport data');
    expect(value(on.vpn, 'Destination IP')).toBe('198.51.100.10');
    expect(value(detailsAt(seg, 0.5).ip, 'Destination IP')).toBe('104.20.23.154');
  });
});

describe('the details in a pill, hop by hop', () => {
  const tl = buildTimeline(story);
  const value = (rows: { name: string; value: string }[] | undefined, name: string) => rows?.find((r) => r.name === name)?.value;

  it('a new sleeve has its new addresses and the TTL has already dropped, before it sets off', () => {
    const segs = tl.segs.filter((x) => x.trip.card === 'GET /');
    const hop = segs.findIndex((x, i) => x.step.kind === 'wrap' && x.step.layer === 'eth' && segs[i - 1]?.step.kind === 'unwrap');
    const wrap = detailsAt(segs[hop]!, 0.1);
    const travel = detailsAt(segs[hop + 1]!, 0.5);
    expect(segs[hop + 1]!.step.kind).toBe('travel');
    expect(wrap.ethH).toEqual(travel.ethH);
    expect(wrap.ip).toEqual(travel.ip);
    expect(wrap.ethH).not.toEqual(detailsAt(segs[hop - 1]!, 0.5).ethH);
  });

  it('a VPN reply shows the translated packet from the VPN server on', () => {
    const s = buildStory(runScenario(fetchWebPage({ vpn: true }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
    const t = buildTimeline(s);
    const reply = t.segs.filter((x) => x.trip.card === '200 OK');
    const nat = reply.find((x) => x.step.kind === 'nat' && x.step.which === 'to' && x.step.after === '10.8.0.2')!;
    const before = detailsAt(nat, 0.1);
    const after = detailsAt(nat, 0.9);
    expect(value(before.ip, 'Destination IP')).toBe('198.51.100.10');
    expect(value(after.ip, 'Destination IP')).toBe('10.8.0.2');
    // The VPN server is a hop on the way back too.
    expect(Number(value(after.ip, 'Time to Live'))).toBe(Number(value(before.ip, 'Time to Live')) - 1);
    expect(value(after.l4, 'Destination port')).not.toBe(value(before.l4, 'Destination port'));
    const opened = reply.find((x) => x.step.kind === 'unwrap' && x.step.layer === 'vpn' && x.trip.steps.indexOf(x.step as Trip['steps'][number]) > x.trip.steps.indexOf(nat.step as Trip['steps'][number]))!;
    expect(value(detailsAt(opened, 0.5).ip, 'Destination IP')).toBe('10.8.0.2');
    expect(detailsAt(opened, 0.5).vpn).toBeUndefined();
  });
});

describe('what a snoop on a line can read', () => {
  const seenOnWan = (s: ReturnType<typeof run>, card: string) => {
    const t = s.trips.find((x) => x.card === card)!;
    const step = t.steps.find((x) => x.kind === 'travel' && x.link === 'wan');
    return step?.kind === 'travel' ? step.seen! : null;
  };

  it('reads plain HTTP and DNS, with the addresses as they are on that line', () => {
    const get = seenOnWan(story, 'GET /')!;
    expect(get).toMatchObject({ from: '203.0.113.7', to: '104.20.23.154', kind: 'open' });
    expect(get.lines).toEqual(['GET / HTTP/1.1', 'Host: example.com']);
    expect(seenOnWan(story, '200 OK')!.lines[0]).toBe('HTTP/1.1 200 OK');
    expect(seenOnWan(story, 'example.com?')).toMatchObject({ kind: 'open', lines: ['example.com?'] });
  });

  it('with HTTPS it reads only scrambled bytes, except the site name in the hello', () => {
    const s = buildStory(runScenario(fetchWebPage({ https: true }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
    const hello = s.trips.find((t) => t.card === 'hello 1/2')!;
    const step = hello.steps.find((x) => x.kind === 'travel' && x.link === 'wan');
    expect(step?.kind === 'travel' && step.seen).toMatchObject({ kind: 'name', lines: [expect.stringMatching(/^example\.com$/), expect.any(String)] });
    const get = seenOnWan(s, 'GET /')!;
    expect(get.kind).toBe('scrambled');
    expect(get.lines.join()).not.toMatch(/GET|example/);
  });
});

describe('a cut cable in the story', () => {
  const s = buildStory(runScenario(fetchWebPage(), { seed: 1, faults: { randomLoss: 0, manual: [], cuts: [{ link: 'bb2', from: 0 }] }, maxTime: 1000 }));
  const tl = buildTimeline(s);

  it('shows each resend falling into the cut, longer rings for longer waits, and giving up at the end', () => {
    const lost = s.trips.filter((t) => t.lost);
    expect(lost).toHaveLength(7);
    expect(lost.every((t) => t.steps.some((x) => x.kind === 'lost'))).toBe(true);
    const waits = tl.segs.flatMap((x) => (x.step.kind === 'wait' ? [{ step: x.step, d: x.t1 - x.t0 }] : []));
    expect(waits.map((w) => w.step.mood)).toEqual(['surprise', 'angry', 'angry', 'angry', 'angry', 'angry', 'cry']);
    expect(waits.map((w) => Math.round(w.step.seconds)).slice(0, 6)).toEqual([1, 2, 4, 8, 16, 32]);
    expect(waits[5]!.d).toBeGreaterThan(waits[0]!.d);
    expect(s.pageTitle).toBeNull();
  });

  it('goes by faster as the resends pile up', () => {
    const lost = tl.segs.filter((x) => x.step.kind === 'lost');
    const trip = (i: number) => tl.segs.filter((x) => x.trip === lost[i]!.trip && x.step.kind !== 'wait').reduce((d, x) => d + x.t1 - x.t0, 0);
    expect(trip(6)).toBeLessThan(trip(1));
  });
});

describe('a packet lost on the way', () => {
  const waitsOf = (s: ReturnType<typeof run>) => buildTimeline(s).segs.flatMap((x) => (x.step.kind === 'wait' ? [x.step] : []));
  const cern = (manual: ManualFault[]) => buildStory(runScenario(fetchWebPage({ site: 'info.cern.ch' }), { seed: 1, faults: { randomLoss: 0, manual } }));

  it('a lost ACK needs no timer and no tears: the page still comes', () => {
    const ack = get(null, 'ACK');
    const s = run([{ packetId: ack.packetId, linkId: 'wan' }]);
    expect(waitsOf(s)).toEqual([]);
    expect(s.pageTitle).toBe('Example Domain');
  });

  it('with more of the reply to send, the sender goes on, then its timer runs out and it resends', () => {
    const first = cern([]).trips.find((t) => t.part?.n === 1)!;
    const s = cern([{ packetId: first.packetId, linkId: 'bb2' }]);
    const shown = s.trips.filter((t) => t.part).map((t) => [t.part!.n, t.lost, !!t.retry]);
    expect(shown).toEqual([[1, true, false], [2, false, false], [1, false, true]]);
    expect(waitsOf(s)).toMatchObject([{ device: 'server', seconds: 1, giveUp: false, mood: 'surprise' }]);
    // The ring runs just before the resend, not right after the fall.
    const tl = buildTimeline(s);
    const i = tl.segs.findIndex((x) => x.step.kind === 'wait');
    expect(tl.segs[i]!.trip.retry).toBe(true);
  });

  it('the rings show the real timers, and no timer that was never there', () => {
    const sa = get(null, 'SYN-ACK');
    const s = run([{ packetId: sa.packetId, linkId: 'wan' }]);
    const shown = waitsOf(s);
    expect(shown.length).toBeGreaterThan(0);
    for (const w of shown) expect(w.seconds).toBeGreaterThanOrEqual(1);
    expect(shown.filter((w) => w.device === 'server').length).toBeLessThanOrEqual(1);
  });

  it('only cries when nobody tries again', () => {
    const q = story.trips[0]!;
    const once = run([{ packetId: q.packetId, linkId: 'lan' }]);
    expect(waitsOf(once)).toMatchObject([{ device: 'laptop', seconds: 5, giveUp: false }]);
    const dead = buildStory(runScenario(fetchWebPage(), { seed: 1, faults: { randomLoss: 0, manual: [], cuts: [{ link: 'bb1', from: 0 }] }, maxTime: 1000 }));
    expect(waitsOf(dead).at(-1)).toMatchObject({ device: 'laptop', giveUp: true, mood: 'cry' });
  });
});

describe('what the flow shows now', () => {
  it('ACKs run as small blocks, in the chapter they belong to', () => {
    const acks = story.trips.filter((t) => t.steps[0]?.kind === 'flow');
    expect(acks.map((t) => [t.chapter, t.outward])).toEqual([['page', false], ['page', true]]);
  });

  it('a NAT says which port it swapped as well', () => {
    const nat = get('GET /').steps.find((x) => x.kind === 'nat')!;
    expect(nat).toMatchObject({ device: 'home', which: 'from' });
    if (nat.kind !== 'nat') throw new Error('no nat');
    expect(nat.beforePort).toBeGreaterThan(1023);
    expect(nat.afterPort).toBeGreaterThan(1023);
    expect(nat.afterPort).not.toBe(nat.beforePort);
  });

  it('the real clock runs with the sim: it ends with the fetch, and never goes back', () => {
    const r = runScenario(fetchWebPage(), { seed: 1, faults: { randomLoss: 0, manual: [] } });
    const tl = buildTimeline(buildStory(r));
    const done = r.events.find((e) => e.type === 'app' && e.action === 'done')!;
    expect(realAt(tl, tl.total)).toBeGreaterThanOrEqual(done.t);
    expect(realAt(tl, tl.total)).toBeLessThan(done.t + 0.02);
    let before = 0;
    for (let v = 0; v < tl.total; v += 0.5) {
      expect(realAt(tl, v)).toBeGreaterThanOrEqual(before);
      before = realAt(tl, v);
    }
    expect(formatWait(0.035)).toBe('35 ms');
    expect(formatWait(1.703)).toBe('1.7 s');
  });

  it('the satellite costs as much on the clock as it really does', () => {
    const at = (slow: boolean) => {
      const tl = buildTimeline(buildStory(runScenario(fetchWebPage({ slow }), { seed: 1, faults: { randomLoss: 0, manual: [] } })));
      return realAt(tl, tl.total);
    };
    expect(at(true)).toBeGreaterThan(20 * at(false));
  });

  it('HTTPS: the hellos carry a share of the key, and the certificate proves the name', () => {
    const s = buildStory(runScenario(fetchWebPage({ https: true }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
    const shares = s.trips.filter((t) => t.keyShare);
    expect(shares.map((t) => t.outward)).toEqual([true, false]);
    expect(shares.every((t) => !t.locked)).toBe(true);
    const tl = buildTimeline(s);
    expect([...tl.halves.keys()].sort()).toEqual(['laptop', 'server']);
    for (const [device, t] of tl.halves) expect(tl.keys.get(device)!).toBeGreaterThan(t);
    expect(tl.reactions.filter((r) => r.stamp).map((r) => [r.device, r.stamp])).toEqual([['laptop', 'example.com']]);
    // Before the key could be worked out, the laptop had no way to read the proof.
    expect(tl.reactions.find((r) => r.stamp)!.t).toBeGreaterThan(tl.keys.get('laptop')!);
  });

  it('the spyglass tells a photo from something scrambled', () => {
    const r = runScenario(fetchWebPage({ site: 'httpbin.org' }), { seed: 1, faults: { randomLoss: 0, manual: [] } });
    const tl = buildTimeline(buildStory(r));
    const reads = spyLog(tl, 'wan', tl.total);
    expect(reads.some((x) => x.lines[0] === 'photo data, not scrambled' && x.kind === 'open')).toBe(true);
    expect(reads.some((x) => x.lines[0]?.startsWith('HTTP/1.1 200'))).toBe(true);
  });

  it('under HTTPS it reads the server hello too, but nothing after it', () => {
    const tl = buildTimeline(buildStory(runScenario(fetchWebPage({ https: true }), { seed: 1, faults: { randomLoss: 0, manual: [] } })));
    expect(spyLog(tl, 'wan', tl.total).some((x) => x.lines[0] === 'server hello')).toBe(true);
  });
});

describe('a VPN in the story', () => {
  const s = buildStory(runScenario(fetchWebPage({ vpn: true }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
  const get = s.trips.find((t) => t.card === 'GET /')!;
  const res = s.trips.find((t) => t.card === '200 OK')!;
  const kinds = (t: Trip): string[] => t.steps.map((x) => (x.kind === 'wrap' || x.kind === 'unwrap' ? `${x.kind}:${x.layer}` : x.kind === 'travel' ? `${x.from}>${x.to}` : x.kind));

  it('seals at the laptop, opens at the VPN server, and goes on from there', () => {
    expect(kinds(get)).toEqual([
      'appear', 'wrap:l4', 'wrap:ip', 'wrap:vpn', 'wrap:eth', 'laptop>home',
      'unwrap:eth', 'nat', 'wrap:eth', 'home>isp',
      'unwrap:eth', 'wrap:eth', 'isp>vpn',
      'unwrap:eth', 'unwrap:vpn', 'nat', 'wrap:eth', 'vpn>server',
      'unwrap:eth', 'unwrap:ip', 'unwrap:l4', 'read',
    ]);
    expect(get.tunnel).toBe(60); // outer IP 20, UDP 8, WireGuard 16, tag 16
  });

  it('the reply is sealed at the VPN server and opened at the laptop', () => {
    const k = kinds(res);
    expect(k.indexOf('wrap:vpn')).toBeGreaterThan(k.indexOf('server>vpn'));
    expect(k.indexOf('unwrap:vpn')).toBeGreaterThan(k.indexOf('home>laptop'));
    expect(k[0]).toBe('lookup');
    expect(k[1]).toBe('appear');
    expect(res.steps.filter((x) => x.kind === 'nat').map((x) => x.kind === 'nat' && x.device)).toEqual(['vpn', 'home']);
  });

  it('never spins a packet round on a cable: at most a quarter turn, and none between the VPN server and the resolver', () => {
    const off = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    const tl = buildTimeline(s);
    for (const seg of tl.segs) {
      if (seg.step.kind !== 'travel') continue;
      const most = Math.max(...Array.from({ length: 41 }, (_, i) => off(packetPose(tl, seg, i / 40).angle, trayAngle(seg.trip))));
      expect(most).toBeLessThan(seg.step.link === 'bb5' ? 1e-9 : Math.PI / 2 + 1e-9);
    }
  });

  it('the address tag follows: inside, then the tunnel, then the VPN server sending it on', () => {
    const tl = buildTimeline(s);
    const on = (link: string) => addressBefore(tl.segs.find((x) => x.trip === get && x.step.kind === 'travel' && x.step.link === link)!);
    expect(on('lan')).toEqual({ from: '192.168.1.23', to: '198.51.100.10' });
    expect(on('wan')).toEqual({ from: '203.0.113.7', to: '198.51.100.10' });
    expect(on('bb4')).toEqual({ from: '198.51.100.10', to: '104.20.23.154' });
  });

  it('a snoop on the home line or at the ISP sees only scrambled bytes to the VPN; past it, the plain request', () => {
    const seen = (link: string) => {
      const x = get.steps.find((y) => y.kind === 'travel' && y.link === link);
      return x?.kind === 'travel' ? x.seen! : null;
    };
    expect(seen('wan')).toMatchObject({ kind: 'scrambled', to: '198.51.100.10' });
    expect(seen('wan')!.lines.join()).not.toMatch(/GET|example/);
    expect(seen('bb3')).toMatchObject({ kind: 'scrambled', to: '198.51.100.10' });
    expect(seen('bb4')).toMatchObject({ kind: 'open', from: '198.51.100.10', lines: ['GET / HTTP/1.1', 'Host: example.com'] });
    const dns = s.trips[0]!.steps.find((y) => y.kind === 'travel' && y.link === 'wan');
    expect(dns?.kind === 'travel' && dns.seen?.kind).toBe('scrambled');
  });
});

describe('getting an address first (DHCP)', () => {
  const dhcp = (manual: ManualFault[] = []) => buildStory(runScenario(fetchWebPage({ dhcp: true }), { seed: 1, faults: { randomLoss: 0, manual } }));
  const s = dhcp();

  it('opens with an "address" chapter of four DHCP cards, then the story as before', () => {
    expect(s.trips.slice(0, 6).map((t) => [t.chapter, t.card ?? t.l4Label])).toEqual([
      ['address', 'DISCOVER'],
      ['address', 'OFFER 192.168.1.23'],
      ['address', 'REQUEST 192.168.1.23'],
      ['address', 'ACK 192.168.1.23'],
      ['dns', 'example.com?'],
      ['dns', '104.20.23.154'],
    ]);
    const tl = buildTimeline(s);
    expect([...new Set(tl.segs.map((x) => chapterAt(tl, x.t0)))]).toEqual(['address', 'dns', 'hello', 'page']);
    expect(s.dnsAnswer).toBe('104.20.23.154');
    expect(s.remembered).toBeNull();
    expect(s.pageTitle).toBe('Example Domain');
    expect(s.names['192.168.1.23']).toBe('Laptop');
  });

  it('a DHCP card is UDP, from nowhere to everyone, and a snoop reads it in plain text', () => {
    const d = s.trips[0]!;
    expect(d).toMatchObject({ l4: 'udp', l4Label: 'UDP', from: '0.0.0.0', to: '255.255.255.255', outward: true, origin: 'laptop' });
    expect(d.steps.map((x) => x.kind).slice(0, 5)).toEqual(['appear', 'wrap', 'wrap', 'wrap', 'travel']);
    const travel = d.steps.find((x) => x.kind === 'travel');
    expect(travel?.kind === 'travel' && travel.seen).toMatchObject({ kind: 'open', lines: ['DISCOVER'], from: '0.0.0.0', to: '255.255.255.255' });
    const offer = s.trips[1]!;
    expect(offer).toMatchObject({ origin: 'home', outward: false, from: '192.168.1.1', to: '192.168.1.23' });
    expect(offer.steps.at(-1)).toMatchObject({ kind: 'read', device: 'laptop' });
    expect(dhcpCardLabel('DHCP DISCOVER · xid 0x1a2b3c4d')).toBe('DISCOVER');
    expect(dhcpCardLabel('DHCP ACK 192.168.1.23 · xid 0x1a2b3c4d')).toBe('ACK 192.168.1.23');
  });

  it('a lost OFFER: the laptop waits 4 s at its timer and asks again', () => {
    const k = dhcp([{ packetId: s.trips[1]!.packetId, linkId: 'lan' }]);
    expect(k.trips[1]).toMatchObject({ card: 'OFFER 192.168.1.23', lost: true });
    expect(k.trips[2]).toMatchObject({ card: 'DISCOVER', retry: true, timedOut: true, waited: 4, origin: 'laptop' });
    expect(k.trips[3]).toMatchObject({ card: 'OFFER 192.168.1.23', lost: false, retry: false });
    expect(k.trips[4]).toMatchObject({ card: 'REQUEST 192.168.1.23', retry: false, timedOut: false });
    const waits = buildTimeline(k).segs.flatMap((x) => (x.step.kind === 'wait' ? [x.step] : []));
    expect(waits).toMatchObject([{ device: 'laptop', seconds: 4, giveUp: false, mood: 'surprise' }]);
    expect(k.pageTitle).toBe('Example Domain');
  });
});

describe('naming addresses', () => {
  it('knows who each address belongs to, inside the tunnel too', () => {
    const s = buildStory(runScenario(fetchWebPage({ vpn: true }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
    expect(s.names['198.51.100.10']).toBe('VPN server');
    expect(s.names['10.8.0.2']).toBe('Laptop');
    expect(s.names['203.0.113.7']).toBe('Home router');
    expect(s.names['104.20.23.154']).toBe('Web server');
  });
});

describe('an address changing', () => {
  it('swells, flips, lands and settles back to normal', () => {
    expect(swapMoment(0, 0.44).grow).toBeCloseTo(0);
    expect(swapMoment(0.6, 0.44).grow).toBeGreaterThan(0.9);
    expect(swapMoment(1, 0.44).grow).toBeCloseTo(0);
    expect(swapMoment(0.3, 0.44).flip).toBe(0);
    expect(swapMoment(0.6, 0.44).flip).toBe(1);
    expect(swapMoment(1, 0.44).stamp).toBe(1);
  });

  it('lands when it says, so the bang and the box meet', () => {
    const land = 0.64;
    expect(swapMoment(land, land).flip).toBeCloseTo(0.5);
    expect(swapMoment(land, land).stamp).toBe(0);
    expect(swapMoment(0.5, land).flip).toBe(0);
  });

  it('gets a sound at the home router and at the VPN box, and more time the first time', () => {
    const s = buildStory(runScenario(fetchWebPage({ vpn: true }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
    const tl = buildTimeline(s);
    for (const kind of ['nat', 'wrap', 'unwrap']) {
      const seg = tl.segs.find((x) => x.step.kind === kind && swapLanding(x.step) !== null)!;
      const t = seg.t0 + (seg.t1 - seg.t0) * swapLanding(seg.step)!;
      expect(tl.cues.some((c) => c.sound === 'swap' && Math.abs(c.t - t) < 1e-9)).toBe(true);
    }
    const nats = tl.segs.filter((x) => x.step.kind === 'nat');
    expect(nats[0]!.t1 - nats[0]!.t0).toBeCloseTo(2.6);
    expect(nats[nats.length - 1]!.t1 - nats[nats.length - 1]!.t0).toBeGreaterThan(1.3);
  });

  it('only sounds in full the first few times: later the router ticks and the VPN box has its lock', () => {
    const s = buildStory(runScenario(fetchWebPage({ vpn: true, https: true }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
    const tl = buildTimeline(s);
    const swaps = tl.cues.filter((c) => c.sound === 'swap');
    expect(swaps.length).toBe(6);
    const later = tl.segs.filter((x) => x.step.kind === 'nat' && x.t0 > Math.max(...swaps.map((c) => c.t)));
    expect(later.length).toBeGreaterThan(0);
    for (const seg of later) expect(tl.cues.some((c) => c.sound === 'snap' && c.t > seg.t0 && c.t < seg.t1)).toBe(true);
  });
});

describe('ping and traceroute stories', () => {
  const probe = (kind: 'ping' | 'traceroute', vpn = false) => buildStory(runScenario(fetchWebPage({ probe: kind, vpn }), { seed: 1, faults: { randomLoss: 0, manual: [] } }));

  it('ping: after the lookup, "ping 1/4" goes out and "pong 1/4" comes back, each the whole card with no transport piece', () => {
    const s = probe('ping');
    expect(s.site).toBe('example.com');
    // The lookup and every echo after the first run as small blocks: all of them are there, each kind only watched once.
    expect(s.trips.map((t) => [t.chapter, t.steps[0]!.kind === 'flow' ? t.steps[0]!.packets.map((x) => x.card) : t.card])).toEqual([
      ['dns', ['example.com?', '104.20.23.154']],
      ['ping', 'ping 1/4'], ['ping', 'pong 1/4'],
      ['ping', ['ping 2/4', 'pong 2/4', 'ping 3/4', 'pong 3/4', 'ping 4/4', 'pong 4/4']],
    ]);
    const ping = s.trips[1]!;
    expect(ping).toMatchObject({ l4: 'none', l4Label: '', dataBytes: 64, header: { eth: 14, ip: 20, l4: 0 }, from: '192.168.1.23', to: '104.20.23.154', outward: true });
    expect(kinds(ping)).toEqual(['appear', 'wrap:ip', 'wrap:eth', 'travel', 'unwrap:eth', 'nat', 'wrap:eth', 'travel', 'unwrap:eth', 'wrap:eth', 'travel', 'unwrap:eth', 'unwrap:ip', 'read']);
    expect(ping.steps.find((x) => x.kind === 'nat')).toMatchObject({ device: 'home', which: 'from', after: '203.0.113.7' });
    expect(ping.steps[0]!.details?.card?.map((row) => row.name)).toEqual(['Type', 'Identifier', 'Sequence number', 'Data']);
    expect(ping.steps[0]!.details?.l4).toBeUndefined();
    // The reply comes back addressed to the home's public address and is translated at the router, like the page.
    const pong = s.trips[2]!;
    expect(pong).toMatchObject({ outward: false, client: 'laptop', from: '104.20.23.154', to: '203.0.113.7' });
    expect(pong.steps.find((x) => x.kind === 'nat')).toMatchObject({ device: 'home', which: 'to', after: '192.168.1.23' });
    expect(s.probe).toMatchObject({ kind: 'ping', to: 'example.com', hops: [], done: { sent: 4, received: 4, lossPct: 0 } });
    expect(s.probe!.replies.map((x) => x.seq)).toEqual([1, 2, 3, 4]);
    expect(s.probe!.replies[0]!.rttMs).toBeGreaterThan(12);
    expect(s.pageTitle).toBeNull();
  });

  it('traceroute: probes say their TTL, routers answer "TTL ran out", the server "no such port", and the story knows the hops', () => {
    const s = probe('traceroute');
    // The first probe of each TTL and its answer go in full; the others run as small blocks.
    expect(s.trips.filter((t) => t.chapter === 'trace').map((t) => (t.steps[0]!.kind === 'flow' ? t.steps[0]!.packets.length : t.card))).toEqual(['TTL 1', 'TTL ran out', 4, 'TTL 2', 'TTL ran out', 4, 'TTL 3', 'no such port', 4]);
    const trace = s.trips.filter((t) => t.chapter === 'trace').flatMap((t) => (t.steps[0]!.kind === 'flow' ? t.steps[0]!.packets : [t]));
    expect(trace.map((t) => t.card)).toEqual([
      'TTL 1', 'TTL ran out', 'TTL 1', 'TTL ran out', 'TTL 1', 'TTL ran out',
      'TTL 2', 'TTL ran out', 'TTL 2', 'TTL ran out', 'TTL 2', 'TTL ran out',
      'TTL 3', 'no such port', 'TTL 3', 'no such port', 'TTL 3', 'no such port',
    ]);
    expect(trace[0]).toMatchObject({ l4: 'udp', l4Label: 'UDP', probeTtl: 1, dataBytes: 32, header: { eth: 14, ip: 20, l4: 8 } });
    // The first probe gets no further than the home router: its trip ends there, unopened.
    expect(kinds(trace[0]!)).toEqual(['appear', 'wrap:l4', 'wrap:ip', 'wrap:eth', 'travel', 'unwrap:eth']);
    expect(trace[1]).toMatchObject({ l4: 'none', origin: 'home', from: '192.168.1.1', to: '192.168.1.23' });
    expect(trace[1]!.probeTtl).toBeUndefined();
    expect(kinds(trace[1]!)).toEqual(['appear', 'wrap:ip', 'wrap:eth', 'travel', 'unwrap:eth', 'unwrap:ip', 'read']);
    expect(trace[7]).toMatchObject({ origin: 'isp', from: '203.0.113.1' });
    expect(trace[7]!.steps.find((x) => x.kind === 'nat')).toMatchObject({ device: 'home', which: 'to', after: '192.168.1.23' });
    expect(trace[12]!.probeTtl).toBe(2 + 1);
    expect(s.probe!.hops.map((h) => [h.ttl, h.from, h.reached])).toEqual([
      [1, '192.168.1.1', false], [1, '192.168.1.1', false], [1, '192.168.1.1', false],
      [2, '203.0.113.1', false], [2, '203.0.113.1', false], [2, '203.0.113.1', false],
      [3, '104.20.23.154', true], [3, '104.20.23.154', true], [3, '104.20.23.154', true],
    ]);
    expect(probe('traceroute', true).probe!.hops.map((h) => h.from)).toEqual(['198.51.100.10', '198.51.100.10', '198.51.100.10', '104.20.23.154', '104.20.23.154', '104.20.23.154']);
  });
});

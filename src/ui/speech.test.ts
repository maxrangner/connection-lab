import { describe, expect, it } from 'vitest';
import { fetchWebPage, OFFLINE_AT, READING_AT, runScenario, type Cut, type SimResult } from '../sim';
import { buildStory } from './story';
import { buildTimeline, type Timeline } from './timeline';

function run(opts: Parameters<typeof fetchWebPage>[0] = {}, cuts: Cut[] = []): Timeline {
  return buildTimeline(buildStory(runScenario(fetchWebPage(opts), { seed: 1, faults: { randomLoss: 0, manual: [], cuts }, maxTime: 1000 })));
}
const said = (tl: Timeline): string[][] => tl.speech.map((b) => [b.device, b.text]);

describe('what the devices say', () => {
  it('tells a plain fetch from the question to the page', () => {
    expect(said(run())).toEqual([
      ['laptop', 'I want to open example.com'],
      ['laptop', 'First I need its address. Who knows it?'],
      ['home', "Sending this out under our home's address"],
      ['isp', 'Not for me, pass it on'],
      ['resolver', "I'm like a phone book. It's 104.20.23.154"],
      ['home', 'This reply is for the laptop'],
      ['laptop', 'Got the address! Hi, can we talk?'],
      ['server', "Hi! Yes, let's."],
      ['laptop', 'Great!'],
      ['laptop', 'Please send the page'],
      ['server', 'Here it is'],
      ['laptop', 'Got it! Now I can show the page'],
    ]);
  });

  it('speaks in the open, before the packet is gone and with a server speaking only once it has found the answer', () => {
    const tl = run();
    const answer = tl.speech.find((b) => b.text.includes("It's"))!;
    const lookup = tl.segs.find((s) => s.step.kind === 'lookup')!;
    expect(answer.t0).toBe(lookup.t1);
    for (const b of tl.speech) expect(b.t1 - b.t0).toBeGreaterThanOrEqual(0.6);
  });

  it('never has one device saying two things at once', () => {
    for (const opts of [{ https: true }, { vpn: true }, { cold: true }, { dhcp: true }, { joins: [{}] }, { call: true }, { probe: 'ping' as const }, { probe: 'traceroute' as const }]) {
      const tl = run(opts);
      for (const [i, a] of tl.speech.entries()) {
        const next = tl.speech.slice(i + 1).find((b) => b.device === a.device);
        if (next) expect(next.t0).toBeGreaterThanOrEqual(a.t1);
      }
    }
  });

  it('walks the HTTPS handshake in words', () => {
    const lines = said(run({ https: true })).map((x) => x[1]);
    expect(lines).toEqual(expect.arrayContaining(["Let's agree on a secret nobody else can read", 'OK, work it out from this', "Here's my ID", 'It really is me']));
  });

  it('has the resolver sent from server to server', () => {
    const talk = said(run({ cold: true })).filter(([device]) => ['resolver', 'root', 'tld', 'auth'].includes(device!));
    expect(talk).toEqual([
      ['resolver', "I don't have it saved. I'll ask around."],
      ['root', 'Not me. Ask the .com server.'],
      ['resolver', 'Where is example.com?'],
      ['tld', 'Not me. Ask its name server.'],
      ['resolver', 'Where is example.com?'],
      ['auth', "That's mine: 104.20.23.154"],
      ['resolver', "Found it! It's 104.20.23.154"],
    ]);
  });

  it('asks for an address by name when it has none', () => {
    const lines = said(run({ dhcp: true })).map((x) => x[1]);
    expect(lines.slice(1, 5)).toEqual(['Can anyone give me an address?', 'You can have 192.168.1.23', "I'll take it", "It's yours"]);
  });

  it('opens on what the run is for, before anything moves, and ends on having got it', () => {
    const tl = run({ site: 'httpbin.org' });
    const open = tl.speech[0]!;
    expect(open).toMatchObject({ device: 'laptop', t0: 0, text: 'I want to get a photo' });
    expect(open.t1).toBeGreaterThanOrEqual(tl.segs[0]!.t0);
    expect(tl.speech.at(-1)).toMatchObject({ device: 'laptop', text: 'Got every part! Now I can show the photo' });
    expect(said(run({ call: true })).map((x) => x[1])).toContain('I want to call Sam');
    const ping = said(run({ probe: 'ping' })).map((x) => x[1]);
    expect(ping[0]).toBe('Is example.com there?');
    expect(ping).toContain('It answered every time, in 12 ms!');
    const trace = said(run({ probe: 'traceroute' })).map((x) => x[1]);
    expect(trace[0]).toBe("What's the way to example.com?");
    expect(trace).toContain("That's every stop that answered!");
  });

  it('does not claim a page it never got, and still says how it ended, after trying', () => {
    const tl = run({}, [{ link: 'wan', from: 0.03 }]);
    expect(tl.speech.map((b) => b.text).join()).not.toContain('Now I can show');
    const last = tl.speech.find((b) => b.text === "I couldn't get the page")!;
    expect(last.t0).toBeCloseTo(tl.settled);
    expect(tl.speech.filter((b) => b.device === 'laptop' && b.text === 'No answer yet...').length).toBeGreaterThan(0);
  });

  it('ends every run on a last line that stays after the last packet', () => {
    const runs: [Parameters<typeof fetchWebPage>[0], Cut[]?][] = [[{}], [{ https: true }], [{ vpn: true }], [{ call: true }], [{ probe: 'ping' }], [{ probe: 'traceroute' }], [{ site: 'httpbin.org' }], [{ thin: true }], [{ slow: true }], [{ from: 'phone', noise: 0.5 }], [{ reading: true, smart: true }], [{ attacks: ['flood'] }], [{ attacks: ['scan'] }], [{ attacks: ['listen'] }], [{ joins: [{ job: 'call', at: 0.01 }] }], [{}, [{ link: 'wan', from: 0 }]], [{ probe: 'ping' }, [{ link: 'bb2', from: 0 }]]];
    for (const [opts, cuts] of runs) {
      const tl = run(opts, cuts);
      expect(tl.total - tl.settled, JSON.stringify(opts)).toBeGreaterThanOrEqual(2.5);
      expect(tl.speech.some((b) => b.t0 <= tl.settled + 0.01 && b.t1 >= tl.total - 0.01), JSON.stringify(opts)).toBe(true);
    }
  });

  describe('says what makes each option what it is', () => {
    const lines = (opts: Parameters<typeof fetchWebPage>[0], cuts: Cut[] = []): string[] => said(run(opts, cuts)).map((x) => x.join(': '));

    it('a VPN: locked at the laptop, opaque on the way, opened far away, and a server that sees the VPN', () => {
      expect(lines({ vpn: true })).toEqual(expect.arrayContaining([
        'laptop: I want to open example.com through my VPN',
        'laptop: Locked! Only the VPN server can open this',
        "isp: It's locked. I can only pass it on",
        "vpn: Unlocking this. I'll send it on for you",
        'vpn: Locking the reply for your laptop',
        'server: This came from the VPN server',
      ]));
      expect(lines({ vpn: true, probe: 'traceroute' }).at(-1)).toBe('laptop: The tunnel hid the stops in between');
    });

    it('HTTPS: why, and from when', () => {
      expect(lines({ https: true })).toEqual(expect.arrayContaining(["laptop: Let's agree on a secret nobody else can read", 'laptop: Locked now: please send the page']));
    });

    it('a remembered address, a big page, a call', () => {
      expect(lines({ revisit: true, knownIp: '104.20.23.154' })).toContain('laptop: I remember the address! Hi, can we talk?');
      const big = lines({ site: 'info.cern.ch' });
      expect(big).toContain("server: Too big for one packet: here's part 1");
      expect(big.at(-1)).toBe('laptop: Got every part! Now I can show the page');
      const call = lines({ call: true });
      expect(call).toContain('laptop: Tiny packets: no time to resend any');
      expect(call.at(-1)).toBe('laptop: Every sound got through. Bye!');
    });

    it('a slow way out: space, a long cable, a slow line, a full queue', () => {
      const space = lines({ slow: true });
      expect(space).toContain("home: Under our home's address, up to space it goes");
      expect(space.at(-1)).toBe('laptop: Got it! Slow, because it went via space');
      expect(lines({ wanDelay: 0.03 }).at(-1)).toBe('laptop: Got it! The long cable made it slower');
      expect(lines({ thin: true }).at(-1)).toBe('laptop: Got it! This page fit down the slow line');
      const queue = lines({ thin: true, site: 'httpbin.org' });
      expect(queue).toContain('isp: My queue is full! That one is lost');
      expect(queue.at(-1)).toBe('laptop: Got it, once the lost part came again');
    });

    it('noisy Wi-Fi, a cut cable, and two devices at once', () => {
      const noise = lines({ from: 'phone', noise: 0.5 });
      expect(noise.join()).toContain('Noisy air! Trying that again');
      expect(noise.at(-1)).toBe('phone: Got it! Noisy air, but it got through');
      expect(lines({ attacks: ['flood'] })).toContain('laptop: Still nothing. Waiting longer this time');
      expect(lines({ joins: [{ job: 'photo', at: 0.01 }] })).toContain('home: Two devices, one address: ports sort them out');
    });

    it('a ping or trace that got nowhere', () => {
      expect(lines({ probe: 'ping' }, [{ link: 'bb2', from: 0 }]).at(-1)).toBe('laptop: It never answered');
      const trace = lines({ probe: 'traceroute' }, [{ link: 'bb2', from: 0 }]);
      expect(trace.at(-1)).toBe("laptop: I couldn't get all the way there");
      expect(trace.join()).not.toContain('I give up');
    });

    it('a reading: what QoS was asked for, who was told, and an app that is away', () => {
      const away = (qos: 0 | 1): string[] => lines({ reading: true, smart: true, cloud: true, qos }, [{ link: 'wlan', from: OFFLINE_AT }]);
      expect(lines({ reading: true, smart: true, qos: 0 })[0]).toMatch(/^sensor: It's .* °C\. Sent once, no receipt$/);
      expect(lines({ reading: true, smart: true, qos: 1 })[0]).toMatch(/Send me a receipt$/);
      expect(lines({ reading: true, smart: true, qos: 2 })[0]).toMatch(/Exactly once, please$/);
      expect(lines({ reading: true, smart: true }).at(-1)).toBe('laptop: I never asked. The broker just told me');
      expect(away(0)).toContain('broker: The phone is away. It misses this one');
      expect(away(1)).toContain("broker: The phone is away. I'll keep this for it");
    });
  });

  describe('only claims what happened', () => {
    const sim = (opts: Parameters<typeof fetchWebPage>[0], cuts: Cut[] = []): SimResult => runScenario(fetchWebPage(opts), { seed: 1, faults: { randomLoss: 0, manual: [], cuts }, maxTime: 1000 });
    const lines = (opts: Parameters<typeof fetchWebPage>[0], cuts: Cut[] = []): string[] => said(buildTimeline(buildStory(sim(opts, cuts)))).map((x) => x.join(': '));
    const pageIn = (opts: Parameters<typeof fetchWebPage>[0] = {}): number => sim(opts).events.find((e) => e.type === 'app' && e.action === 'http-response-received')!.t;

    it('a lost part of the page, and not whatever else was lost around it', () => {
      const plain = 'laptop: Got it! Now I can show the page';
      expect(lines({}, [{ link: 'wan', from: pageIn() + 1e-4 }])).toContain(plain);
      expect(lines({}, [{ link: 'wan', from: 0, to: 1 }])).toContain(plain);
    });

    it('a call that never was, and sound lost either way', () => {
      expect(lines({ call: true }, [{ link: 'wan', from: 0 }]).at(-1)).toBe("laptop: I couldn't reach Sam");
      const first = [...sim({ call: true }).packets.values()].find((p) => p.rtp)!.createdAt;
      expect(lines({ call: true }, [{ link: 'wan', from: first - 1e-4, to: first + 0.1 }]).at(-1)).toBe('laptop: Lost sound stays lost. Bye!');
    });

    it('the QoS that was asked for, even if the reading got nowhere', () => {
      const cut = [{ link: 'wan', from: READING_AT }];
      expect(lines({ reading: true, smart: true, cloud: true, qos: 2 }, cut)[0]).toMatch(/Exactly once, please$/);
      expect(lines({ reading: true, smart: true, cloud: true, qos: 1 }, cut)[0]).toMatch(/Send me a receipt$/);
    });

    it('a device that joined in is not told what the first job did', () => {
      const vpn = lines({ vpn: true, joins: [{ job: 'page', at: 0.01 }] }).filter((l) => l.startsWith('server: '));
      expect(vpn.filter((l) => l === 'server: This came from the VPN server')).toHaveLength(1);
      expect(vpn).toContain("server: Hi! Yes, let's.");
      expect(lines({ noise: 0.5, joins: [{ job: 'page', at: 0.01 }] })).toContain('laptop: Got it! Now I can show the page');
      expect(lines({ joins: [{ job: 'photo', at: 0.01 }] })).toContain('laptop: Got it! Now I can show the page');
    });

    it('what the broker knows: both apps gone, or a reading it never got', () => {
      const both = [{ link: 'lan', from: OFFLINE_AT }, { link: 'wlan', from: OFFLINE_AT }];
      expect(lines({ reading: true, smart: true, qos: 1 }, both)).toContain("local-broker: The laptop and phone are away. I'll keep this for them");
      expect(lines({ reading: true, smart: true, qos: 0 }, both)).toContain('local-broker: The laptop and phone are away. They miss this one');
      const never = lines({ reading: true, smart: true, cloud: true, qos: 1 }, [{ link: 'wan', from: READING_AT }]);
      expect(never.join()).not.toContain('away');
      expect(never.at(-1)).toBe('sensor: Nobody heard that reading');
    });
  });

  describe('gives each line its time', () => {
    const bubble = (tl: Timeline, text: string) => tl.speech.filter((b) => b.text === text);

    it('a last line said long before the end has its moment, lets the run go on, and is said again to end on', () => {
      const https = run({ https: true });
      const after = https.speech.find((b) => b.text === 'Got it! Now I can show the page')!;
      const r = runScenario(fetchWebPage({ https: true }), { seed: 1, faults: { randomLoss: 0, manual: [] }, maxTime: 1000 });
      const pageIn = r.events.find((e) => e.type === 'app' && e.action === 'http-response-received')!.t;
      for (const tl of [https, run({ https: true }, [{ link: 'wan', from: pageIn + 1e-4 }])]) {
        const [first, again] = bubble(tl, after.text);
        expect(first!.t1 - first!.t0).toBeLessThan(5);
        expect(again!.t0).toBeCloseTo(tl.settled);
        expect(again!.t1).toBeCloseTo(tl.total);
      }
      expect(bubble(https, 'Bye!').filter((b) => b.device === 'laptop')[0]!.t0).toBeGreaterThanOrEqual(after.t1);
      expect(bubble(run(), after.text)).toHaveLength(1);
    });

    it('a VPN waits for the line before it to be read', () => {
      const first = bubble(run({ vpn: true }), 'First I need its address. Who knows it?')[0]!;
      expect(first.t1 - first.t0).toBeGreaterThanOrEqual(3.9);
      const known = bubble(run({ revisit: true, knownIp: '104.20.23.154', vpn: true }), 'I remember the address! Hi, can we talk?')[0]!;
      expect(known.t1 - known.t0).toBeGreaterThanOrEqual(4);
      expect(bubble(run({ vpn: true }), 'Locked! Only the VPN server can open this')).toHaveLength(1);
    });
  });

  describe('an attack', () => {
    const lines = (opts: Parameters<typeof fetchWebPage>[0]): string[] => said(run(opts)).map((x) => x.join(': '));

    it('opens on what each attacker sets out to do, and holds until that can be read', () => {
      const tl = run({ attacks: ['flood', 'scan', 'listen'] });
      expect(tl.segs[0]!.t0).toBeGreaterThan(2);
      expect(tl.speech.filter((b) => b.t0 === 0).map((b) => [b.device, b.text])).toEqual([
        ['laptop', 'I want to open example.com'],
        ['bot1', "Let's flood the web server!"],
        ['scanner', "Let's try all the server's doors"],
        ['stranger', "Let's listen to the Wi-Fi"],
      ]);
    });

    it('says what a flood did to a page that needed that line', () => {
      const flood = lines({ attacks: ['flood'] });
      expect(flood).toEqual(expect.arrayContaining(['server: So much junk! My line is full', "laptop: Where's my page? It's stuck"]));
      expect(flood.at(-1)).toBe('laptop: Got it, now the flood is over');
      const tl = run({ attacks: ['flood'] });
      const junk = tl.segs.flatMap((s) => s.flow ?? []).filter((p) => p.trip.chapter === 'attack');
      expect(tl.speech.at(-1)!.t0).toBeGreaterThan(Math.max(...junk.map((p) => p.t1)));
    });

    it('says so when a flood made no difference', () => {
      expect(lines({ attacks: ['flood'], call: true }).at(-1)).toBe('laptop: That flood never touched my call');
      expect(lines({ attacks: ['flood'], vpn: true }).at(-1)).toBe('laptop: The flood missed me: I went another way');
      expect(lines({ attacks: ['flood'], call: true, joins: [{ job: 'call', at: 0.001 }] }).join()).toContain('never touched my call');
    });

    it('says when a flood stood in the way of a ping', () => {
      expect(lines({ attacks: ['flood'], probe: 'ping' }).at(-1)).toBe('laptop: That flood got in my way');
    });

    it('lets the server say it was tried, and the client that it noticed nothing', () => {
      const scan = lines({ attacks: ['scan'] });
      expect(scan).toEqual(expect.arrayContaining(['server: Someone tried all my doors', "laptop: I didn't notice a thing"]));
      expect(scan.join()).not.toContain('Now I can show');
    });

    it('does not claim a run that was stopped went unnoticed', () => {
      expect(lines({ attacks: ['scan'] }).join()).toContain('notice');
      const cut = said(run({ attacks: ['scan'] }, [{ link: 'wan', from: 0 }])).map((x) => x[1]);
      expect(cut.join()).not.toContain('notice');
    });

    it('lets the stranger say it heard nothing, only if it did', () => {
      expect(lines({ attacks: ['listen'] }).at(-1)).toBe("stranger: I can't hear a thing: that's a cable");
      expect(lines({ attacks: ['listen'], from: 'phone' }).join()).not.toContain("can't hear");
    });
  });

  it('does not stop on a line that is still being said', () => {
    for (const tl of [run(), run({ probe: 'ping' }), run({ call: true })]) {
      expect(tl.total).toBeGreaterThanOrEqual(tl.settled);
      expect(Math.max(...tl.speech.map((b) => b.t1))).toBeLessThanOrEqual(tl.total);
    }
  });

  it('keeps a line up long enough to read it', () => {
    const tl = run();
    expect(tl.speech.filter((b) => b.text.startsWith("I'm like a phone book"))[0]!.t1 - tl.speech.filter((b) => b.text.startsWith("I'm like a phone book"))[0]!.t0).toBeGreaterThanOrEqual(3.5);
  });

  it('asks for the photo when the photo is what is wanted', () => {
    expect(said(run({ site: 'httpbin.org' })).map((x) => x[1])).toContain('Please send the photo');
  });

  it('ping says it once, for the first echo', () => {
    const lines = said(run({ probe: 'ping' })).map((x) => x[1]);
    expect(lines.filter((x) => x === 'Are you there?')).toHaveLength(1);
    expect(lines.filter((x) => x === "Yes, I'm here!")).toHaveLength(1);
  });

  it('traceroute says what each TTL means, once per hop', () => {
    const tl = run({ probe: 'traceroute' });
    expect(said(tl).filter(([, text]) => /hops?, then stop|Stopped here|made it/.test(text!))).toEqual([
      ['laptop', 'Go 1 hop, then stop'],
      ['home', 'Stopped here. This is me.'],
      ['laptop', 'Go 2 hops, then stop'],
      ['isp', 'Stopped here. This is me.'],
      ['laptop', 'Go 3 hops, then stop'],
      ['server', 'You made it to me!'],
    ]);
  });

  it('says when nobody answers', () => {
    const tl = run({}, [{ link: 'bb2', from: 0 }]);
    const lines = said(tl).map((x) => x[1]);
    expect(lines).toContain('No answer yet...');
    expect(lines).toContain('Sending that again');
    expect(lines).toContain('No answer. I give up.');
  });
});

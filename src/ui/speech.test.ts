import { describe, expect, it } from 'vitest';
import { fetchWebPage, runScenario, type Cut } from '../sim';
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
    expect(lines).toEqual(expect.arrayContaining(["Let's agree on a secret", 'OK, work it out from this', "Here's my ID", 'It really is me']));
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
    expect(tl.speech.at(-1)).toMatchObject({ device: 'laptop', text: 'Got it! Now I can show the photo' });
    expect(said(run({ call: true })).map((x) => x[1])).toContain('I want to call Sam');
    const ping = said(run({ probe: 'ping' })).map((x) => x[1]);
    expect(ping[0]).toBe('Is example.com there?');
    expect(ping).toContain('It answered every time!');
    const trace = said(run({ probe: 'traceroute' })).map((x) => x[1]);
    expect(trace[0]).toBe("What's the way to example.com?");
    expect(trace).toContain("That's every stop that answered!");
  });

  it('does not claim a page it never got', () => {
    const lines = said(run({}, [{ link: 'wan', from: 0 }])).map((x) => x[1]);
    expect(lines.join()).not.toContain('Now I can show');
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

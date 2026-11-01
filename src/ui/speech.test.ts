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
      ['laptop', "What's the address of example.com?"],
      ['home', "I'll put my address on it"],
      ['isp', 'Not for me, pass it on'],
      ['resolver', "It's 104.20.23.154"],
      ['home', 'Back to the right device'],
      ['laptop', 'Hi, can we talk?'],
      ['server', "Hi! Yes, let's."],
      ['laptop', 'Great!'],
      ['laptop', 'Please send the page'],
      ['server', 'Here it is'],
    ]);
  });

  it('speaks in the open, before the packet is gone and with a server speaking only once it has found the answer', () => {
    const tl = run();
    const answer = tl.speech.find((b) => b.text.startsWith("It's"))!;
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
    expect(lines).toEqual(expect.arrayContaining(["Let's agree on a secret", "OK, here's my half", "Here's my ID", 'It really is me']));
  });

  it('has the resolver sent from server to server', () => {
    const lines = said(run({ cold: true })).map((x) => x[1]);
    expect(lines).toEqual(expect.arrayContaining(['Not me. Ask .com']));
  });

  it('asks for an address by name when it has none', () => {
    const lines = said(run({ dhcp: true })).map((x) => x[1]);
    expect(lines.slice(0, 4)).toEqual(['Can anyone give me an address?', 'You can have 192.168.1.23', "I'll take it", "It's yours"]);
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

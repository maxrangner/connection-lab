import { describe, expect, it } from 'vitest';
import { fetchWebPage, runScenario, type Cut } from '../sim';
import { screenAt } from './readout';
import { buildStory } from './story';
import { buildTimeline, type Timeline } from './timeline';

/** The cable from the ISP to the web server, which the lookup does not need. */
const TO_SERVER: Cut[] = [{ link: 'bb2', from: 0 }];

function run(probe: 'ping' | 'traceroute', opts: { vpn?: boolean; cuts?: Cut[] } = {}): Timeline {
  const scenario = fetchWebPage({ probe, vpn: !!opts.vpn });
  return buildTimeline(buildStory(runScenario(scenario, { seed: 1, faults: { randomLoss: 0, manual: [], cuts: opts.cuts ?? [] }, maxTime: 1000 })));
}
const end = (tl: Timeline): string[] => screenAt(tl.readout, tl.total)!;

describe('what traceroute prints', () => {
  it('ends on the whole path, each hop with its three round trips', () => {
    const tl = run('traceroute');
    expect(end(tl)).toEqual([
      'traceroute example.com',
      '1  192.168.1.1     <1 <1 <1 ms',
      '2  203.0.113.1      4  4  4 ms',
      '3  104.20.23.154   12 12 12 ms',
      'reached in 3 hops',
    ]);
  });

  it('flags each hop once, on the device that answered, when the answer gets back', () => {
    const tl = run('traceroute');
    expect(tl.readout.flags.map((f) => [f.device, f.text])).toEqual([
      ['home', '1 · 192.168.1.1 · under 1 ms'],
      ['isp', '2 · 203.0.113.1 · 4 ms'],
      ['server', '3 · 104.20.23.154 · 12 ms'],
    ]);
    // The first answer is the end of a whole trip, read at the laptop.
    const first = tl.segs.find((s) => s.trip.card === 'TTL ran out' && s.step.kind === 'read')!;
    expect(tl.readout.flags[0]!.t).toBe(first.t1);
  });

  it('fills in line by line, and says nothing before the first probe goes', () => {
    const tl = run('traceroute');
    const firstProbe = tl.segs.find((s) => s.trip.probeTtl === 1)!;
    expect(screenAt(tl.readout, firstProbe.t0 - 0.01)).toBeNull();
    expect(screenAt(tl.readout, firstProbe.t0)).toEqual(['traceroute example.com']);
    expect(screenAt(tl.readout, tl.readout.flags[1]!.t)).toEqual(['traceroute example.com', '1  192.168.1.1     <1 <1 <1 ms', '2  203.0.113.1      4 ms']);
  });

  it('stars the probes nobody answered and says it never got there', () => {
    const tl = run('traceroute', { cuts: TO_SERVER });
    const lines = end(tl);
    expect(lines[2]).toMatch(/^2 {2}203\.0\.113\.1/);
    expect(lines.at(-2)).toBe('8  no reply');
    expect(lines.at(-1)).toBe('not reached in 8 hops');
    expect(tl.readout.flags).toHaveLength(2);
  });

  it('flags the VPN server, the only router the tunnel lets it see', () => {
    expect(run('traceroute', { vpn: true }).readout.flags.map((f) => f.text.split(' · ')[1])).toEqual(['198.51.100.10', '104.20.23.154']);
  });

  it('says so when the name never turned into an address', () => {
    const tl = run('traceroute', { cuts: [{ link: 'wan', from: 0 }] });
    expect(end(tl)).toEqual(['traceroute example.com', "can't find example.com"]);
  });

  it('takes much less watching than nine probes in full', () => {
    expect(run('traceroute').total).toBeLessThan(64);
  });

  it('thumbs up every router that answers: the same words from someone else are no duplicate', () => {
    const tl = run('traceroute');
    expect(tl.reactions.map((r) => r.face)).not.toContain('confused');
  });
});

describe('what ping prints', () => {
  it('a line for each reply as it comes in, then the sum', () => {
    const tl = run('ping');
    expect(end(tl)).toEqual(['ping example.com', '1  12 ms', '2  12 ms', '3  12 ms', '4  12 ms', '4 sent, 4 replies, average 12 ms']);
    expect(tl.readout.flags).toEqual([]);
  });

  it('is quick: the lookup and the repeats run as small blocks, and every packet is still there', () => {
    const tl = run('ping');
    expect(tl.settled).toBeLessThan(30);
    expect(tl.segs.flatMap((s) => s.flow ?? []).filter((p) => p.trip.chapter === 'ping')).toHaveLength(6);
  });

  it('says so when no reply comes', () => {
    const tl = run('ping', { cuts: TO_SERVER });
    expect(end(tl)).toEqual(['ping example.com', '1  no reply', '2  no reply', '3  no reply', '4  no reply', '4 sent, 0 replies']);
  });
});

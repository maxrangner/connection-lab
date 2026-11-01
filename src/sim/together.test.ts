import { describe, expect, it } from 'vitest';
import type { EventOf, SimEventType } from './events/SimEvent';
import { parseIpv4 } from './proto/ipv4';
import { runScenario, type SimResult } from './run';
import { ADDR, COMPANION_DELAY, fetchWebPage } from './scenarios/fetchWebPage';

const of = <T extends SimEventType>(r: SimResult, type: T): EventOf<T>[] => r.events.filter((e) => e.type === type) as EventOf<T>[];

describe('two devices fetching at once', () => {
  const r = runScenario(fetchWebPage({ joins: [{}] }), { seed: 1, faults: { randomLoss: 0, manual: [] } });

  it('the phone starts a moment after the laptop and both get their page', () => {
    const starts = of(r, 'app').filter((e) => e.action === 'start');
    expect(starts.map((e) => [e.deviceId, e.t])).toEqual([
      ['laptop', 0],
      ['phone', COMPANION_DELAY],
    ]);
    expect(of(r, 'app').filter((e) => e.action === 'done').map((e) => e.deviceId).sort()).toEqual(['laptop', 'phone']);
  });

  it('the two fetches interleave on the way to the ISP', () => {
    const wan = of(r, 'tx').filter((e) => e.linkId === 'wan' && e.fromDevice === 'home');
    const from = wan.map((e) => {
      const pdu = r.pdus.get(e.frameId)!;
      return parseIpv4(pdu.bytes, 14).src;
    });
    // Everything leaves the home router from its one public address...
    expect(new Set(from)).toEqual(new Set([ADDR.homeWan.ip]));
    // ...and the phone's question goes out before the laptop's hello comes back answered.
    const owners = wan.map((e) => r.packets.get(e.packetId)!.origin);
    expect(owners.indexOf('phone')).toBeLessThan(owners.lastIndexOf('laptop'));
  });

  it('the home router keeps the two conversations apart by port', () => {
    const entries = of(r, 'nat:add').map((e) => e.entry);
    const insides = new Set(entries.map((n) => n.inside.ip));
    expect(insides).toEqual(new Set([ADDR.laptop.ip, ADDR.phone.ip]));
    const outsidePorts = entries.map((n) => n.outside.port);
    expect(new Set(outsidePorts).size).toBe(outsidePorts.length);
    expect(entries.every((n) => n.outside.ip === ADDR.homeWan.ip)).toBe(true);
  });

  it('is the same run as without, for the laptop, until the phone speaks', () => {
    const alone = runScenario(fetchWebPage(), { seed: 1, faults: { randomLoss: 0, manual: [] } });
    const before = (x: SimResult) => x.events.filter((e) => e.t < COMPANION_DELAY).map((e) => JSON.stringify(e));
    expect(before(r)).toEqual(before(alone));
  });
});

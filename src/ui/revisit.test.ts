import { describe, expect, it } from 'vitest';
import { fetchWebPage, runScenario } from '../sim';
import { buildStory, type Story } from './story';

const story = (opts: object): Story => buildStory(runScenario(fetchWebPage(opts), { seed: 1, faults: { randomLoss: 0, manual: [] }, maxTime: 1000 }));
const COLD_PHOTO = { site: 'connection-lab.rangner.com', cold: true } as const;

describe('going back to a site', () => {
  it('goes back to the address it remembers, not the one a lookup would give', () => {
    // The one web server answers on the address of every site, so another site's will do for one that moved.
    const moved = story({ site: 'info.cern.ch' }).dnsAnswer!;
    expect(story({}).dnsAnswer).not.toBe(moved);
    const again = story({ revisit: true, knownIp: moved });
    expect(again.remembered).toBe(moved);
    expect(again.fetched).toEqual(['laptop']);
  });

  for (const https of [false, true]) {
    it(`goes back to the address the first visit found${https ? ', with HTTPS' : ''}`, () => {
      const knownIp = story({ ...COLD_PHOTO, https }).dnsAnswer!;
      const again = story({ ...COLD_PHOTO, https, revisit: true, knownIp });
      expect(again.remembered).toBe(knownIp);
      expect(again.dnsAnswer).toBeNull();
      expect(again.fetched).toEqual(['laptop']);
    });
  }

  it('also when the Setup changed in between: the device still has the address it had', () => {
    const cold = story(COLD_PHOTO).dnsAnswer!;
    const plain = story({ site: 'connection-lab.rangner.com' }).dnsAnswer!;
    for (const [setup, knownIp] of [[{ site: 'connection-lab.rangner.com' }, cold], [COLD_PHOTO, plain]] as const) {
      const again = story({ ...setup, revisit: true, knownIp });
      expect(again.remembered).toBe(knownIp);
      expect(again.fetched).toEqual(['laptop']);
    }
  });

  it('another device can still find the site while the first goes back to an older address', () => {
    const knownIp = story({ site: 'connection-lab.rangner.com' }).dnsAnswer!;
    const s = story({ ...COLD_PHOTO, revisit: true, knownIp, joins: [{ job: 'photo', at: 0.02 }] });
    expect(s.remembered).toBe(knownIp);
    expect(s.fetched).toEqual(['laptop', 'phone']);
  });

  it('goes back through a VPN too', () => {
    const knownIp = story(COLD_PHOTO).dnsAnswer!;
    expect(story({ site: 'connection-lab.rangner.com', vpn: true, revisit: true, knownIp }).fetched).toEqual(['laptop']);
  });

  it('with no address to go by it uses the one this run has', () => {
    expect(story({ ...COLD_PHOTO, revisit: true }).fetched).toEqual(['laptop']);
  });

  it('a call remembers the friend, whatever else was remembered', () => {
    expect(story({ call: true, revisit: true, knownIp: '192.0.2.1' }).remembered).toBe('198.51.100.42');
  });
});

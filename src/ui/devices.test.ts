import { describe, expect, it } from 'vitest';
import { fetchWebPage, HOME_DEVICES, runScenario, type HomeDevice, type Join } from '../sim';
import { buildStory, type Story } from './story';
import { buildTimeline, crossings, joinAt, type Timeline } from './timeline';

// Not on the table anywhere: a device only these tests have, to show that one more takes nothing but an entry.
const TABLET: HomeDevice = {
  ...HOME_DEVICES[1]!,
  id: 'tablet',
  label: 'Tablet',
  ip: '192.168.1.50',
  mac: 'f0:5c:77:3e:91:50',
  port: { id: 'home.wlan2', name: 'wlan2', ip: '192.168.1.1', mac: 'a4:91:b1:7d:02:04', wifi: 'ap' },
  link: { ...HOME_DEVICES[1]!.link, id: 'wlan2' },
  actions: ['page', 'ping'],
  color: '#c98a1b',
};
const home = [...HOME_DEVICES, TABLET];
const CLEAN = { randomLoss: 0, manual: [] };
const story = (opts: object): Story => buildStory(runScenario(fetchWebPage({ home, ...opts }), { seed: 1, faults: CLEAN, maxTime: 1000 }));
const shownBy = (tl: Timeline, v: number): string[] =>
  crossings(tl)
    .filter((c) => c.t0 < v)
    .map((c) => `${c.trip.packetId}@${c.link} ${c.t0.toFixed(6)} ${c.t1.toFixed(6)}`);

/** Two actions added on two devices, one after the other, as the buttons would. */
function both(a: Join, b: Join): { first: Timeline; second: Timeline; s: Story; v1: number; v2: number } {
  const alone = buildTimeline(story({}));
  const v1 = alone.total * 0.1;
  const one = { ...a, at: joinAt(alone, v1) };
  const onePart = story({ joins: [one] });
  const first = buildTimeline(onePart, new Map(), 0, new Map([[a.device!, v1]]));
  const v2 = v1 + (first.total - v1) * 0.3;
  const two = { ...b, at: joinAt(first, v2) };
  const s = story({ joins: [one, two] });
  return { first, second: buildTimeline(s, new Map(), 0, new Map([[a.device!, v1], [b.device!, v2]])), s, v1, v2 };
}

describe('your own devices', () => {
  it('the table has them with what each can do, and a device of no one has none', () => {
    const s = story({});
    expect(s.devices.filter((d) => d.actions.length).map((d) => d.id)).toEqual(['laptop', 'phone', 'tablet']);
    expect(s.devices.find((d) => d.id === 'tablet')!.actions).toEqual(['page', 'ping']);
    expect(s.devices.find((d) => d.id === 'home')!.actions).toEqual([]);
  });

  it('one more device can open the page', () => {
    const s = story({ from: 'tablet' });
    expect(s.client).toBe('tablet');
    expect(s.fetched).toEqual(['tablet']);
  });

  it('gets its address by DHCP like the others', () => {
    expect(story({ from: 'tablet', dhcp: true }).names['192.168.1.50']).toBe('Tablet');
  });

  it('added actions go to whoever has nothing to do, in order', () => {
    expect(story({ joins: [{}, {}] }).joiners).toEqual(['phone', 'tablet']);
    expect(story({ from: 'phone', joins: [{}, {}] }).joiners).toEqual(['laptop', 'tablet']);
    expect(story({ joins: [{ device: 'tablet' }, {}] }).joiners).toEqual(['tablet', 'phone']);
  });

  it('every job runs on its own, and a tool prints beside the device that ran it', () => {
    const { s, second } = both({ device: 'phone', job: 'page' }, { device: 'tablet', job: 'ping' });
    expect(s.clients).toEqual(['laptop', 'phone', 'tablet']);
    expect(s.fetched).toEqual(['laptop', 'phone']);
    expect(s.joinProbes.map((x) => x.device)).toEqual(['tablet']);
    expect(second.joinReadouts.map((x) => x.device)).toEqual(['tablet']);
    expect(second.joinReadouts[0]!.readout.screens.at(-1)!.lines.at(-1)).toMatch(/4 sent, 4 replies/);
    expect(s.trips.some((t) => t.client === 'tablet')).toBe(true);
  });

  it('a third action changes nothing that was on screen when it came', () => {
    const { first, second, v2 } = both({ device: 'phone', job: 'page' }, { device: 'tablet', job: 'page' });
    expect(shownBy(second, v2)).toEqual(shownBy(first, v2));
  });

  it('each has a colour of its own, whoever goes first', () => {
    for (const from of ['laptop', 'phone']) {
      const colors = story({ from }).devices.flatMap((d) => (d.color ? [d.color] : []));
      expect(new Set(colors).size).toBe(3);
    }
  });

  it('asking for a job no device can take says so', () => {
    expect(() => fetchWebPage({ joins: [{}, {}] })).toThrow();
    expect(() => fetchWebPage({ joins: [{ device: 'laptop' }] })).toThrow();
    expect(() => fetchWebPage({ joins: [{ device: 'nobody' }] })).toThrow();
    expect(() => fetchWebPage({ home, joins: [{ device: 'phone' }, { device: 'phone' }] })).toThrow();
  });

  it('nothing of an added action goes before it was added', () => {
    const { second, v2 } = both({ device: 'phone', job: 'page' }, { device: 'tablet', job: 'page' });
    const ofTablet = crossings(second).filter((c) => c.trip.client === 'tablet');
    expect(ofTablet.length).toBeGreaterThan(0);
    expect(Math.min(...ofTablet.map((c) => c.t0))).toBeGreaterThanOrEqual(v2);
  });
});

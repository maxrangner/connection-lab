import { describe, expect, it } from 'vitest';
import { fetchWebPage, runScenario, type FaultPlan } from '../sim';
import { buildStory } from './story';
import { buildTimeline } from './timeline';

const CLEAN: FaultPlan = { randomLoss: 0, manual: [] };
const story = buildStory(runScenario(fetchWebPage({ join: {} }), { seed: 1, faults: CLEAN }));

describe('two devices fetching at once, in the story', () => {
  it('knows both clients and whose fetch each trip is', () => {
    expect(story.client).toBe('laptop');
    expect(story.clients).toEqual(['laptop', 'phone']);
    for (const t of story.trips) {
      expect(['laptop', 'phone']).toContain(t.client);
      if (t.outward) expect(t.client).toBe(t.origin);
    }
    // A reply belongs to whoever asked: the phone's answer comes back to the phone.
    const phoneReplies = story.trips.filter((t) => t.client === 'phone' && !t.outward && t.card);
    expect(phoneReplies.length).toBeGreaterThan(0);
    for (const t of phoneReplies) expect(t.steps.some((s) => 'device' in s && s.device === 'phone')).toBe(true);
    expect(phoneReplies.some((s) => s.steps.some((x) => 'device' in x && x.device === 'laptop'))).toBe(false);
  });

  it('tells each fetch with its own hello, and the laptop keeps its own page', () => {
    expect(story.trips.filter((t) => t.hello).map((t) => t.client).sort()).toEqual(['laptop', 'phone']);
    expect(story.pageTitle).toBe('Example Domain');
    expect(story.dnsAnswer).toBe('104.20.23.154');
  });

  it('the web server takes the page off its shelf once per fetch', () => {
    const lookups = story.trips.flatMap((t) => t.steps.filter((s) => s.kind === 'lookup' && s.what === 'web').map(() => t.client));
    expect(lookups.sort()).toEqual(['laptop', 'phone']);
  });

  it('the photo streams for the laptop while the phone gets the plain page', () => {
    const s = buildStory(runScenario(fetchWebPage({ join: {}, site: 'httpbin.org' }), { seed: 1, faults: CLEAN, maxTime: 1000 }));
    const streams = s.trips.filter((t) => t.steps.some((x) => x.kind === 'flow' && x.packets.length > 1));
    expect(streams).toHaveLength(1);
    expect(streams[0]!.client).toBe('laptop');
    const flow = streams[0]!.steps.find((x) => x.kind === 'flow')!;
    expect(flow.kind === 'flow' && flow.packets.every((p) => p.client === 'laptop')).toBe(true);
    expect(s.trips.some((t) => t.client === 'phone' && t.card === '200 OK')).toBe(true);
    expect(s.pageTitle).toBe('photo');
    const tl = buildTimeline(s);
    expect(tl.total).toBeGreaterThan(0);
  });

  it('a lost answer for the phone makes the phone wait, not the laptop', () => {
    const plain = runScenario(fetchWebPage({ join: {} }), { seed: 1, faults: CLEAN });
    const answer = [...plain.packets.values()].find((p) => p.kind === 'dns' && p.origin === 'resolver' && p.label.includes('example.com') && plain.events.some((e) => e.type === 'tx' && e.packetId === p.id && e.linkId === 'wan' && e.toDevice === 'home' && e.t > 0.004))!;
    const faulty = buildStory(runScenario(fetchWebPage({ join: {} }), { seed: 1, faults: { randomLoss: 0, manual: [{ packetId: answer.id, linkId: 'wan' }] } }));
    const lost = faulty.trips.find((t) => t.lost)!;
    expect(lost.client).toBe(buildStory(plain).trips.find((t) => t.packetId === answer.id)!.client);
  });
});

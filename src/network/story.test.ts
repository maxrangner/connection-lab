import { describe, expect, it } from 'vitest';
import { fetchWebPage, runScenario } from '../sim';
import { buildStory, cardLabel } from './story';

const story = buildStory(runScenario(fetchWebPage(), { seed: 1 }));

describe('network story', () => {
  it('visits laptop, home router, ISP router and server', () => {
    expect(story.devices.map((d) => d.id)).toEqual(['laptop', 'home', 'isp', 'server']);
  });

  it('packs the request at the laptop and unpacks it at the server', () => {
    const kinds = story.request.steps.map((s) => (s.kind === 'wrap' || s.kind === 'unwrap' ? `${s.kind}:${s.layer}` : s.kind));
    expect(kinds).toEqual([
      'appear', 'wrap:tcp', 'wrap:ip', 'wrap:eth', 'travel',
      'unwrap:eth', 'nat', 'wrap:eth', 'travel',
      'unwrap:eth', 'wrap:eth', 'travel',
      'unwrap:eth', 'unwrap:ip', 'unwrap:tcp', 'read',
    ]);
    expect(story.request.card).toBe('GET /');
    expect(story.response.card).toBe('200 OK');
  });

  it('uses real header sizes and addresses', () => {
    expect(story.request.header).toEqual({ eth: 14, ip: 20, tcp: 32 });
    expect(story.request.trailer).toBe(4);
    expect(story.request.from).toBe('192.168.1.23');
    expect(story.response.to).toBe('203.0.113.7');
    const nat = story.request.steps.find((s) => s.kind === 'nat');
    expect(nat).toMatchObject({ device: 'home', which: 'from', before: '192.168.1.23', after: '203.0.113.7' });
    const back = story.response.steps.find((s) => s.kind === 'nat');
    expect(back).toMatchObject({ device: 'home', which: 'to', before: '203.0.113.7', after: '192.168.1.23' });
  });

  it('finds the page title', () => {
    expect(story.pageTitle).toBe('Example Domain');
  });

  it('turns HTTP summaries into card labels', () => {
    expect(cardLabel('HTTP GET / HTTP/1.1')).toBe('GET /');
    expect(cardLabel('HTTP HTTP/1.1 200 OK')).toBe('200 OK');
  });
});

import { describe, expect, it } from 'vitest';
import { fetchWebPage, runScenario } from '../sim';
import { fieldAt, ownerOf, rangeOf } from './hexCard';
import { buildStory } from './story';

const story = buildStory(runScenario(fetchWebPage(), { seed: 1, faults: { randomLoss: 0, manual: [] } }));
const get = story.trips.find((t) => t.card === 'GET /')!;
const frame = get.steps.find((s) => s.kind === 'wrap' && s.layer === 'eth')!.pdu!;

describe('the hex view of a packet', () => {
  it('knows which piece each byte belongs to', () => {
    const owner = ownerOf(frame).map((l) => l?.protocol);
    expect(owner.slice(0, 14).every((p) => p === 'ethernet')).toBe(true);
    expect(owner[14]).toBe('ipv4');
    expect(owner[34]).toBe('tcp');
    expect(owner[66]).toBe('http');
    expect(owner[owner.length - 1]).toBe('ethernet');
  });

  it('finds the byte range of each piece', () => {
    expect(rangeOf(frame, 'ethH')).toEqual([0, 14]);
    expect(rangeOf(frame, 'ip')).toEqual([14, 34]);
    expect(rangeOf(frame, 'l4')).toEqual([34, 66]);
    expect(rangeOf(frame, 'card')).toEqual([66, frame.bytes.length - 4]);
    expect(rangeOf(frame, 'ethT')).toEqual([frame.bytes.length - 4, frame.bytes.length]);
    expect(rangeOf(frame, 'vpn')).toBeNull();
  });

  it('names the narrowest field under a byte', () => {
    expect(fieldAt(frame, 0)?.field.name).toBe('Destination MAC');
    expect(fieldAt(frame, 22)?.field.key).toBe('ipv4.ttl');
    expect(fieldAt(frame, 47)?.field.key).toMatch(/^tcp\.flags/);
  });
});

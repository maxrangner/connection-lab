import { describe, expect, it } from 'vitest';
import { fetchWebPage, runScenario } from '../../sim';
import { BYTE_TILE, layoutGizmo } from './Gizmo';

describe('layoutGizmo', () => {
  const runs = [
    runScenario(fetchWebPage(), { seed: 1 }),
    runScenario(fetchWebPage({ mss: 536 }), { seed: 2, faults: { randomLoss: 0.15, manual: [] } }),
    runScenario(fetchWebPage({ mss: 536 }), { seed: 4, faults: { randomLoss: 0.3, manual: [] } }),
  ];

  it('covers every byte exactly once, in order, with honest lengths', () => {
    let checked = 0;
    for (const r of runs) {
      for (const pdu of r.pdus.values()) {
        const pk = r.packets.get(pdu.packetId);
        const g = layoutGizmo(pdu, pk);
        const parts = g.parts.filter((p) => p.kind !== 'frame');
        let byte = 0;
        let x = 0;
        for (const p of parts) {
          expect(p.byteStart, `${pdu.id} ${p.name} start`).toBe(byte);
          expect(p.byteEnd).toBeGreaterThan(p.byteStart);
          expect(p.x).toBeCloseTo(x, 9);
          if (!p.collapsed) expect(p.len).toBeCloseTo((p.byteEnd - p.byteStart) * BYTE_TILE, 9);
          else expect(p.byteEnd - p.byteStart).toBeGreaterThan(64);
          byte = p.byteEnd;
          x += p.len;
        }
        expect(byte, `${pdu.id} total bytes`).toBe(pdu.bytes.length);
        expect(g.length).toBeCloseTo(x, 9);
        // Part protocol matches the layer that owns its first byte.
        for (const p of parts) {
          if (p.protocol === 'padding') continue;
          const owner = [...pdu.layers].reverse().find((l) => (p.byteStart >= l.start && p.byteStart < l.headerEnd) || (p.byteStart >= l.payloadEnd && p.byteStart < l.end));
          expect(owner?.protocol, `${pdu.id} ${p.name}`).toBe(p.protocol);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('gives Ethernet frames one front cap, one seal, rails, and padding only when padded', () => {
    const r = runs[0]!;
    let frames = 0;
    for (const pdu of r.pdus.values()) {
      if (pdu.first !== 'ethernet') continue;
      frames++;
      const g = layoutGizmo(pdu, r.packets.get(pdu.packetId));
      const fronts = g.parts.filter((p) => p.kind === 'shellFront');
      const backs = g.parts.filter((p) => p.kind === 'shellBack');
      const rails = g.parts.filter((p) => p.kind === 'frame');
      expect(fronts).toHaveLength(1);
      expect(backs).toHaveLength(1);
      expect(rails).toHaveLength(1);
      expect(fronts[0]!.byteEnd - fronts[0]!.byteStart).toBe(14);
      expect(backs[0]!.byteEnd - backs[0]!.byteStart).toBe(4);
      const padded = pdu.layers[0]!.fields.some((f) => f.key === 'eth.padding');
      expect(g.parts.some((p) => p.kind === 'filler')).toBe(padded);
      expect(rails[0]!.x).toBeCloseTo(fronts[0]!.x, 9);
      expect(rails[0]!.x + rails[0]!.len).toBeCloseTo(backs[0]!.x + backs[0]!.len, 9);
      expect(g.outerIds).toContain(fronts[0]!.id);
      expect(g.outerIds).toContain(backs[0]!.id);
      expect(g.outerFrontLen).toBeCloseTo(fronts[0]!.len, 9);
    }
    expect(frames).toBeGreaterThan(30);
  });

  it('labels the parts with the key fields', () => {
    const r = runs[0]!;
    const syn = [...r.pdus.values()].find((p) => p.first === 'ethernet' && r.packets.get(p.packetId)?.label === 'SYN')!;
    const g = layoutGizmo(syn, r.packets.get(syn.packetId));
    const texts = g.parts.flatMap((p) => p.labels.map((l) => l.text));
    expect(texts.some((t) => t.startsWith('TCP ') && t.includes('→ 80'))).toBe(true);
    expect(texts).toContain('[SYN]');
    expect(texts.some((t) => t.startsWith('seq 0'))).toBe(true);
    expect(texts.some((t) => t.startsWith('TTL 64'))).toBe(true);
    expect(texts).toContain('CRC ✓');
  });
});

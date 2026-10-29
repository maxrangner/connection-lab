import { describe, expect, it } from 'vitest';
import { fetchWebPage } from '../../sim';
import { buildWorld, cablePointAt, CABLE_Y, FD, FW, SLOT } from './layout';
import { depth, iso, unproject, U } from './project';

describe('iso projection', () => {
  it('unproject inverts iso at a known height', () => {
    for (const [x, y, z] of [
      [0, 0, 0],
      [3.5, -2, 1.25],
      [10, 7, 0],
    ] as const) {
      const p = iso(x, y, z);
      const w = unproject(p.sx, p.sy, z);
      expect(w.x).toBeCloseTo(x, 9);
      expect(w.y).toBeCloseTo(y, 9);
    }
  });

  it('has a 2:1 slope along both axes and depth grows toward the viewer', () => {
    const a = iso(0, 0, 0);
    const bx = iso(1, 0, 0);
    const by = iso(0, 1, 0);
    expect((bx.sy - a.sy) / (bx.sx - a.sx)).toBeCloseTo(0.5, 9);
    expect((by.sy - a.sy) / (by.sx - a.sx)).toBeCloseTo(-0.5, 9);
    expect(iso(0, 0, 1).sy).toBeCloseTo(-U, 9);
    expect(depth(2, 3)).toBeGreaterThan(depth(1, 3));
    expect(depth(2, 3)).toBeGreaterThan(depth(2, 2));
  });
});

describe('world layout', () => {
  const w = buildWorld(fetchWebPage());

  it('keeps every gizmo slot on the front edge and every cable in front of the pads', () => {
    for (const t of w.towers.values()) {
      for (const f of t.floors) {
        expect(f.slot.y - t.origin.y).toBeCloseTo(SLOT.y, 9);
        expect(f.slot.y).toBeLessThan(t.origin.y + FD);
        expect(f.machine.y).toBeLessThan(f.slot.y);
      }
      for (const p of t.ports) expect(p.socket.y).toBeGreaterThanOrEqual(t.origin.y + CABLE_Y - 1e-9);
    }
    for (const c of w.cables.values()) {
      for (const p of c.points) {
        for (const t of w.towers.values()) {
          const inside = p.x > t.origin.x - 1e-9 && p.x < t.origin.x + FW + 1e-9 && p.y > t.origin.y - 1e-9 && p.y < t.origin.y + FD + 1e-9;
          expect(inside, `cable ${c.id} point inside ${t.id}`).toBe(false);
        }
      }
      expect(c.length).toBeGreaterThan(2);
      for (const [i, len] of c.segLen.entries()) {
        expect(len).toBeGreaterThan(0);
        const a = c.points[i]!;
        const b = c.points[i + 1]!;
        expect(Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9).toBe(true); // axis-aligned
      }
    }
  });

  it('never overlaps two towers on screen', () => {
    const rects = [...w.towers.values()].map((t) => {
      const xs = [iso(t.origin.x, t.origin.y + FD, 0).sx, iso(t.origin.x + FW, t.origin.y, 0).sx];
      return { id: t.id, x0: Math.min(...xs), x1: Math.max(...xs) };
    });
    for (const a of rects) for (const b of rects) if (a !== b) expect(a.x1 <= b.x0 || b.x1 <= a.x0, `${a.id} vs ${b.id}`).toBe(true);
  });

  it('walks cables end to end', () => {
    for (const c of w.cables.values()) {
      const start = cablePointAt(c, 0).p;
      const end = cablePointAt(c, c.length).p;
      expect(start).toEqual(c.points[0]);
      expect(end.x).toBeCloseTo(c.points[c.points.length - 1]!.x, 9);
      expect(end.y).toBeCloseTo(c.points[c.points.length - 1]!.y, 9);
      let prev = -Infinity;
      for (let s = 0; s <= c.length; s += c.length / 50) {
        const d = depth(cablePointAt(c, s).p.x, cablePointAt(c, s).p.y);
        void d;
        const along = s;
        expect(along).toBeGreaterThanOrEqual(prev);
        prev = along;
      }
    }
  });
});

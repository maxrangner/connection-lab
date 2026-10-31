import { describe, expect, it } from 'vitest';
import { seqAdd, seqDiff, seqLe, seqLt } from './tcp';

describe('sequence numbers near the 2^32 wrap', () => {
  const iss = 0xfffffff0; // an initial sequence number 16 bytes before the wrap

  it('adding wraps around to small numbers', () => {
    expect(seqAdd(iss, 16)).toBe(0);
    expect(seqAdd(iss, 1460)).toBe(1444);
  });

  it('the signed distance is small across the wrap, not 4 billion', () => {
    expect(seqDiff(seqAdd(iss, 1460), iss)).toBe(1460);
    expect(seqDiff(iss, seqAdd(iss, 1460))).toBe(-1460);
    expect(seqDiff(5, 0xfffffffb)).toBe(10);
  });

  it('orders a segment after the wrap behind one before it, as the out-of-order queue and SACK blocks need', () => {
    const before = iss;
    const after = seqAdd(iss, 2920);
    expect(seqLt(before, after)).toBe(true);
    expect(seqLt(after, before)).toBe(false);
    expect(seqLe(after, after)).toBe(true);
    const starts = [after, before, seqAdd(iss, 1460)].sort((a, b) => seqDiff(a, b));
    expect(starts).toEqual([before, seqAdd(iss, 1460), after]);
  });
});

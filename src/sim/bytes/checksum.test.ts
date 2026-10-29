import { describe, expect, it } from 'vitest';
import { ascii, fromHex } from './bytes';
import { crc32, internetChecksum } from './checksum';

describe('internetChecksum (RFC 1071)', () => {
  // Example IPv4 header from Wikipedia "IPv4 header checksum": checksum field is 0xb861.
  const header = fromHex('4500 0073 0000 4000 4011 b861 c0a8 0001 c0a8 00c7');

  it('computes the known IPv4 header checksum', () => {
    const zeroed = header.slice();
    zeroed[10] = 0;
    zeroed[11] = 0;
    expect(internetChecksum(zeroed)).toBe(0xb861);
  });

  it('verifies to zero when the checksum is in place', () => {
    expect(internetChecksum(header)).toBe(0);
  });

  it('pads odd-length data with a zero byte', () => {
    expect(internetChecksum(fromHex('01'))).toBe(internetChecksum(fromHex('0100')));
  });
});

describe('crc32 (IEEE 802.3)', () => {
  it('matches the standard check value', () => {
    expect(crc32(ascii('123456789'))).toBe(0xcbf43926);
  });
});

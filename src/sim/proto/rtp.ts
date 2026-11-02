import { ByteWriter, hex, u16, u32, u8 } from '../bytes/bytes';
import { bitField, FieldList, type LayerPdu } from './types';

/**
 * RTP (RFC 3550), the transport for live audio and video over UDP. A fixed 12-byte header, then the media:
 * V (2 bits) · P (1) · X (1) · CC (4) · M (1) · PT (7) · sequence number (16) · timestamp (32) · SSRC (32) · CSRC list
 * (4 bytes each, CC of them) · payload. Nothing is ever sent again: a lost packet is a gap the receiver plays over.
 */
export const RTP_VERSION = 2;
export const RTP_HEADER_LEN = 12;
/** The usual port for RTP media (RFC 3551 §10 / RFC 4571 reserve 5004 for it). */
export const RTP_PORT = 5004;
/** Payload type 0: PCMU, G.711 µ-law at 8 kHz, one byte per sample (RFC 3551 table 4). */
export const RTP_PT_PCMU = 0;
/** The RTP clock for PCMU: 8000 ticks a second, one per sample. */
export const RTP_PCMU_CLOCK = 8000;
/** Samples in one packet at the usual 20 ms packetisation (RFC 3551 §6: 20 ms is the default ptime). */
export const RTP_SAMPLES_PER_PACKET = 160;

/** Static payload types of RFC 3551; 96–127 are dynamic, agreed in the signalling. */
const PAYLOAD_TYPES: Record<number, string> = { 0: 'PCMU', 3: 'GSM', 4: 'G723', 8: 'PCMA', 9: 'G722', 18: 'G729', 26: 'JPEG', 31: 'H261', 32: 'MPV', 34: 'H263' };

export function rtpPayloadTypeName(pt: number): string {
  if (pt >= 96) return `dynamic (${pt})`;
  return PAYLOAD_TYPES[pt] ?? `type ${pt}`;
}

export interface RtpHeader {
  /** Start of a talkspurt (audio) or end of a frame (video). */
  marker: boolean;
  payloadType: number;
  seq: number;
  timestamp: number;
  /** Who is speaking: a random number that stays the same for the whole stream. */
  ssrc: number;
}

/** A packet with no padding, no extension and no contributing sources, as nearly every voice packet is. */
export function buildRtp(h: RtpHeader, payload: Uint8Array): Uint8Array {
  return new ByteWriter()
    .u8(RTP_VERSION << 6)
    .u8((h.marker ? 0x80 : 0) | (h.payloadType & 0x7f))
    .u16(h.seq)
    .u32(h.timestamp)
    .u32(h.ssrc)
    .bytes(payload)
    .toBytes();
}

export interface ParsedRtp extends RtpHeader {
  version: number;
  padding: boolean;
  extension: boolean;
  csrcCount: number;
  csrcs: number[];
  /** Where the media starts and ends (after the CSRC list, before any padding). */
  payloadStart: number;
  payloadEnd: number;
  /** Padding bytes at the end, when P is set: the last byte says how many. */
  padLength: number;
}

export function parseRtp(b: Uint8Array, o: number, end = b.length): ParsedRtp {
  const b0 = u8(b, o);
  const b1 = u8(b, o + 1);
  const csrcCount = b0 & 0x0f;
  const padding = !!(b0 & 0x20);
  const csrcs: number[] = [];
  for (let i = 0; i < csrcCount; i++) csrcs.push(u32(b, o + RTP_HEADER_LEN + i * 4));
  const extended = !!(b0 & 0x10);
  const fixed = o + RTP_HEADER_LEN + csrcCount * 4;
  // An extension is a word of ID and length, then that many words (RFC 3550 section 5.3.1).
  const payloadStart = extended ? fixed + 4 + u16(b, fixed + 2) * 4 : fixed;
  const padLength = padding ? u8(b, end - 1) : 0;
  return {
    version: b0 >> 6,
    padding,
    extension: extended,
    csrcCount,
    marker: !!(b1 & 0x80),
    payloadType: b1 & 0x7f,
    seq: u16(b, o + 2),
    timestamp: u32(b, o + 4),
    ssrc: u32(b, o + 8),
    csrcs,
    payloadStart: Math.min(payloadStart, end),
    payloadEnd: Math.max(Math.min(payloadStart, end), end - padLength),
    padLength,
  };
}

export function describeRtp(b: Uint8Array, o: number, end: number): LayerPdu {
  const p = parseRtp(b, o, end);
  const audio = p.payloadEnd - p.payloadStart;
  const ms = p.payloadType === RTP_PT_PCMU ? ` (${Math.round((audio * 1000) / RTP_PCMU_CLOCK)} ms)` : '';
  const f = new FieldList();
  f.list.push(bitField('rtp.version', 'Version', o, 1, 0, 2, p.version, 'key', 'Always 2: the RTP of RFC 3550, in use since 1996. Versions 0 and 1 were the early experiments.'));
  f.list.push(bitField('rtp.padding', 'Padding', o, 1, 2, 1, p.padding ? '1 (padded)' : '0', 'detail', 'Set when extra bytes follow the media, for an encryption that needs whole blocks; the last byte then says how many. Plain voice needs none.'));
  f.list.push(bitField('rtp.extension', 'Extension', o, 1, 3, 1, p.extension ? '1' : '0', 'detail', 'Set when one extra header follows the fixed one, for things a profile adds (an audio level, for example). Not here.'));
  f.list.push(bitField('rtp.cc', 'CSRC count', o, 1, 4, 4, p.csrcCount, 'detail', 'How many contributing sources are listed after the header. A mixer that blends several speakers into one stream names them here; a one-to-one call lists none.'));
  f.list.push(bitField('rtp.marker', 'Marker', o + 1, 1, 0, 1, p.marker ? '1' : '0', 'detail', 'For audio: the first packet after a silence, so the receiver may start playing afresh. For video: the last packet of a frame.'));
  f.list.push(bitField('rtp.pt', 'Payload type', o + 1, 1, 1, 7, `${p.payloadType} (${rtpPayloadTypeName(p.payloadType)})`, 'key', 'Which codec the payload is in. 0 is PCMU: G.711 µ-law, the landline telephone codec, 8000 one-byte samples a second (64 kbit/s). A modern app would use Opus on a dynamic type agreed in the signalling.'));
  f.add('rtp.seq', 'Sequence number', o + 2, 2, p.seq, 'key', 'Goes up by one with every packet sent, from a random start. The receiver uses it to spot a lost packet (a number skipped) or one out of order; it never asks for one again, it just plays silence over the hole.');
  f.add('rtp.timestamp', 'Timestamp', o + 4, 4, p.timestamp, 'key', 'When the first sample in this packet was taken, in ticks of the codec clock (8000 a second for G.711), from a random start. 160 samples per packet, so it goes up by 160 each time: it lets the receiver play the sound at the right pace and know how long a gap was.');
  f.add('rtp.ssrc', 'SSRC', o + 8, 4, hex(p.ssrc, 8), 'key', 'Synchronisation source: a random number the sender picks for this stream, so a receiver can tell streams apart and knows every packet with this number belongs together. Each side of a call has its own.');
  for (let i = 0; i < p.csrcCount; i++) f.add(`rtp.csrc${i}`, `CSRC ${i + 1}`, o + RTP_HEADER_LEN + i * 4, 4, hex(p.csrcs[i] ?? 0, 8), 'detail', 'A source a mixer blended into this stream.');
  f.add('rtp.payload', p.payloadType === RTP_PT_PCMU ? 'Audio' : 'Media', p.payloadStart, audio, `${audio} bytes${ms}`, 'key', 'The sound itself: with G.711 one byte per sample, 160 of them for 20 ms of speech. Not encrypted here, so anyone on the line could listen; a real app would use SRTP.');
  if (p.padding) f.add('rtp.pad', 'Padding bytes', p.payloadEnd, p.padLength, `${p.padLength} bytes`, 'detail', 'Filler after the media; the last of them holds their count.');
  return {
    protocol: 'rtp',
    layer: 5,
    start: o,
    headerEnd: p.payloadStart,
    payloadEnd: p.payloadEnd,
    end,
    summary: `RTP ${rtpPayloadTypeName(p.payloadType)} seq ${p.seq} · ts ${p.timestamp} · ${audio} B audio${ms}`,
    fields: f.list,
  };
}

import { describe, expect, it } from 'vitest';
import { TCP_ACK, TCP_RST, type ParsedTcp } from '../proto/tcp';
import { seqAdd, seqDiff, seqLe, seqLt, TcpConnection } from './tcp';

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

describe('a reset', () => {
  const connection = (state: TcpConnection['state']): { conn: TcpConnection; errors: string[] } => {
    const sim = { emit() {}, cancel() {} };
    const conn = new TcpConnection({ id: 'a', sim, tcpRemove() {}, random32: () => 1000 } as never, '10.0.0.1', 1000, '10.0.0.2', 80, { mss: 1460, wscale: 7, app: 'http' });
    Object.assign(conn, { state, rcvNxt: 5000, iss: 900 });
    const errors: string[] = [];
    conn.handlers = { onError: (_c, reason) => errors.push(reason) };
    return { conn, errors };
  };
  const rst = (seq: number, ack = 0, flags = TCP_RST): ParsedTcp => ({ seq, ack, flags }) as ParsedTcp;

  it('at the sequence number expected ends the connection, and whoever uses it hears', () => {
    const { conn, errors } = connection('ESTABLISHED');
    conn.input(rst(5000), new Uint8Array(0), 'pk');
    expect(conn.state).toBe('CLOSED');
    expect(errors).toEqual(['connection reset']);
  });

  it('at any other sequence number is ignored: a straggler, or a forgery', () => {
    const { conn, errors } = connection('ESTABLISHED');
    for (const seq of [4999, 5001, 123456]) conn.input(rst(seq), new Uint8Array(0), 'pk');
    expect(conn.state).toBe('ESTABLISHED');
    expect(errors).toEqual([]);
  });

  it('while calling counts only if it acknowledges the SYN', () => {
    const wrong = connection('SYN_SENT');
    wrong.conn.input(rst(0, 500, TCP_RST | TCP_ACK), new Uint8Array(0), 'pk');
    wrong.conn.input(rst(0, 901, TCP_RST), new Uint8Array(0), 'pk');
    expect(wrong.conn.state).toBe('SYN_SENT');
    const right = connection('SYN_SENT');
    right.conn.input(rst(0, 901, TCP_RST | TCP_ACK), new Uint8Array(0), 'pk');
    expect(right.conn.state).toBe('CLOSED');
    expect(right.errors).toEqual(['connection refused']);
  });

  it('at the end of a normal goodbye is no error', () => {
    const { conn, errors } = connection('LAST_ACK');
    conn.input(rst(5000), new Uint8Array(0), 'pk');
    expect(conn.state).toBe('CLOSED');
    expect(errors).toEqual([]);
  });
});

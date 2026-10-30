import { concat, fromBase64, toAscii } from '../bytes/bytes';
import { decryptHttp, sessionStream, type TlsSession } from '../proto/tls';
import { httpMessageComplete } from './apps';
import type { Host } from './Host';
import type { TcpConnection } from './tcp';

/**
 * HTTPS over a captured TLS 1.3 session. Both ends send exactly the bytes the real browser and server sent, each
 * flight once every earlier flight from the other side has arrived. What they learn from each other they get by
 * decrypting the other side's records with the session's keys (proto/tls.ts), never from a shortcut.
 */
class Replay {
  private readonly flights: { from: 'client' | 'server'; bytes: Uint8Array }[];
  private next = 0;
  received: Uint8Array = new Uint8Array(0);

  constructor(
    readonly session: TlsSession,
    readonly me: 'client' | 'server',
  ) {
    this.flights = session.flights.map((f) => ({ from: f.from, bytes: fromBase64(f.base64) }));
  }

  /** Bytes the other side sends before flight i. */
  private peerBefore(i: number): number {
    return this.flights.slice(0, i).reduce((n, f) => n + (f.from === this.me ? 0 : f.bytes.length), 0);
  }

  get peerTotal(): number {
    return this.peerBefore(this.flights.length);
  }

  /** The next flight of ours that may go now (everything the other side sent before it has arrived), if any. */
  take(): { index: number; bytes: Uint8Array } | null {
    while (this.next < this.flights.length) {
      const f = this.flights[this.next]!;
      if (this.received.length < this.peerBefore(this.next + (f.from === this.me ? 0 : 1))) return null;
      const index = this.next++;
      if (f.from === this.me) return { index, bytes: f.bytes };
    }
    return null;
  }

  /** Whether flight i carries application data (the HTTP request or response) rather than only handshake. */
  isLastOfMine(index: number): boolean {
    return !this.flights.slice(index + 1).some((f) => f.from === this.me);
  }
}

export function httpsClient(host: Host, conn: TcpConnection, session: TlsSession, request: Uint8Array, path: string, done: (ok: boolean, bytes: number) => void): {
  onData: (c: TcpConnection, data: Uint8Array) => void;
  onPeerClose: (c: TcpConnection) => void;
} {
  const sim = host.sim;
  const tls = new Replay(session, 'client');
  let requestSent = false;
  let reported = false;
  const pump = (): void => {
    for (let f = tls.take(); f; f = tls.take()) {
      // The flight that carries the encrypted request is the first one after the server's handshake.
      const carriesRequest = !requestSent && f.index > 0;
      if (carriesRequest) {
        requestSent = true;
        const msg = sim.newPacket(host.id, 'stream', `HTTP GET ${path} (application bytes)`);
        const pduId = sim.pdu(msg.id, request, 'http');
        sim.emit({ type: 'app', deviceId: host.id, app: 'browser', action: 'http-request-sent', pduId, info: { target: conn.remoteIp } });
        sim.emit({ type: 'encapsulate', deviceId: host.id, packetId: msg.id, layer: 5, protocol: 'http', pduId });
      }
      const pk = sim.newPacket(host.id, 'stream', f.index === 0 ? 'TLS ClientHello' : carriesRequest ? 'TLS: Finished + encrypted GET' : 'TLS close_notify');
      const pduId = sim.pdu(pk.id, f.bytes, 'tls');
      sim.emit({ type: 'encapsulate', deviceId: host.id, packetId: pk.id, layer: 5, protocol: 'tls', pduId });
      conn.write(f.bytes, f.index === 0 ? 'TLS ClientHello' : carriesRequest ? `HTTPS GET ${path}` : 'TLS close_notify');
    }
  };
  pump();
  return {
    onData(_c, data) {
      tls.received = concat(tls.received, data);
      if (!reported && tls.received.length >= tls.peerTotal) {
        // Everything the server sent has arrived: open its application-data records to read the page.
        const page = decryptHttp(session, 'server', tls.received);
        if (httpMessageComplete(page)) {
          reported = true;
          const msg = sim.newPacket(host.id, 'stream', 'HTTP response (decrypted from TLS)');
          const pduId = sim.pdu(msg.id, page, 'http');
          const status = toAscii(page, 0, Math.min(page.length, 64)).split('\r\n')[0] ?? '';
          sim.emit({ type: 'app', deviceId: host.id, app: 'browser', action: 'http-response-received', pduId, info: { status, bytes: page.length } });
        }
      }
      pump();
    },
    onPeerClose(c) {
      c.close();
      done(reported, tls.received.length);
    },
  };
}

export function startHttpsServer(host: Host, session: TlsSession, processing: number, mss: number): void {
  const sim = host.sim;
  host.tcpListen(443, { mss, wscale: 10, app: 'tls' }, (conn) => {
    const tls = new Replay(session, 'server');
    let answered = false;
    const send = (f: { index: number; bytes: Uint8Array }): void => {
      const pk = sim.newPacket(host.id, 'stream', f.index === 1 ? 'TLS ServerHello + certificate' : 'TLS: encrypted 200 OK');
      sim.emit({ type: 'encapsulate', deviceId: host.id, packetId: pk.id, layer: 5, protocol: 'tls', pduId: sim.pdu(pk.id, f.bytes, 'tls') });
      conn.write(f.bytes, f.index === 1 ? 'TLS ServerHello + certificate' : 'HTTPS 200 OK');
      if (tls.isLastOfMine(f.index)) conn.close();
    };
    conn.handlers = {
      onData(_c, data) {
        tls.received = concat(tls.received, data);
        // Open the client's records: once a whole HTTP request is inside, answer it (after thinking for a moment).
        const request = answered ? null : decryptHttp(session, 'client', tls.received);
        if (request && request.length && httpMessageComplete(request)) {
          answered = true;
          const reqLine = toAscii(request, 0, Math.min(request.length, 128)).split('\r\n')[0] ?? '';
          const rx = sim.newPacket(host.id, 'stream', 'HTTP request (decrypted from TLS)');
          sim.emit({ type: 'app', deviceId: host.id, app: 'http-server', action: 'http-request-received', pduId: sim.pdu(rx.id, request, 'http'), info: { requestLine: reqLine } });
          sim.after(processing, () => {
            const page = decryptHttp(session, 'server', sessionStream(session, 'server'));
            const msg = sim.newPacket(host.id, 'stream', 'HTTP 200 OK (application bytes)');
            const pduId = sim.pdu(msg.id, page, 'http');
            sim.emit({ type: 'app', deviceId: host.id, app: 'http-server', action: 'http-response-sent', pduId, info: { bytes: page.length } });
            sim.emit({ type: 'encapsulate', deviceId: host.id, packetId: msg.id, layer: 5, protocol: 'http', pduId });
            for (let f = tls.take(); f; f = tls.take()) send(f);
          });
          return;
        }
        // Still in the handshake: answer the hello right away.
        if (!answered) for (let f = tls.take(); f; f = tls.take()) send(f);
      },
      onPeerClose(c) {
        c.close();
      },
    };
  });
}

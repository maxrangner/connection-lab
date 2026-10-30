import { concat, toAscii } from '../bytes/bytes';
import type { AppSpec } from '../model';
import { buildDnsQuery, buildDnsResponse, parseDns } from '../proto/dns';
import type { Host } from './Host';
import { httpsClient } from './https';

const DNS_TIMEOUT = 5; // glibc resolv.conf default "timeout:5"
const DNS_ATTEMPTS = 2; // glibc default "attempts:2"

type BrowserSpec = Extract<AppSpec, { kind: 'browser' }>;
type DnsServerSpec = Extract<AppSpec, { kind: 'dns-server' }>;
type HttpServerSpec = Extract<AppSpec, { kind: 'http-server' }>;

/** Is this a complete HTTP/1.1 message? Handles Content-Length and chunked bodies. */
export function httpMessageComplete(bytes: Uint8Array): boolean {
  const text = toAscii(bytes);
  const headEnd = text.indexOf('\r\n\r\n');
  if (headEnd < 0) return false;
  const head = text.slice(0, headEnd).toLowerCase();
  const body = text.slice(headEnd + 4);
  if (/transfer-encoding:\s*chunked/.test(head)) return /(^|\r\n)0\r\n\r\n$/.test(body);
  const cl = /content-length:\s*(\d+)/.exec(head);
  if (cl) return body.length >= Number(cl[1]);
  return head.startsWith('get ') || head.startsWith('head ');
}

/** Stub resolver (like glibc): one UDP question to the configured resolver, retried after a timeout. */
function resolve(host: Host, name: string, resolver: string, done: (ips: string[]) => void, fail: () => void): void {
  const sim = host.sim;
  const port = host.ephemeralPort();
  const id = host.random32() & 0xffff;
  let attempt = 0;
  let timer: number | undefined;
  let timerId = '';
  const query = buildDnsQuery(id, name);
  const send = (): void => {
    attempt++;
    const pk = sim.newPacket(host.id, 'dns', `DNS query: ${name} A?${attempt > 1 ? ' (retry)' : ''}`);
    const pduId = sim.pdu(pk.id, query, 'dns');
    sim.emit({ type: 'app', deviceId: host.id, app: 'dns-client', action: 'dns-lookup', pduId, info: { name, resolver, attempt } });
    sim.emit({ type: 'encapsulate', deviceId: host.id, packetId: pk.id, layer: 5, protocol: 'dns', pduId });
    host.udpSend(port, resolver, 53, query, pk.id);
    timerId = host.newTimerId('dns');
    sim.emit({ type: 'timer:set', deviceId: host.id, timerId, kind: 'dns-retry', fireAt: sim.now + DNS_TIMEOUT });
    timer = sim.after(DNS_TIMEOUT, () => {
      sim.emit({ type: 'timer:fire', deviceId: host.id, timerId, kind: 'dns-retry' });
      if (attempt < DNS_ATTEMPTS) send();
      else {
        host.udpUnbind(port);
        fail();
      }
    });
  };
  host.udpBind(port, 'dns', (from, data, _packetId, pduId) => {
    const msg = parseDns(data, 0);
    if (from.ip !== resolver || from.port !== 53 || msg.id !== id || !msg.isResponse) return;
    sim.cancel(timer);
    sim.emit({ type: 'timer:cancel', deviceId: host.id, timerId, kind: 'dns-retry' });
    host.udpUnbind(port);
    const ips = msg.answers.map((a) => a.ip).filter((x): x is string => !!x);
    sim.emit({
      type: 'app',
      deviceId: host.id,
      app: 'dns-client',
      action: 'dns-answer',
      pduId,
      info: { name, addresses: ips, ttl: msg.answers[0]?.ttl ?? 0 },
    });
    done(ips);
  });
  send();
}

export function startBrowser(host: Host, spec: BrowserSpec, mss: number): void {
  const sim = host.sim;
  const url = new URL(spec.url);
  sim.emit({ type: 'app', deviceId: host.id, app: 'browser', action: 'start', info: { url: spec.url } });
  const lookup = (done: (ips: string[]) => void, fail: () => void): void => {
    if (!spec.knownAddress) return resolve(host, url.hostname, spec.resolver, done, fail);
    sim.emit({ type: 'app', deviceId: host.id, app: 'dns-client', action: 'dns-cache-hit', info: { name: url.hostname, addresses: [spec.knownAddress] } });
    done([spec.knownAddress]);
  };
  lookup(
    (ips) => {
      const target = ips[0]!;
      if (spec.tls) {
        const session = spec.tls;
        host.tcpConnect(target, 443, { mss, wscale: 7, app: 'tls' }, {
          onConnected(conn) {
            const h = httpsClient(host, conn, session, spec.request, url.pathname, (ok, bytes) =>
              sim.emit({ type: 'app', deviceId: host.id, app: 'browser', action: ok ? 'done' : 'error', info: ok ? { bytes } : { reason: 'connection closed before the response was complete' } }),
            );
            conn.handlers = { ...conn.handlers, onData: h.onData, onPeerClose: h.onPeerClose };
          },
          onError(_conn, reason) {
            sim.emit({ type: 'app', deviceId: host.id, app: 'browser', action: 'error', info: { reason } });
          },
        });
        return;
      }
      let received: Uint8Array = new Uint8Array(0);
      let reported = false;
      host.tcpConnect(target, Number(url.port || 80), { mss, wscale: 7, app: 'http' }, {
        onConnected(conn) {
          const msg = sim.newPacket(host.id, 'stream', `HTTP GET ${url.pathname} (application bytes)`);
          const pduId = sim.pdu(msg.id, spec.request, 'http');
          sim.emit({ type: 'app', deviceId: host.id, app: 'browser', action: 'http-request-sent', pduId, info: { target } });
          sim.emit({ type: 'encapsulate', deviceId: host.id, packetId: msg.id, layer: 5, protocol: 'http', pduId });
          conn.write(spec.request, `HTTP GET ${url.pathname}`);
        },
        onData(_conn, data) {
          received = concat(received, data);
          if (!reported && httpMessageComplete(received)) {
            reported = true;
            const msg = sim.newPacket(host.id, 'stream', 'HTTP response (reassembled from TCP)');
            const pduId = sim.pdu(msg.id, received, 'http');
            const status = toAscii(received, 0, Math.min(received.length, 64)).split('\r\n')[0] ?? '';
            sim.emit({
              type: 'app',
              deviceId: host.id,
              app: 'browser',
              action: 'http-response-received',
              pduId,
              info: { status, bytes: received.length },
            });
          }
        },
        onPeerClose(conn) {
          conn.close();
          sim.emit({
            type: 'app',
            deviceId: host.id,
            app: 'browser',
            action: reported ? 'done' : 'error',
            info: reported ? { bytes: received.length } : { reason: 'connection closed before the response was complete' },
          });
        },
        onError(_conn, reason) {
          sim.emit({ type: 'app', deviceId: host.id, app: 'browser', action: 'error', info: { reason } });
        },
      });
    },
    () => sim.emit({ type: 'app', deviceId: host.id, app: 'browser', action: 'error', info: { reason: 'DNS lookup timed out' } }),
  );
}

export function startDnsServer(host: Host, spec: DnsServerSpec): void {
  const sim = host.sim;
  host.udpBind(53, 'dns', (from, data) => {
    const q = parseDns(data, 0);
    const name = q.questions[0]?.name ?? '';
    const rec = spec.records[name.toLowerCase()];
    sim.after(spec.processing, () => {
      const resp = buildDnsResponse(
        q.id,
        name,
        (rec?.ips ?? []).map((ip) => ({ ip, ttl: rec?.ttl ?? 0 })),
      );
      const pk = sim.newPacket(host.id, 'dns', `DNS response: ${name} A ${rec?.ips.join(', ') ?? '(none)'}`);
      const pduId = sim.pdu(pk.id, resp, 'dns');
      sim.emit({ type: 'app', deviceId: host.id, app: 'dns-server', action: 'dns-serve', pduId, info: { name, addresses: rec?.ips ?? [], from: from.ip } });
      sim.emit({ type: 'encapsulate', deviceId: host.id, packetId: pk.id, layer: 5, protocol: 'dns', pduId });
      host.udpSend(53, from.ip, from.port, resp, pk.id);
    });
  });
}

export function startHttpServer(host: Host, spec: HttpServerSpec, mss: number): void {
  const sim = host.sim;
  host.tcpListen(80, { mss, wscale: 10, app: 'http' }, (conn) => {
    let received: Uint8Array = new Uint8Array(0);
    let answered = false;
    conn.handlers = {
      onData(c, data) {
        received = concat(received, data);
        if (answered || !httpMessageComplete(received)) return;
        answered = true;
        const reqLine = toAscii(received, 0, Math.min(received.length, 128)).split('\r\n')[0] ?? '';
        sim.emit({
          type: 'app',
          deviceId: host.id,
          app: 'http-server',
          action: 'http-request-received',
          pduId: sim.pdu(sim.newPacket(host.id, 'stream', 'HTTP request (reassembled from TCP)').id, received, 'http'),
          info: { requestLine: reqLine },
        });
        sim.after(spec.processing, () => {
          const msg = sim.newPacket(host.id, 'stream', 'HTTP 200 OK (application bytes)');
          const pduId = sim.pdu(msg.id, spec.response, 'http');
          sim.emit({ type: 'app', deviceId: host.id, app: 'http-server', action: 'http-response-sent', pduId, info: { bytes: spec.response.length } });
          sim.emit({ type: 'encapsulate', deviceId: host.id, packetId: msg.id, layer: 5, protocol: 'http', pduId });
          c.write(spec.response, 'HTTP 200 OK');
          c.close(); // "Connection: close": the server ends its side once the response is queued
        });
      },
      onPeerClose(c) {
        c.close();
      },
    };
  });
}

import type { Ip4 } from '../bytes/addr';
import { concat, setU16, toAscii } from '../bytes/bytes';
import type { AppSpec } from '../model';
import { buildDnsQuery, buildDnsResponse, DNS_RCODE_NXDOMAIN, DNS_RCODE_OK, DNS_RCODE_SERVFAIL, DNS_TYPE_A, dnsAddresses, dnsReferral, dnsSummary, parseDns } from '../proto/dns';
import { buildRtp, parseRtp, RTP_PORT, RTP_PT_PCMU, RTP_SAMPLES_PER_PACKET, RTP_VERSION } from '../proto/rtp';
import type { Host } from './Host';
import { httpsClient } from './https';

const DNS_TIMEOUT = 5; // glibc resolv.conf default "timeout:5"
const DNS_ATTEMPTS = 2; // glibc default "attempts:2"
const UPSTREAM_TIMEOUT = 2; // a resolver gives a server of the hierarchy about this long before asking again
const UPSTREAM_ATTEMPTS = 2;
/** One voice packet every 20 ms: 160 samples of G.711, the usual packetisation (RFC 3551 §6). */
const RTP_INTERVAL = RTP_SAMPLES_PER_PACKET / 8000;
/** How long a caller who hears nothing back lets the line ring after its own clip before it hangs up. */
const NO_ANSWER_WAIT = 2;

type BrowserSpec = Extract<AppSpec, { kind: 'browser' }>;
type VoiceCallSpec = Extract<AppSpec, { kind: 'voice-call' }>;
type VoicePeerSpec = Extract<AppSpec, { kind: 'voice-peer' }>;
type DnsServerSpec = Extract<AppSpec, { kind: 'dns-server' }>;
type DnsAuthoritySpec = Extract<AppSpec, { kind: 'dns-authority' }>;
type HttpServerSpec = Extract<AppSpec, { kind: 'http-server' }>;
type DnsRecordSet = DnsServerSpec['records'][string];

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
function resolve(host: Host, name: string, resolver: string, done: (ips: string[]) => void, fail: (reason: string) => void): void {
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
        fail('DNS lookup timed out');
      }
    });
  };
  host.udpBind(port, 'dns', (from, data, _packetId, pduId) => {
    const msg = parseDns(data, 0);
    if (from.ip !== resolver || from.port !== 53 || msg.id !== id || !msg.isResponse) return;
    sim.cancel(timer);
    sim.emit({ type: 'timer:cancel', deviceId: host.id, timerId, kind: 'dns-retry' });
    host.udpUnbind(port);
    const ips = dnsAddresses(msg);
    sim.emit({
      type: 'app',
      deviceId: host.id,
      app: 'dns-client',
      action: 'dns-answer',
      pduId,
      info: { name, addresses: ips, ttl: msg.answers[0]?.ttl ?? 0, rcode: msg.rcode },
    });
    // An error code or an empty answer is a real answer, just not one we can connect to.
    if (msg.rcode !== DNS_RCODE_OK || ips.length === 0) fail(msg.rcode === DNS_RCODE_NXDOMAIN ? 'no such name' : msg.rcode === DNS_RCODE_SERVFAIL ? 'the resolver could not find out' : 'no address');
    else done(ips);
  });
  send();
}

/** The addresses for a name: the one still cached from last time, or else what the stub resolver finds out. */
function findAddress(host: Host, name: string, resolver: string | undefined, known: Ip4 | undefined, done: (ips: string[]) => void, fail: (reason: string) => void): void {
  if (!known && !resolver) return fail('no DNS resolver configured');
  if (!known) return resolve(host, name, resolver!, done, fail);
  host.sim.emit({ type: 'app', deviceId: host.id, app: 'dns-client', action: 'dns-cache-hit', info: { name, addresses: [known] } });
  done([known]);
}

/** `leased` is the resolver DHCP handed out, used when the spec names none. */
export function startBrowser(host: Host, spec: BrowserSpec, mss: number, leased?: string): void {
  const sim = host.sim;
  const url = new URL(spec.url);
  sim.emit({ type: 'app', deviceId: host.id, app: 'browser', action: 'start', info: { url: spec.url } });
  const lookup = (done: (ips: string[]) => void, fail: (reason: string) => void): void => findAddress(host, url.hostname, spec.resolver ?? leased, spec.knownAddress, done, fail);
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
    (reason) => sim.emit({ type: 'app', deviceId: host.id, app: 'browser', action: 'error', info: { reason } }),
  );
}

/**
 * One end of a voice call on one UDP port: it streams its clip to whoever it is told to, a packet every 20 ms, and plays
 * what comes in by sequence number. A skipped number is a gap: the packet is lost, nothing asks for it again, the call
 * goes on. The call hangs up once both clips are through: its own sent, and the other's length heard from when its
 * first packet came (the clips are the same length). No RTCP, no SIP and no jitter buffer: packets are played as they come.
 */
function voiceEndpoint(host: Host, app: 'voice-call' | 'voice-peer', port: number, clip: Uint8Array, onFirst?: (from: { ip: Ip4; port: number }) => void): { send(to: { ip: Ip4; port: number }): void } {
  const sim = host.sim;
  const packets = Math.ceil(clip.length / RTP_SAMPLES_PER_PACKET);
  const rx = { ssrc: -1, expected: -1, received: 0, gaps: 0, firstAt: -1 };
  let sentAll = -1;
  let hangTimer: number | undefined;
  let done = false;
  const finish = (ok: boolean): void => {
    done = true;
    host.udpUnbind(port);
    if (ok) sim.emit({ type: 'app', deviceId: host.id, app, action: 'call-done', info: { received: rx.received, gaps: rx.gaps } });
    else sim.emit({ type: 'app', deviceId: host.id, app, action: 'error', info: { reason: 'nobody answered' } });
  };
  const hangUp = (): void => {
    if (sentAll < 0) return;
    sim.cancel(hangTimer);
    if (rx.firstAt < 0) hangTimer = sim.at(sentAll + NO_ANSWER_WAIT, () => finish(false));
    else hangTimer = sim.at(Math.max(sentAll, rx.firstAt + packets * RTP_INTERVAL), () => finish(true));
  };
  host.udpBind(port, 'rtp', (from, data, _packetId, pduId) => {
    if (done) return;
    const h = parseRtp(data, 0);
    if (h.version !== RTP_VERSION || h.payloadType !== RTP_PT_PCMU) return;
    const first = rx.ssrc < 0;
    if (first) {
      rx.ssrc = h.ssrc;
      rx.firstAt = sim.now;
    } else if (h.ssrc !== rx.ssrc) return; // another stream altogether; a real app keeps one receiver per source
    const bytes = h.payloadEnd - h.payloadStart;
    if (rx.expected >= 0 && h.seq !== rx.expected) {
      const ahead = (h.seq - rx.expected) & 0xffff;
      if (ahead >= 0x8000) {
        sim.emit({ type: 'app', deviceId: host.id, app, action: 'rtp-late', pduId, info: { seq: h.seq, expected: rx.expected } });
        return;
      }
      rx.gaps += ahead;
      sim.emit({ type: 'app', deviceId: host.id, app, action: 'rtp-gap', pduId, info: { expected: rx.expected, got: h.seq, missing: ahead } });
    }
    rx.received++;
    rx.expected = (h.seq + 1) & 0xffff;
    sim.emit({ type: 'app', deviceId: host.id, app, action: 'rtp-received', pduId, info: { seq: h.seq, bytes, totalReceived: rx.received } });
    if (first) {
      onFirst?.(from);
      hangUp();
    }
  });
  return {
    send(to) {
      // RFC 3550 §5.1: the sequence number and timestamp start at random values, and the SSRC is random too.
      const ssrc = host.random32();
      const seq0 = host.random32() & 0xffff;
      const ts0 = host.random32();
      const start = sim.now;
      for (let i = 0; i < packets; i++) {
        sim.at(start + i * RTP_INTERVAL, () => {
          if (done) return;
          const seq = (seq0 + i) & 0xffff;
          const timestamp = (ts0 + i * RTP_SAMPLES_PER_PACKET) >>> 0;
          // The marker says "a talkspurt starts here": set on the first packet, as a phone does after silence.
          const msg = buildRtp({ marker: i === 0, payloadType: RTP_PT_PCMU, seq, timestamp, ssrc }, clip.subarray(i * RTP_SAMPLES_PER_PACKET, (i + 1) * RTP_SAMPLES_PER_PACKET));
          const pk = sim.newPacket(host.id, 'rtp', `RTP voice (part ${i + 1}/${packets})`, { rtp: { seq, ssrc, part: i + 1, of: packets } });
          const pduId = sim.pdu(pk.id, msg, 'rtp');
          sim.emit({ type: 'encapsulate', deviceId: host.id, packetId: pk.id, layer: 5, protocol: 'rtp', pduId });
          host.udpSend(port, to.ip, to.port, msg, pk.id);
          if (i === packets - 1) {
            sentAll = sim.now + RTP_INTERVAL;
            hangUp();
          }
        });
      }
    },
  };
}

/** The caller: finds the friend's address (the cached one, or by DNS) and streams its clip to the friend's RTP port. */
export function startVoiceCall(host: Host, spec: VoiceCallSpec, leased?: string): void {
  const sim = host.sim;
  sim.emit({ type: 'app', deviceId: host.id, app: 'voice-call', action: 'start', info: { to: spec.to } });
  findAddress(
    host,
    spec.to,
    spec.resolver ?? leased,
    spec.knownAddress,
    (ips) => voiceEndpoint(host, 'voice-call', host.ephemeralPort(), spec.clip).send({ ip: ips[0]!, port: RTP_PORT }),
    (reason) => sim.emit({ type: 'app', deviceId: host.id, app: 'voice-call', action: 'error', info: { reason } }),
  );
}

/** The friend's phone: listens on its RTP port and, when the first packet of a call comes, talks back to where it came from. */
export function startVoicePeer(host: Host, spec: VoicePeerSpec): void {
  const endpoint = voiceEndpoint(host, 'voice-peer', spec.port, spec.clip, (from) => endpoint.send(from));
}

/**
 * The walk a resolver makes for a name it has not cached: ask a root server (RD=0, it does the chasing itself), follow the
 * referral to one of the TLD's servers, follow that one's referral to the site's own server, and take its answer. Each
 * question gets a fresh id; the walk uses one port. A server that stays quiet is asked once more, then the walk fails.
 */
function iterate(host: Host, name: string, upstream: NonNullable<DnsServerSpec['upstream']>, processing: number, done: (rec: DnsRecordSet) => void, fail: (reason: string) => void): void {
  const sim = host.sim;
  const port = host.ephemeralPort();
  let hop = 0;
  let server = upstream.hops[0]!.server;
  let id = 0;
  let attempt = 0;
  let timer: number | undefined;
  let timerId = '';
  const ask = (): void => {
    attempt++;
    if (attempt === 1) id = host.random32() & 0xffff;
    const query = buildDnsQuery(id, name, false);
    const pk = sim.newPacket(host.id, 'dns', `DNS query: ${name} A? (asking ${server.name}${attempt > 1 ? ', retry' : ''})`);
    const pduId = sim.pdu(pk.id, query, 'dns');
    sim.emit({ type: 'app', deviceId: host.id, app: 'dns-server', action: 'dns-iterate', pduId, info: { name, server: server.name, ip: server.ip, hop, attempt } });
    sim.emit({ type: 'encapsulate', deviceId: host.id, packetId: pk.id, layer: 5, protocol: 'dns', pduId });
    host.udpSend(port, server.ip, 53, query, pk.id);
    timerId = host.newTimerId('dns');
    sim.emit({ type: 'timer:set', deviceId: host.id, timerId, kind: 'dns-retry', fireAt: sim.now + UPSTREAM_TIMEOUT });
    timer = sim.after(UPSTREAM_TIMEOUT, () => {
      sim.emit({ type: 'timer:fire', deviceId: host.id, timerId, kind: 'dns-retry' });
      if (attempt < UPSTREAM_ATTEMPTS) ask();
      else {
        host.udpUnbind(port);
        fail(`${server.name} did not answer`);
      }
    });
  };
  host.udpBind(port, 'dns', (from, data, _packetId, pduId) => {
    const msg = parseDns(data, 0);
    if (from.ip !== server.ip || from.port !== 53 || msg.id !== id || !msg.isResponse) return;
    sim.cancel(timer);
    sim.emit({ type: 'timer:cancel', deviceId: host.id, timerId, kind: 'dns-retry' });
    const ips = dnsAddresses(msg);
    const referral = dnsReferral(msg);
    if (ips.length) {
      host.udpUnbind(port);
      const ttl = msg.answers.find((a) => a.type === DNS_TYPE_A)?.ttl ?? 0;
      sim.emit({ type: 'app', deviceId: host.id, app: 'dns-server', action: 'dns-learn', pduId, info: { name, addresses: ips, ttl, server: server.name } });
      done({ ips, ttl });
      return;
    }
    if (!referral || hop + 1 >= upstream.hops.length) {
      host.udpUnbind(port);
      fail(msg.rcode ? `${server.name} answered with error ${msg.rcode}` : `${server.name} gave neither an answer nor a referral`);
      return;
    }
    // The next server: the first one the referral also gives an address for (glue). Without glue a resolver would have
    // to look the server's name up first; here it then takes the address the capture found for it.
    const next = referral.servers.find((s): s is { name: string; ip: Ip4 } => !!s.ip) ?? upstream.hops[hop + 1]!.server;
    sim.emit({ type: 'app', deviceId: host.id, app: 'dns-server', action: 'dns-referral', pduId, info: { name, zone: referral.zone, servers: referral.servers.map((s) => s.name), next: next.name, ip: next.ip } });
    hop++;
    server = next;
    attempt = 0;
    sim.after(processing, ask);
  });
  sim.after(processing, ask);
}

export function startDnsServer(host: Host, spec: DnsServerSpec): void {
  const sim = host.sim;
  // The cache starts with what the scenario says the resolver already knows; a walk through the hierarchy adds to it.
  const cache = new Map(Object.entries(spec.records).map(([n, r]) => [n.toLowerCase(), r]));
  const answer = (from: { ip: Ip4; port: number }, id: number, name: string, rec: DnsRecordSet | undefined, rcode = rec ? DNS_RCODE_OK : DNS_RCODE_NXDOMAIN): void => {
    // A name nobody knows gets an empty answer with rcode 3: "no such name" (NXDOMAIN); a walk that failed gets rcode 2.
    const resp = buildDnsResponse(
      id,
      name,
      (rec?.ips ?? []).map((ip) => ({ ip, ttl: rec?.ttl ?? 0 })),
      rcode,
    );
    const pk = sim.newPacket(host.id, 'dns', `DNS response: ${name} A ${rec?.ips.join(', ') ?? (rcode === DNS_RCODE_SERVFAIL ? '(server failure)' : '(no such name)')}`);
    const pduId = sim.pdu(pk.id, resp, 'dns');
    sim.emit({ type: 'app', deviceId: host.id, app: 'dns-server', action: 'dns-serve', pduId, info: { name, addresses: rec?.ips ?? [], from: from.ip, rcode } });
    sim.emit({ type: 'encapsulate', deviceId: host.id, packetId: pk.id, layer: 5, protocol: 'dns', pduId });
    host.udpSend(53, from.ip, from.port, resp, pk.id);
  };
  host.udpBind(53, 'dns', (from, data) => {
    const q = parseDns(data, 0);
    const name = q.questions[0]?.name ?? '';
    const rec = cache.get(name.toLowerCase());
    if (rec || !spec.upstream) {
      sim.after(spec.processing, () => answer(from, q.id, name, rec));
      return;
    }
    iterate(
      host,
      name,
      spec.upstream,
      spec.processing,
      (learned) => {
        cache.set(name.toLowerCase(), learned);
        sim.after(spec.processing, () => answer(from, q.id, name, learned));
      },
      () => sim.after(spec.processing, () => answer(from, q.id, name, undefined, DNS_RCODE_SERVFAIL)),
    );
  });
}

/** A root, TLD or authoritative server: it says what it really said on the capture day, byte for byte except the id. */
export function startDnsAuthority(host: Host, spec: DnsAuthoritySpec): void {
  const sim = host.sim;
  host.udpBind(53, 'dns', (from, data) => {
    const q = parseDns(data, 0);
    const name = q.questions[0]?.name ?? '';
    const known = spec.answers.find((a) => a.name.toLowerCase() === name.toLowerCase());
    // A name the capture did not cover gets no reply here (a real server would answer REFUSED or refer elsewhere).
    if (!known) return;
    sim.after(spec.processing, () => {
      const resp = known.response.slice();
      setU16(resp, 0, q.id);
      const msg = parseDns(resp, 0);
      const referral = dnsReferral(msg);
      const pk = sim.newPacket(host.id, 'dns', dnsSummary(msg).replace(/ 0x[0-9a-f]{4}:/, ':'));
      const pduId = sim.pdu(pk.id, resp, 'dns');
      const what: Record<string, string | string[]> = referral ? { zone: referral.zone, servers: referral.servers.map((s) => s.name) } : { addresses: dnsAddresses(msg) };
      sim.emit({ type: 'app', deviceId: host.id, app: 'dns-authority', action: 'dns-serve', pduId, info: { name, from: from.ip, ...what } });
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
        // Several sites on one server: the Host header says which one was asked for.
        const site = /^Host: (\S+)/im.exec(toAscii(received, 0, Math.min(received.length, 512)))?.[1]?.toLowerCase();
        const response = (site ? spec.responses?.[site] : undefined) ?? spec.response;
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
          const pduId = sim.pdu(msg.id, response, 'http');
          sim.emit({ type: 'app', deviceId: host.id, app: 'http-server', action: 'http-response-sent', pduId, info: { bytes: response.length } });
          sim.emit({ type: 'encapsulate', deviceId: host.id, packetId: msg.id, layer: 5, protocol: 'http', pduId });
          c.write(response, 'HTTP 200 OK');
          c.close(); // "Connection: close": the server ends its side once the response is queued
        });
      },
      onPeerClose(c) {
        c.close();
      },
    };
  });
}

import type { Ip4 } from '../bytes/addr';
import { concat, setU16, toAscii } from '../bytes/bytes';
import type { AppSpec } from '../model';
import { buildDnsQuery, buildDnsResponse, DNS_RCODE_NXDOMAIN, DNS_RCODE_OK, DNS_RCODE_SERVFAIL, DNS_TYPE_A, dnsAddresses, dnsReferral, dnsSummary, parseDns } from '../proto/dns';
import { buildMqttAck, buildMqttConnack, buildMqttConnect, buildMqttPing, buildMqttPublish, buildMqttSuback, buildMqttSubscribe, MQTT_CONNACK, MQTT_CONNECT, MQTT_PINGREQ, MQTT_PINGRESP, MQTT_PORT, MQTT_PUBACK, MQTT_PUBCOMP, MQTT_PUBLISH, MQTT_PUBREC, MQTT_PUBREL, MQTT_SUBACK, MQTT_SUBSCRIBE, takeMqtt, type MqttQos } from '../proto/mqtt';
import { buildRtp, parseRtp, RTP_PORT, RTP_PT_PCMU, RTP_SAMPLES_PER_PACKET, RTP_VERSION } from '../proto/rtp';
import { buildIcmp, ICMP_DEST_UNREACHABLE, ICMP_ECHO, ICMP_ECHO_REPLY, ICMP_HEADER_LEN, ICMP_TIME_EXCEEDED, pingData, pingTimestamp } from '../proto/icmp';
import { IPPROTO_TCP, IPPROTO_UDP } from '../proto/ipv4';
import { buildTcp, TCP_SYN } from '../proto/tcp';
import type { Host, IcmpHandler } from './Host';
import type { TcpConnection } from './tcp';
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
const PING_INTERVAL = 1; // ping sends one request a second (-i 1), and waits that long for the last reply
const TRACE_WAIT = 1; // how long traceroute waits for an answer to a probe before sending the next (Linux: -w, 5 s by default)
const TRACE_PROBES = 3; // probes per hop (-q 3)
const TRACE_PORT = 33434; // the first destination port; each probe gets the next one (-p 33434)
const TRACE_DATA_LEN = 32; // 60-byte IP packets: 20 IP + 8 UDP + 32 data, the default packet length

type PingSpec = Extract<AppSpec, { kind: 'ping' }>;
type TracerouteSpec = Extract<AppSpec, { kind: 'traceroute' }>;
type DnsServerSpec = Extract<AppSpec, { kind: 'dns-server' }>;
type DnsAuthoritySpec = Extract<AppSpec, { kind: 'dns-authority' }>;
type HttpServerSpec = Extract<AppSpec, { kind: 'http-server' }>;
type MqttClientSpec = Extract<AppSpec, { kind: 'mqtt-client' }>;
type MqttBrokerSpec = Extract<AppSpec, { kind: 'mqtt-broker' }>;
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

/** One MQTT message onto a connection, as a browser puts a request onto one. */
function mqttSend(host: Host, conn: TcpConnection, bytes: Uint8Array, label: string): string {
  const msg = host.sim.newPacket(host.id, 'stream', `${label} (application bytes)`);
  const pduId = host.sim.pdu(msg.id, bytes, 'mqtt');
  host.sim.emit({ type: 'encapsulate', deviceId: host.id, packetId: msg.id, layer: 5, protocol: 'mqtt', pduId });
  conn.write(bytes, label);
  return pduId;
}

/**
 * How long a client promises never to go quiet for. Short for the sake of the story: 60 s is usual. A client that hears no
 * PINGRESP within this long of a PINGREQ gives the connection up; a broker gives up after one and a half times this.
 */
const MQTT_KEEP_ALIVE = 3;
/** Seconds from a message arriving to an app dealing with it. */
const MQTT_APP_TIME = 0.0003;

/**
 * An MQTT client: connects to the broker and stays connected, which is how a device behind NAT can be reached at all: what
 * the broker sends comes back along a connection the device opened itself. Subscribes once it is in, publishes a reading
 * when the time comes, and goes through a QoS exchange for each message. An app keeps its session at the broker (no clean
 * session), so when a connection is lost it connects again and carries on where it was.
 */
export function startMqttClient(host: Host, spec: MqttClientSpec, mss: number): void {
  const sim = host.sim;
  /** The connection, once the broker has said yes. */
  let up: TcpConnection | undefined;
  let nextId = 1;
  /** What was to go out while there was no connection. */
  let held: { topic: string; payload: string }[] = [];
  /** QoS 2 IDs already taken in, so a copy of one would not be taken twice. */
  const taken = new Set<number>();
  const say = (conn: TcpConnection, bytes: Uint8Array, label: string): string => mqttSend(host, conn, bytes, label);
  const send = (conn: TcpConnection, topic: string, payload: string): void => {
    const pduId = say(conn, buildMqttPublish(topic, payload, spec.qos, spec.qos ? nextId++ : 0), 'MQTT PUBLISH');
    sim.emit({ type: 'app', deviceId: host.id, app: 'mqtt-client', action: 'mqtt-publish', pduId, info: { topic, value: payload, qos: spec.qos } });
  };
  const connect = (ip: string, again: boolean): void => {
    let received: Uint8Array = new Uint8Array(0);
    /** No answer to the last PINGREQ yet. */
    let silent: number | undefined;
    const lost = (conn: TcpConnection): void => {
      up = undefined;
      conn.abort();
      sim.emit({ type: 'app', deviceId: host.id, app: 'mqtt-client', action: 'mqtt-offline', info: { reason: 'no PINGRESP' } });
      connect(ip, true);
    };
    const keepAlive = (conn: TcpConnection): void => {
      if (sim.now + MQTT_KEEP_ALIVE >= spec.watchUntil) return;
      sim.after(MQTT_KEEP_ALIVE, () => {
        if (conn !== up) return;
        say(conn, buildMqttPing(MQTT_PINGREQ), 'MQTT PINGREQ');
        silent = sim.after(MQTT_KEEP_ALIVE, () => lost(conn));
      });
    };
    host.tcpConnect(ip, MQTT_PORT, { mss, wscale: 7, app: 'mqtt' }, {
      onConnected(conn) {
        say(conn, buildMqttConnect(spec.clientId, MQTT_KEEP_ALIVE, !spec.subscribe), 'MQTT CONNECT');
      },
      onData(conn, data) {
        const { messages, rest } = takeMqtt(concat(received, data));
        received = rest;
        // The program gets to it a moment after TCP has taken it in and acknowledged it.
        sim.after(MQTT_APP_TIME, () => {
          for (const m of messages) {
            if (m.type === MQTT_CONNACK) {
              up = conn;
              if (again) sim.emit({ type: 'app', deviceId: host.id, app: 'mqtt-client', action: 'mqtt-back', info: { session: m.sessionPresent ? 1 : 0 } });
              if (spec.subscribe && !m.sessionPresent) say(conn, buildMqttSubscribe(1, spec.subscribe, spec.qos), 'MQTT SUBSCRIBE');
              for (const h of held) send(conn, h.topic, h.payload);
              held = [];
              keepAlive(conn);
            }
            if (m.type === MQTT_PINGRESP) {
              sim.cancel(silent);
              keepAlive(conn);
            }
            if (m.type === MQTT_SUBACK) sim.emit({ type: 'app', deviceId: host.id, app: 'mqtt-client', action: 'mqtt-subscribed', info: { topic: spec.subscribe ?? '' } });
            // What it published: QoS 2 goes on from the broker's PUBREC, and the rest of either exchange needs no answer.
            if (m.type === MQTT_PUBREC) say(conn, buildMqttAck(MQTT_PUBREL, m.packetId), 'MQTT PUBREL');
            // What it subscribed to.
            if (m.type === MQTT_PUBREL) {
              taken.delete(m.packetId);
              say(conn, buildMqttAck(MQTT_PUBCOMP, m.packetId), 'MQTT PUBCOMP');
            }
            if (m.type === MQTT_PUBLISH) {
              if (m.qos === 1) say(conn, buildMqttAck(MQTT_PUBACK, m.packetId), 'MQTT PUBACK');
              if (m.qos === 2) say(conn, buildMqttAck(MQTT_PUBREC, m.packetId), 'MQTT PUBREC');
              if (m.qos === 2 && taken.has(m.packetId)) continue;
              if (m.qos === 2) taken.add(m.packetId);
              sim.emit({ type: 'app', deviceId: host.id, app: 'mqtt-client', action: 'mqtt-received', info: { topic: m.topic, value: m.payload } });
            }
          }
        });
      },
      onError(_conn, reason) {
        sim.emit({ type: 'app', deviceId: host.id, app: 'mqtt-client', action: 'error', info: { reason } });
      },
    });
  };
  sim.emit({ type: 'app', deviceId: host.id, app: 'mqtt-client', action: 'start', info: { to: spec.broker } });
  if (spec.publish) {
    const { topic, at } = spec.publish;
    sim.at(at, () => {
      // A room in a home, in tenths of a degree: 18.0 to 23.9.
      const payload = ((180 + (host.random32() >>> 0) % 60) / 10).toFixed(1);
      if (up) send(up, topic, payload);
      else if (spec.qos) held.push({ topic, payload });
      else sim.emit({ type: 'app', deviceId: host.id, app: 'mqtt-client', action: 'mqtt-missed', info: { topic, value: payload } });
    });
  }
  lookup(
    host,
    spec.broker,
    spec.resolver,
    (ips) => connect(ips[0]!, false),
    (reason) => sim.emit({ type: 'app', deviceId: host.id, app: 'mqtt-client', action: 'error', info: { reason } }),
  );
}

interface MqttSession {
  clientId: string;
  conn: TcpConnection | undefined;
  topic?: string;
  qos: MqttQos;
  keepAlive: number;
  heard: number;
  /** What came for it at QoS 1 or 2 while it was away. */
  waiting: { topic: string; payload: string; qos: MqttQos }[];
  nextId: number;
}

/**
 * An MQTT broker on its well-known port. A topic is matched as it is written: there are no wildcards here. Each connection
 * is a leg of its own, with its own exchange: what comes in at QoS 2 is passed on only once the sender has released it.
 */
export function startMqttBroker(host: Host, spec: MqttBrokerSpec, mss: number): void {
  const sim = host.sim;
  const sessions = new Map<string, MqttSession>();
  const deliver = (s: MqttSession, topic: string, payload: string, qos: MqttQos): void => {
    const pduId = mqttSend(host, s.conn!, buildMqttPublish(topic, payload, qos, qos ? s.nextId++ : 0), 'MQTT PUBLISH');
    sim.emit({ type: 'app', deviceId: host.id, app: 'mqtt-broker', action: 'mqtt-forward', pduId, info: { topic, value: payload, qos } });
  };
  const hand = (topic: string, payload: string, qos: MqttQos): void => {
    for (const s of sessions.values()) {
      if (s.topic !== topic) continue;
      const leg = Math.min(qos, s.qos) as MqttQos;
      if (s.conn) deliver(s, topic, payload, leg);
      else if (leg) {
        s.waiting.push({ topic, payload, qos: leg });
        sim.emit({ type: 'app', deviceId: host.id, app: 'mqtt-broker', action: 'mqtt-held', info: { topic, value: payload, client: s.clientId } });
      } else sim.emit({ type: 'app', deviceId: host.id, app: 'mqtt-broker', action: 'mqtt-missed', info: { topic, value: payload, client: s.clientId } });
    }
  };
  const watch = (s: MqttSession, conn: TcpConnection): void => {
    const wait = (s.keepAlive * 3) / 2;
    if (sim.now + wait >= spec.watchUntil + wait) return;
    sim.after(wait, () => {
      if (s.conn !== conn) return;
      if (sim.now - s.heard < wait) return watch(s, conn);
      s.conn = undefined;
      conn.abort();
      sim.emit({ type: 'app', deviceId: host.id, app: 'mqtt-broker', action: 'mqtt-offline', info: { reason: 'keep-alive ran out', client: s.clientId } });
    });
  };
  host.tcpListen(MQTT_PORT, { mss, wscale: 10, app: 'mqtt' }, (conn) => {
    let received: Uint8Array = new Uint8Array(0);
    let me: MqttSession | undefined;
    /** QoS 2 messages taken in on this connection and not yet released. */
    const unreleased = new Map<number, { topic: string; payload: string }>();
    conn.handlers = {
      onData(c, data) {
        const { messages, rest } = takeMqtt(concat(received, data));
        received = rest;
        if (me) me.heard = sim.now;
        sim.after(spec.processing, () => {
          for (const m of messages) {
            if (m.type === MQTT_CONNECT) {
              const old = sessions.get(m.clientId);
              const kept = !!old && !m.clean;
              me = kept ? old : { clientId: m.clientId, conn: undefined, qos: 0, keepAlive: m.keepAlive, heard: sim.now, waiting: [], nextId: 1 };
              sessions.set(m.clientId, me);
              me.conn = c;
              me.heard = sim.now;
              mqttSend(host, c, buildMqttConnack(kept), 'MQTT CONNACK');
              for (const w of me.waiting) deliver(me, w.topic, w.payload, w.qos);
              me.waiting = [];
              watch(me, c);
            }
            if (m.type === MQTT_SUBSCRIBE && me) {
              me.topic = m.topic;
              me.qos = m.qos;
              mqttSend(host, c, buildMqttSuback(m.packetId, m.qos), 'MQTT SUBACK');
            }
            if (m.type === MQTT_PINGREQ) mqttSend(host, c, buildMqttPing(MQTT_PINGRESP), 'MQTT PINGRESP');
            if (m.type === MQTT_PUBLISH) {
              const { topic, payload, qos, packetId } = m;
              if (qos === 2) {
                unreleased.set(packetId, { topic, payload });
                mqttSend(host, c, buildMqttAck(MQTT_PUBREC, packetId), 'MQTT PUBREC');
                continue;
              }
              if (qos === 1) mqttSend(host, c, buildMqttAck(MQTT_PUBACK, packetId), 'MQTT PUBACK');
              hand(topic, payload, qos);
            }
            if (m.type === MQTT_PUBREL) {
              const message = unreleased.get(m.packetId);
              unreleased.delete(m.packetId);
              mqttSend(host, c, buildMqttAck(MQTT_PUBCOMP, m.packetId), 'MQTT PUBCOMP');
              if (message) hand(message.topic, message.payload, 2);
            }
            if (m.type === MQTT_PUBREC) mqttSend(host, c, buildMqttAck(MQTT_PUBREL, m.packetId), 'MQTT PUBREL');
          }
        });
      },
    };
  });
}

const round = (ms: number): number => Math.round(ms * 1000) / 1000;

/** An address is used as it is, like ping and traceroute do; a name is looked up first. */
function lookup(host: Host, name: string, resolver: string | undefined, done: (ips: string[]) => void, fail: (reason: string) => void): void {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return done([name]);
  if (!resolver) return fail('no DNS resolver configured');
  resolve(host, name, resolver, done, fail);
}

/**
 * `ping -c count`, like Linux: an echo request a second, each with 56 data bytes (the time of sending, then a pattern),
 * the identifier a process id and the sequence number counting from 1. A reply's round trip is the clock on arrival less
 * the time the request carries. After the last request ping waits a second for its reply, then sums up.
 */
export function startPing(host: Host, spec: PingSpec, leased?: string): void {
  const sim = host.sim;
  sim.emit({ type: 'app', deviceId: host.id, app: 'ping', action: 'start', info: { to: spec.to, count: spec.count } });
  lookup(
    host,
    spec.to,
    spec.resolver ?? leased,
    (ips) => {
      const target = ips[0]!;
      const id = host.random32() & 0xffff;
      const rtts: number[] = [];
      let sent = 0;
      let timer: number | undefined;
      let timerId = '';
      const finish = (): void => {
        host.icmpUnlisten(listener);
        const received = rtts.length;
        const stats = received ? { minMs: Math.min(...rtts), avgMs: round(rtts.reduce((a, b) => a + b) / received), maxMs: Math.max(...rtts) } : { minMs: 0, avgMs: 0, maxMs: 0 };
        sim.emit({
          type: 'app',
          deviceId: host.id,
          app: 'ping',
          action: 'ping-done',
          info: { to: spec.to, target, sent, received, lossPct: Math.round(((sent - received) / sent) * 100), ...stats },
        });
      };
      const listener: IcmpHandler = (ip, m, bytes, _packetId, pduId) => {
        if (m.type !== ICMP_ECHO_REPLY || m.id !== id) return false;
        const stamp = pingTimestamp(bytes.subarray(m.dataStart, m.end));
        const rttMs = round((sim.now - (stamp ?? sim.now)) * 1000);
        rtts.push(rttMs);
        sim.emit({ type: 'app', deviceId: host.id, app: 'ping', action: 'ping-reply', pduId, info: { seq: m.seq ?? 0, from: ip.src, ttl: ip.ttl, bytes: m.end - m.dataStart + ICMP_HEADER_LEN, rttMs } });
        if (m.seq === spec.count) {
          sim.cancel(timer);
          sim.emit({ type: 'timer:cancel', deviceId: host.id, timerId, kind: 'ping-wait' });
          finish();
        }
        return true;
      };
      host.icmpListen(listener);
      const send = (): void => {
        const seq = ++sent;
        const msg = buildIcmp({ type: ICMP_ECHO, id, seq, data: pingData(sim.now) });
        const pk = sim.newPacket(host.id, 'icmp', `ICMP echo request · seq ${seq}`);
        const pduId = sim.pdu(pk.id, msg, 'icmp');
        sim.emit({ type: 'app', deviceId: host.id, app: 'ping', action: 'ping-request', pduId, info: { seq, to: target, id } });
        host.icmpSend(target, msg, pk.id);
        timerId = host.newTimerId('ping');
        sim.emit({ type: 'timer:set', deviceId: host.id, timerId, kind: 'ping-wait', fireAt: sim.now + PING_INTERVAL });
        timer = sim.after(PING_INTERVAL, () => {
          sim.emit({ type: 'timer:fire', deviceId: host.id, timerId, kind: 'ping-wait' });
          if (sent < spec.count) send();
          else finish();
        });
      };
      send();
    },
    (reason) => sim.emit({ type: 'app', deviceId: host.id, app: 'ping', action: 'error', info: { reason } }),
  );
}

/**
 * `traceroute`, like Linux: UDP probes from one port to ports 33434 and up, one port per probe, 60-byte packets, three
 * probes per hop, TTL 1, 2, 3 … Each router whose TTL count hits zero sends Time Exceeded back, and that is a hop; the
 * destination, with nobody on that port, sends Port Unreachable, and that is the end. The next probe goes when the
 * previous one is answered, or after a second (a real traceroute keeps up to 16 in flight and waits up to 5 s).
 */
export function startTraceroute(host: Host, spec: TracerouteSpec, leased?: string): void {
  const sim = host.sim;
  sim.emit({ type: 'app', deviceId: host.id, app: 'traceroute', action: 'start', info: { to: spec.to, maxHops: spec.maxHops } });
  lookup(
    host,
    spec.to,
    spec.resolver ?? leased,
    (ips) => {
      const target = ips[0]!;
      const port = host.ephemeralPort();
      // The socket only reserves the port: the answers come as ICMP errors about its probes, not as datagrams.
      host.udpBind(port, undefined, () => {});
      // traceroute fills its probes with 0x40, 0x41, … ("@ABCDEFG…").
      const data = Uint8Array.from({ length: TRACE_DATA_LEN }, (_, i) => 0x40 + (i & 0x3f));
      const sentAt = new Map<number, number>();
      const path: string[] = [];
      let ttl = 1;
      let probe = 0;
      let n = 0;
      let reached = false;
      let timer: number | undefined;
      let timerId = '';
      const finish = (): void => {
        host.icmpUnlisten(listener);
        host.udpUnbind(port);
        sim.emit({ type: 'app', deviceId: host.id, app: 'traceroute', action: 'trace-done', info: { to: spec.to, target, hops: ttl, reached: reached ? 1 : 0, path } });
      };
      const sendProbe = (): void => {
        const dport = TRACE_PORT + n++;
        const pk = sim.newPacket(host.id, 'probe', `traceroute probe · TTL ${ttl} · ${probe + 1}/${TRACE_PROBES}`);
        sentAt.set(dport, sim.now);
        sim.emit({ type: 'app', deviceId: host.id, app: 'traceroute', action: 'trace-probe', info: { ttl, probe: probe + 1, port: dport, to: target } });
        host.udpSend(port, target, dport, data, pk.id, ttl);
        timerId = host.newTimerId('trace');
        sim.emit({ type: 'timer:set', deviceId: host.id, timerId, kind: 'trace-wait', fireAt: sim.now + TRACE_WAIT });
        timer = sim.after(TRACE_WAIT, () => {
          sim.emit({ type: 'timer:fire', deviceId: host.id, timerId, kind: 'trace-wait' });
          advance();
        });
      };
      const advance = (): void => {
        if (++probe === TRACE_PROBES) {
          if (reached || ttl === spec.maxHops) return finish();
          probe = 0;
          ttl++;
        }
        sendProbe();
      };
      const listener: IcmpHandler = (ip, m, _bytes, _packetId, pduId) => {
        const q = m.quoted;
        // Mine: an error about a UDP datagram from my port to the target.
        if (!q || q.ip.protocol !== IPPROTO_UDP || q.srcPort !== port || q.ip.dst !== target) return false;
        if (m.type !== ICMP_TIME_EXCEEDED && m.type !== ICMP_DEST_UNREACHABLE) return false;
        const at = sentAt.get(q.dstPort);
        // The quoted destination port says which probe; an answer to one already given up on is noted no further.
        if (at === undefined || q.dstPort !== TRACE_PORT + n - 1) return true;
        if (m.type === ICMP_DEST_UNREACHABLE) reached = true;
        if (path[path.length - 1] !== ip.src) path.push(ip.src);
        sim.emit({ type: 'app', deviceId: host.id, app: 'traceroute', action: 'trace-hop', pduId, info: { ttl, probe: probe + 1, from: ip.src, rttMs: round((sim.now - at) * 1000), reached: reached ? 1 : 0 } });
        sim.cancel(timer);
        sim.emit({ type: 'timer:cancel', deviceId: host.id, timerId, kind: 'trace-wait' });
        advance();
        return true;
      };
      host.icmpListen(listener);
      sendProbe();
    },
    (reason) => sim.emit({ type: 'app', deviceId: host.id, app: 'traceroute', action: 'error', info: { reason } }),
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

/** Something the server runs besides its web server. It only has to be there: a port with a listener is an open port. */
export function startTcpService(host: Host, port: number, mss: number): void {
  host.tcpListen(port, { mss, wscale: 10, app: 'http' }, () => {});
}

/** How close together a bot's opening burst goes. */
const BURST_GAP = 0.001;

/** A bot: junk datagrams at a server, an opening burst and then one every `gap` seconds, whatever happens to them. */
export function startFlood(host: Host, spec: Extract<AppSpec, { kind: 'flood' }>): void {
  const sim = host.sim;
  sim.emit({ type: 'app', deviceId: host.id, app: 'flood', action: 'flood-start', info: { to: spec.to, packets: spec.packets } });
  const port = host.ephemeralPort();
  const junk = Uint8Array.from({ length: spec.bytes }, () => host.random32() & 0xff);
  for (let i = 0; i < spec.packets; i++) {
    sim.after(Math.max(0, i - spec.burst) * spec.gap + Math.min(i, spec.burst) * BURST_GAP, () => {
      const pk = sim.newPacket(host.id, 'flood', `junk ${i + 1}/${spec.packets}`);
      host.udpSend(port, spec.to, spec.port, junk, pk.id);
    });
  }
}

/**
 * A SYN scan: a SYN made by hand to each port, one every `gap` seconds. A SYN-ACK means something answered on that port, a
 * reset that nothing did. The host's own TCP knows nothing of these SYNs, so it resets any SYN-ACK by itself, and the hello
 * is never finished.
 */
export function startPortScan(host: Host, spec: Extract<AppSpec, { kind: 'port-scan' }>): void {
  const sim = host.sim;
  sim.emit({ type: 'app', deviceId: host.id, app: 'port-scan', action: 'scan-start', info: { to: spec.to, ports: spec.ports.map(String) } });
  const port = host.ephemeralPort();
  const heard = new Set<number>();
  host.tcpWatcher = (from, seg, pduId) => {
    // A door that was reset late says the same thing again: it is only news once.
    if (from !== spec.to || seg.dstPort !== port || heard.has(seg.srcPort)) return;
    heard.add(seg.srcPort);
    sim.emit({ type: 'app', deviceId: host.id, app: 'port-scan', action: 'scan-port', pduId, info: { port: seg.srcPort, open: seg.flags & TCP_SYN ? 1 : 0 } });
  };
  spec.ports.forEach((dst, i) => {
    sim.after(i * spec.gap, () => {
      const seg = buildTcp({ srcPort: port, dstPort: dst, seq: host.random32(), ack: 0, flags: TCP_SYN, window: 1024, options: [{ kind: 'mss', mss: 1460 }] }, new Uint8Array(0), host.ip, spec.to);
      const pk = sim.newPacket(host.id, 'tcp', `SYN to port ${dst}`, { tcp: { connId: `${host.id}:${port}-${spec.to}:${dst}`, relSeq: 0, relAck: 0, len: 0, flags: TCP_SYN } });
      host.ipOutput(IPPROTO_TCP, spec.to, seg, pk.id, true);
    });
  });
}

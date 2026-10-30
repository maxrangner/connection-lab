import type { LayerPdu, PduSnapshot, SimEvent, SimResult } from '../sim';

/**
 * The simple story: one request card goes to the server and one page card comes back.
 * Everything here is read from the real event log and PDU snapshots; nothing is invented,
 * we only leave things out (ARP, DNS, handshake, ACKs, teardown, TTL, ports).
 */

export type Wrap = 'tcp' | 'ip' | 'eth';

export type Step =
  | { kind: 'appear'; device: string }
  | { kind: 'wrap'; device: string; layer: Wrap }
  | { kind: 'unwrap'; device: string; layer: Wrap }
  | { kind: 'nat'; device: string; which: 'from' | 'to'; before: string; after: string }
  | { kind: 'travel'; from: string; to: string }
  | { kind: 'read'; device: string };

export interface Trip {
  /** "GET /" or "200 OK". */
  card: string;
  /** Application bytes inside the TCP segment. */
  dataBytes: number;
  /** Header bytes per wrap, and the Ethernet trailer (FCS). */
  header: Record<Wrap, number>;
  trailer: number;
  /** IP addresses as the sender wrote them. */
  from: string;
  to: string;
  steps: Step[];
}

export interface Story {
  /** Devices in the order the request visits them. */
  devices: { id: string; label: string; kind: string }[];
  request: Trip;
  response: Trip;
  /** The page's <title>, shown on the laptop at the end. */
  pageTitle: string;
}

const WRAP_OF_LAYER: Record<number, Wrap | undefined> = { 4: 'tcp', 3: 'ip', 2: 'eth' };

function layer(s: PduSnapshot, protocol: LayerPdu['protocol']): LayerPdu | undefined {
  return s.layers.find((l) => l.protocol === protocol);
}

function field(l: LayerPdu | undefined, key: string): string {
  return l?.fields.find((f) => f.key === key)?.display ?? '';
}

/** "HTTP GET / HTTP/1.1" → "GET /", "HTTP HTTP/1.1 200 OK" → "200 OK". */
export function cardLabel(summary: string): string {
  return summary.replace(/^HTTP /, '').replace(/ ?HTTP\/1\.[01] ?/, '').trim();
}

function trip(r: SimResult, action: 'http-request-sent' | 'http-response-sent'): Trip {
  const ev = r.events;
  const start = ev.findIndex((e) => e.type === 'app' && e.action === action);
  const app = ev[start];
  if (!app || app.type !== 'app') throw new Error(`no ${action} event`);
  const seg = ev.find((e, i) => i > start && e.type === 'encapsulate' && e.deviceId === app.deviceId && e.layer === 4);
  if (!seg || seg.type !== 'encapsulate') throw new Error('no TCP segment');
  const packetId = seg.packetId;

  const steps: Step[] = [{ kind: 'appear', device: app.deviceId }];
  let frame: PduSnapshot | undefined;
  let done = false;
  for (const e of ev.slice(start) as SimEvent[]) {
    if (done) break;
    if (!('packetId' in e) || e.packetId !== packetId) continue;
    switch (e.type) {
      case 'encapsulate': {
        const w = WRAP_OF_LAYER[e.layer];
        if (w) steps.push({ kind: 'wrap', device: e.deviceId, layer: w });
        if (w === 'eth') frame ??= r.pdus.get(e.pduId);
        break;
      }
      case 'decapsulate': {
        const w = WRAP_OF_LAYER[e.layer];
        if (w) steps.push({ kind: 'unwrap', device: e.deviceId, layer: w });
        if (w === 'tcp') {
          steps.push({ kind: 'read', device: e.deviceId });
          done = true;
        }
        break;
      }
      case 'nat:translate':
        steps.push({
          kind: 'nat',
          device: e.deviceId,
          // Going out NAT rewrites the source; coming back in it rewrites the destination.
          which: e.direction === 'out' ? 'from' : 'to',
          before: e.before.ip,
          after: e.after.ip,
        });
        break;
      case 'tx':
        steps.push({ kind: 'travel', from: e.fromDevice, to: e.toDevice });
        break;
    }
  }
  if (!frame) throw new Error('no Ethernet frame');

  const eth = layer(frame, 'ethernet')!;
  const ip = layer(frame, 'ipv4')!;
  const tcp = layer(frame, 'tcp')!;
  const http = layer(frame, 'http');
  return {
    card: http ? cardLabel(http.summary) : (r.packets.get(packetId)?.label ?? ''),
    dataBytes: tcp.payloadEnd - tcp.headerEnd,
    header: { eth: eth.headerEnd - eth.start, ip: ip.headerEnd - ip.start, tcp: tcp.headerEnd - tcp.start },
    trailer: eth.end - eth.payloadEnd,
    from: field(ip, 'ipv4.src'),
    to: field(ip, 'ipv4.dst'),
    steps,
  };
}

function pageTitle(r: SimResult): string {
  const got = r.events.find((e) => e.type === 'app' && e.action === 'http-response-received');
  const pdu = got && 'pduId' in got && got.pduId ? r.pdus.get(got.pduId) : undefined;
  if (!pdu) return 'example.com';
  const text = new TextDecoder('latin1').decode(pdu.bytes);
  return /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() || 'example.com';
}

export function buildStory(r: SimResult): Story {
  const request = trip(r, 'http-request-sent');
  const response = trip(r, 'http-response-sent');
  const ids: string[] = [];
  for (const s of request.steps) {
    const id = s.kind === 'travel' ? s.to : s.device;
    if (!ids.includes(id)) ids.push(id);
  }
  const devices = ids.map((id) => {
    const d = r.scenario.devices.find((x) => x.id === id)!;
    return { id, label: d.label, kind: d.kind };
  });
  return { devices, request, response, pageTitle: pageTitle(r) };
}

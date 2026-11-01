import type { Ip4, Mac } from '../bytes/addr';
import type { LayerNum, Protocol } from '../proto/types';

export type TimerKind = 'tcp-rto' | 'tcp-timewait' | 'dns-retry' | 'arp-retry' | 'dhcp-retry' | 'ping-wait' | 'trace-wait';

export type TcpState =
  | 'CLOSED'
  | 'LISTEN'
  | 'SYN_SENT'
  | 'SYN_RCVD'
  | 'ESTABLISHED'
  | 'FIN_WAIT_1'
  | 'FIN_WAIT_2'
  | 'CLOSING'
  | 'TIME_WAIT'
  | 'CLOSE_WAIT'
  | 'LAST_ACK';

export type DropReason =
  | 'fault' // lost in transit (user or random fault injection)
  | 'cut' // the cable it was sent on has been cut
  | 'queue-full' // the port's transmit buffer had no room left (tail drop); it never reached the cable
  | 'interference' // a Wi-Fi frame (data or Ack) arrived damaged by noise on the air: the receiver throws it away
  | 'duplicate-frame' // a Wi-Fi frame sent again after its Ack was lost: the receiver already has this sequence number
  | 'retry-limit' // the Wi-Fi sender tried the frame dot11ShortRetryLimit times with no Ack and gives up; upper layers never hear of it
  | 'not-for-me' // destination MAC/IP does not match
  | 'bad-checksum'
  | 'ttl-expired'
  | 'no-route'
  | 'no-socket'
  | 'no-nat-mapping'
  | 'arp-failed';

/** For ICMP there are no ports: an echo's identifier stands in for the port on both sides, and `remote.port` is 0. */
export interface NatEntry {
  proto: 'udp' | 'tcp' | 'icmp';
  inside: { ip: Ip4; port: number };
  outside: { ip: Ip4; port: number };
  remote: { ip: Ip4; port: number };
}

export type AppAction =
  | 'start' // user asked the browser for a URL
  | 'dns-lookup' // stub resolver sends a question
  | 'dns-answer' // client got the addresses
  | 'dns-cache-hit' // client still had the address cached, no lookup needed
  | 'dns-serve' // resolver looked up its cache and answers; a root/TLD/authoritative server answers too
  | 'dns-iterate' // resolver has no cached answer and asks a server of the hierarchy (RD=0)
  | 'dns-referral' // resolver was told which servers to ask next
  | 'dns-learn' // resolver got the authoritative answer and caches it
  | 'dhcp-discover' // client with no address asks the whole link for one
  | 'dhcp-offer' // server proposes an address and a lease
  | 'dhcp-request' // client asks for the offered address
  | 'dhcp-ack' // server grants the lease
  | 'dhcp-configured' // client set its address, routes and resolver from the lease
  | 'http-request-sent'
  | 'http-request-received'
  | 'http-response-sent'
  | 'http-response-received'
  | 'rtp-received' // a voice packet came in order: it is played
  | 'mqtt-subscribed' // an app is told it will hear of a topic from now on
  | 'mqtt-publish' // a client sends a message to a topic
  | 'mqtt-forward' // the broker hands a copy to a subscriber
  | 'mqtt-received' // an app got a message for its topic
  | 'mqtt-held' // the broker keeps a message for a client that is away, until it comes back
  | 'mqtt-missed' // nobody will ever send this message to a client that was away: QoS 0
  | 'mqtt-offline' // a client or the broker gave up on a silent connection
  | 'mqtt-back' // a client is connected again
  | 'rtp-gap' // a sequence number was skipped: the packet is lost and nothing asks for it again; silence is played instead
  | 'rtp-late' // a packet from before what has already been played, or one seen already: thrown away
  | 'call-done' // both clips are through: the call hangs up
  | 'ping-request' // ping sends an echo request (seq, to)
  | 'ping-reply' // and hears the reply (seq, from, ttl, rttMs)
  | 'ping-done' // the summary line: sent, received, lossPct, minMs, avgMs, maxMs
  | 'trace-probe' // traceroute sends a UDP probe (ttl, probe, port)
  | 'trace-hop' // a router's Time Exceeded, or the destination's Port Unreachable, answered one (ttl, probe, from, rttMs, reached)
  | 'trace-done' // the path: hops, the addresses that answered, whether the destination was reached
  | 'overheard' // a radio picked a frame out of the air: pduId is the frame
  | 'flood-start' // a bot starts sending junk (to, packets)
  | 'scan-start' // a scan starts (to, ports)
  | 'scan-port' // a scan heard about a port (port, open)
  | 'done'
  | 'error';

/** Everything that can happen, in the order it happens. Narration text is derived in the UI. */
export type SimEventPayload =
  | { type: 'app'; deviceId: string; app: 'browser' | 'mqtt-client' | 'mqtt-broker' | 'dns-client' | 'dns-server' | 'dns-authority' | 'dhcp-client' | 'dhcp-server' | 'http-server' | 'voice-call' | 'voice-peer' | 'ping' | 'traceroute' | 'wifi-listener' | 'flood' | 'port-scan'; action: AppAction; pduId?: string; info?: Record<string, string | number | string[]> }
  | { type: 'encapsulate'; deviceId: string; packetId: string; layer: LayerNum; protocol: Protocol; pduId: string }
  | { type: 'decapsulate'; deviceId: string; packetId: string; layer: LayerNum; protocol: Protocol; pduId: string }
  | { type: 'arp:miss'; deviceId: string; ip: Ip4; packetId: string }
  | { type: 'arp:hit'; deviceId: string; ip: Ip4; mac: Mac; packetId: string }
  | { type: 'arp:learn'; deviceId: string; ip: Ip4; mac: Mac }
  | { type: 'route'; deviceId: string; packetId: string; dst: Ip4; route: string; nextHop: Ip4; outIface: string }
  | { type: 'forward'; deviceId: string; packetId: string; ttlBefore: number; ttlAfter: number; pduId: string }
  | { type: 'nat:add'; deviceId: string; entry: NatEntry }
  | { type: 'nat:translate'; deviceId: string; packetId: string; direction: 'out' | 'in'; before: { ip: Ip4; port: number }; after: { ip: Ip4; port: number }; pduId: string }
  /** A whole IP packet went into (wrap) or came out of (unwrap) the VPN tunnel; the addresses are the ones it shows now. */
  | { type: 'tunnel:wrap'; deviceId: string; packetId: string; pduId: string; addr: { src: Ip4; dst: Ip4 } }
  | { type: 'tunnel:unwrap'; deviceId: string; packetId: string; pduId: string; addr: { src: Ip4; dst: Ip4 } }
  /**
   * The port was busy, so the frame went into its transmit buffer (only on a link with a finite `queue`): how many frames
   * were waiting ahead of it and how long it waits before its `tx` starts (`tx.start - t`).
   */
  | { type: 'queue'; deviceId: string; iface: string; linkId: string; packetId: string; frameId: string; depth: number; wait: number }
  | { type: 'tx'; linkId: string; fromDevice: string; fromIface: string; toDevice: string; toIface: string; packetId: string; frameId: string; start: number; txEnd: number; arrive: number; wireBytes: number }
  /**
   * Wi-Fi on a noisy link: no Ack came within the Ack timeout, so the sender sends the same frame again (`frameId` is the
   * new copy, with the Retry bit set) after `backoff` seconds (slot × a random count up to the contention window); `attempt`
   * counts the retries, 1 first.
   */
  | { type: 'wifi:retry'; deviceId: string; linkId: string; packetId: string; frameId: string; attempt: number; backoff: number }
  /** Wi-Fi on a noisy link: the sender heard the Ack for its frame (`frameId`: the copy that was acknowledged). */
  | { type: 'wifi:ack'; deviceId: string; linkId: string; packetId: string; frameId: string }
  | { type: 'rx'; deviceId: string; iface: string; linkId: string; packetId: string; frameId: string }
  | { type: 'drop'; packetId: string; reason: DropReason; deviceId?: string; linkId?: string; frameId?: string }
  | { type: 'timer:set'; deviceId: string; timerId: string; kind: TimerKind; fireAt: number; connId?: string }
  | { type: 'timer:cancel'; deviceId: string; timerId: string; kind: TimerKind }
  | { type: 'timer:fire'; deviceId: string; timerId: string; kind: TimerKind }
  | { type: 'tcp:state'; deviceId: string; connId: string; from: TcpState; to: TcpState }
  | { type: 'tcp:retransmit'; deviceId: string; connId: string; packetId: string; originalPacketId: string; /** Why: its timer ran out, duplicate ACKs told it, it is catching up after either, or the other side asked again. */ cause: 'rto' | 'fast' | 'recovery' | 'dup-syn'; rto: number }
  | { type: 'tcp:dup-ack'; deviceId: string; connId: string; count: number; packetId: string }
  | { type: 'tcp:ooo'; deviceId: string; connId: string; packetId: string; seq: number; len: number }
  | { type: 'tcp:duplicate'; deviceId: string; connId: string; packetId: string }
  | { type: 'tcp:deliver'; deviceId: string; connId: string; packetId: string; bytes: number; totalDelivered: number }
  | { type: 'tcp:rtt'; deviceId: string; connId: string; sample: number; srtt: number; rto: number };

export type SimEventType = SimEventPayload['type'];

/** Sim time in seconds and a total-order sequence number. */
export type SimEvent = SimEventPayload & { t: number; seq: number };

export type EventOf<T extends SimEventType> = Extract<SimEvent, { type: T }>;

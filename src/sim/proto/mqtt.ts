import { ascii, ByteWriter, concat, hex, toAscii, u16, u8 } from '../bytes/bytes';
import { bitField, FieldList, PROTOCOL_LAYER, type LayerPdu } from './types';

/**
 * MQTT 3.1.1 (OASIS, 2014), the small publish/subscribe protocol of sensors and smart homes, over TCP. Nobody asks anybody
 * for anything: a client connects to a broker and stays connected, publishes messages to a topic, and the broker hands a
 * copy to every client subscribed to it. Every message starts with a one-byte type and flags, then the "remaining length":
 * how many bytes follow, in 1 to 4 bytes, 7 bits each, the top bit saying another comes.
 */
export const MQTT_PORT = 1883;
const MQTT_LEVEL = 4; // 3.1.1
const CLEAN_SESSION = 0x02;

export const MQTT_CONNECT = 1;
export const MQTT_CONNACK = 2;
export const MQTT_PUBLISH = 3;
export const MQTT_SUBSCRIBE = 8;
export const MQTT_SUBACK = 9;

const TYPE_NAMES: Record<number, string> = {
  [MQTT_CONNECT]: 'CONNECT',
  [MQTT_CONNACK]: 'CONNACK',
  [MQTT_PUBLISH]: 'PUBLISH',
  [MQTT_SUBSCRIBE]: 'SUBSCRIBE',
  [MQTT_SUBACK]: 'SUBACK',
};

const string = (s: string): Uint8Array => new ByteWriter().u16(s.length).bytes(ascii(s)).toBytes();

function remainingLength(n: number): number[] {
  const out: number[] = [];
  do {
    const digit = n % 128;
    n = Math.floor(n / 128);
    out.push(n > 0 ? digit | 0x80 : digit);
  } while (n > 0);
  return out;
}

function message(type: number, flags: number, body: Uint8Array): Uint8Array {
  const w = new ByteWriter().u8((type << 4) | flags);
  for (const d of remainingLength(body.length)) w.u8(d);
  return w.bytes(body).toBytes();
}

/** "I am this client": a clean session, and how many seconds may pass between messages before the broker gives up on it. */
export function buildMqttConnect(clientId: string, keepAlive: number): Uint8Array {
  return message(MQTT_CONNECT, 0, new ByteWriter().bytes(string('MQTT')).u8(MQTT_LEVEL).u8(CLEAN_SESSION).u16(keepAlive).bytes(string(clientId)).toBytes());
}

/** "Connection accepted": no session kept from before, return code 0. */
export function buildMqttConnack(): Uint8Array {
  return message(MQTT_CONNACK, 0, new Uint8Array([0, 0]));
}

/** "Send me what is published to this topic", asking for QoS 0. The flags are fixed at 2 by the standard. */
export function buildMqttSubscribe(packetId: number, topic: string): Uint8Array {
  return message(MQTT_SUBSCRIBE, 2, new ByteWriter().u16(packetId).bytes(string(topic)).u8(0).toBytes());
}

/** "Subscribed", at QoS 0. */
export function buildMqttSuback(packetId: number): Uint8Array {
  return message(MQTT_SUBACK, 0, new ByteWriter().u16(packetId).u8(0).toBytes());
}

/** A message for a topic at QoS 0: sent once and not acknowledged by MQTT itself. TCP is what gets it there. */
export function buildMqttPublish(topic: string, payload: string): Uint8Array {
  return message(MQTT_PUBLISH, 0, concat(string(topic), ascii(payload)));
}

interface FixedHeader {
  type: number;
  flags: number;
  /** Bytes after the fixed header. */
  length: number;
  /** Where they start. */
  body: number;
}

/** The fixed header at `o`, or nothing if it has not all arrived. */
function fixedHeader(b: Uint8Array, o: number, end: number): FixedHeader | null {
  let length = 0;
  for (let i = 0; i < 4; i++) {
    if (o + 1 + i >= end) return null;
    const d = u8(b, o + 1 + i);
    length += (d & 0x7f) * 128 ** i;
    if (!(d & 0x80)) return { type: u8(b, o) >> 4, flags: u8(b, o) & 0x0f, length, body: o + 2 + i };
  }
  throw new Error('MQTT remaining length runs past four bytes');
}

export type MqttMessage =
  | { type: typeof MQTT_CONNECT; clientId: string; keepAlive: number }
  | { type: typeof MQTT_CONNACK }
  | { type: typeof MQTT_PUBLISH; topic: string; payload: string }
  | { type: typeof MQTT_SUBSCRIBE; packetId: number; topic: string }
  | { type: typeof MQTT_SUBACK; packetId: number };

const readString = (b: Uint8Array, o: number): string => toAscii(b, o + 2, o + 2 + u16(b, o));

function parse(b: Uint8Array, h: FixedHeader, end: number): MqttMessage {
  const o = h.body;
  switch (h.type) {
    case MQTT_CONNECT:
      return { type: MQTT_CONNECT, clientId: readString(b, o + 10), keepAlive: u16(b, o + 8) };
    case MQTT_CONNACK:
      return { type: MQTT_CONNACK };
    case MQTT_PUBLISH:
      return { type: MQTT_PUBLISH, topic: readString(b, o), payload: toAscii(b, o + 2 + u16(b, o), end) };
    case MQTT_SUBSCRIBE:
      return { type: MQTT_SUBSCRIBE, packetId: u16(b, o), topic: readString(b, o + 2) };
    case MQTT_SUBACK:
      return { type: MQTT_SUBACK, packetId: u16(b, o) };
    default:
      throw new Error(`MQTT message type ${h.type} is not used here`);
  }
}

/** TCP is a stream: this takes the whole messages off the front of what has arrived, and leaves the rest for later. */
export function takeMqtt(b: Uint8Array): { messages: MqttMessage[]; rest: Uint8Array } {
  const messages: MqttMessage[] = [];
  let o = 0;
  for (;;) {
    const h = o < b.length ? fixedHeader(b, o, b.length) : null;
    if (!h || h.body + h.length > b.length) return { messages, rest: b.subarray(o) };
    messages.push(parse(b, h, h.body + h.length));
    o = h.body + h.length;
  }
}

export function describeMqtt(b: Uint8Array, o: number, end: number): LayerPdu {
  const h = fixedHeader(b, o, end)!;
  const msgEnd = Math.min(end, h.body + h.length);
  const name = TYPE_NAMES[h.type] ?? `type ${h.type}`;
  const m = parse(b, h, msgEnd);
  const f = new FieldList();
  f.add('mqtt.header', 'Message type', o, 1, `${name} (${hex(u8(b, o), 2)})`, 'key', 'The first byte: the top four bits say what kind of message this is, the bottom four are flags for it.', {
    children: [
      bitField('mqtt.type', 'Type', o, 1, 0, 4, h.type, 'detail', `${h.type} is ${name}.`),
      bitField('mqtt.flags', 'Flags', o, 1, 4, 4, h.flags, 'detail', h.type === MQTT_SUBSCRIBE ? 'The standard fixes these at 2 for SUBSCRIBE.' : h.type === MQTT_PUBLISH ? 'Duplicate, QoS and Retain. All 0: sent once, nobody confirms it, and the broker keeps no copy for later.' : 'Not used for this message: always 0.'),
    ],
  });
  f.add('mqtt.length', 'Remaining length', o + 1, h.body - o - 1, `${h.length} bytes`, 'detail', 'How many bytes follow, so a receiver can find where this message ends in the TCP stream.');
  let headerEnd = msgEnd;
  const v = h.body;
  switch (m.type) {
    case MQTT_CONNECT:
      f.add('mqtt.protocol', 'Protocol name', v, 6, 'MQTT', 'detail', 'Says at once that this really is MQTT, not something else that found the port.');
      f.add('mqtt.level', 'Protocol level', v + 6, 1, `${u8(b, v + 6)} (3.1.1)`, 'detail', 'Which version of MQTT the client speaks.');
      f.add('mqtt.connectFlags', 'Connect flags', v + 7, 1, hex(u8(b, v + 7), 2), 'detail', 'Clean session: forget anything the broker kept for this client from before. No user name, no password, no last will.');
      f.add('mqtt.keepAlive', 'Keep alive', v + 8, 2, `${m.keepAlive} s`, 'key', 'The client promises to say something this often, so the broker can tell a quiet client from a dead one.');
      f.add('mqtt.clientId', 'Client ID', v + 10, msgEnd - v - 10, m.clientId, 'key', 'Who this is. The broker keeps one connection per client ID.');
      break;
    case MQTT_CONNACK:
      f.add('mqtt.ackFlags', 'Session present', v, 1, u8(b, v), 'detail', 'Nothing was kept from an earlier session: the client asked for a clean start.');
      f.add('mqtt.returnCode', 'Return code', v + 1, 1, `${u8(b, v + 1)} (accepted)`, 'key', '0 means the broker accepted the connection.');
      break;
    case MQTT_PUBLISH: {
      const after = v + 2 + m.topic.length;
      f.add('mqtt.topic', 'Topic', v, 2 + m.topic.length, m.topic, 'key', 'The address of a message: not who it is for, but what it is about. The broker sends it to whoever subscribed to this.');
      f.add('mqtt.payload', 'Message', after, msgEnd - after, m.payload, 'key', 'The message itself. MQTT does not care what is in it. Here it is the reading, as plain text anyone on the line can read.');
      headerEnd = after;
      break;
    }
    case MQTT_SUBSCRIBE:
      f.add('mqtt.packetId', 'Packet ID', v, 2, m.packetId, 'detail', 'The broker repeats this in its SUBACK, so the client knows which request was answered.');
      f.add('mqtt.topic', 'Topic', v + 2, 2 + m.topic.length, m.topic, 'key', 'What this client wants to hear about. It says nothing about who publishes it.');
      f.add('mqtt.qos', 'QoS asked for', msgEnd - 1, 1, u8(b, msgEnd - 1), 'detail', '0: send it once, with no confirmation from MQTT.');
      break;
    case MQTT_SUBACK:
      f.add('mqtt.packetId', 'Packet ID', v, 2, m.packetId, 'detail', 'The ID of the SUBSCRIBE this answers.');
      f.add('mqtt.returnCode', 'Return code', v + 2, 1, `${u8(b, v + 2)} (QoS 0 granted)`, 'key', 'Subscribed, at this QoS. A value of 128 would have meant refused.');
      break;
  }
  const detail = m.type === MQTT_PUBLISH ? ` ${m.topic}: ${m.payload}` : m.type === MQTT_SUBSCRIBE ? ` ${m.topic}` : m.type === MQTT_CONNECT ? ` ${m.clientId}` : '';
  return { protocol: 'mqtt', layer: PROTOCOL_LAYER.mqtt, start: o, headerEnd, payloadEnd: msgEnd, end: msgEnd, summary: `MQTT ${name}${detail}`, fields: f.list };
}

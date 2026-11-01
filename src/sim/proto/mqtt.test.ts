import { describe, expect, it } from 'vitest';
import { buildMqttConnack, buildMqttConnect, buildMqttPublish, buildMqttSuback, buildMqttSubscribe, describeMqtt, MQTT_CONNACK, MQTT_PUBLISH, takeMqtt } from './mqtt';

const bytes = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

describe('MQTT 3.1.1 messages, byte for byte', () => {
  it('CONNECT', () => {
    // Fixed header, "MQTT", level 4, clean session, keep alive 60, client ID "s".
    expect(bytes(buildMqttConnect('s', 60))).toBe('10 0d 00 04 4d 51 54 54 04 02 00 3c 00 01 73');
  });

  it('CONNACK', () => {
    expect(bytes(buildMqttConnack())).toBe('20 02 00 00');
  });

  it('SUBSCRIBE has its flags fixed at 2', () => {
    expect(bytes(buildMqttSubscribe(1, 'a/b'))).toBe('82 08 00 01 00 03 61 2f 62 00');
  });

  it('SUBACK', () => {
    expect(bytes(buildMqttSuback(1))).toBe('90 03 00 01 00');
  });

  it('PUBLISH at QoS 0 has no packet ID', () => {
    expect(bytes(buildMqttPublish('a/b', 'hi'))).toBe('30 07 00 03 61 2f 62 68 69');
  });

  it('a length of 128 or more takes a second byte, 7 bits at a time, lowest first', () => {
    const b = buildMqttPublish('t', 'x'.repeat(300));
    // 303 bytes follow: 303 = 47 + 2 × 128.
    expect(bytes(b.subarray(0, 3))).toBe('30 af 02');
    expect(takeMqtt(b).messages).toEqual([{ type: MQTT_PUBLISH, topic: 't', payload: 'x'.repeat(300) }]);
  });
});

describe('reading a stream', () => {
  const a = buildMqttPublish('a/b', 'hi');
  const b = buildMqttConnack();
  const both = new Uint8Array([...a, ...b]);

  it('takes each message off a stream that holds two', () => {
    const { messages, rest } = takeMqtt(both);
    expect(messages.map((m) => m.type)).toEqual([MQTT_PUBLISH, MQTT_CONNACK]);
    expect(rest).toHaveLength(0);
  });

  it('leaves half a message for when the rest arrives, wherever it was split', () => {
    for (let cut = 0; cut < a.length; cut++) {
      const { messages, rest } = takeMqtt(a.subarray(0, cut));
      expect(messages).toEqual([]);
      expect(rest).toHaveLength(cut);
    }
  });
});

describe('describing', () => {
  const all = [buildMqttConnect('sensor', 60), buildMqttConnack(), buildMqttSubscribe(1, 'a/b'), buildMqttSuback(1), buildMqttPublish('a/b', '21.5')];

  it('says what each is', () => {
    expect(all.map((b) => describeMqtt(b, 0, b.length).summary)).toEqual(['MQTT CONNECT sensor', 'MQTT CONNACK', 'MQTT SUBSCRIBE a/b', 'MQTT SUBACK', 'MQTT PUBLISH a/b: 21.5']);
  });

  it('every field points inside the message and explains itself', () => {
    for (const b of all) {
      const fields = describeMqtt(b, 0, b.length).fields.flatMap((f) => [f, ...(f.children ?? [])]);
      for (const f of fields) {
        expect(f.explain.length).toBeGreaterThan(10);
        expect(f.offset + f.length).toBeLessThanOrEqual(b.length);
      }
    }
  });

  it('finds the topic and the message at their real offsets', () => {
    const b = buildMqttPublish('a/b', '21.5');
    const pdu = describeMqtt(b, 0, b.length);
    const message = pdu.fields.find((f) => f.key === 'mqtt.payload')!;
    expect(new TextDecoder().decode(b.subarray(message.offset, message.offset + message.length))).toBe('21.5');
    expect(new TextDecoder().decode(b.subarray(pdu.headerEnd, pdu.payloadEnd))).toBe('21.5');
  });
});

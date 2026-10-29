import { describe, expect, it } from 'vitest';
import { fetchWebPage, runScenario } from '../../sim';
import { machineFor, machinesFor } from '../iso/machines/Machine';
import { SpeechWriter } from './speech';

describe('speech', () => {
  it('every event is either silent or spoken by a machine that exists on that device', () => {
    for (const [mss, loss, seed] of [
      [1460, 0, 1],
      [536, 0.15, 4],
      [536, 0.3, 8],
    ] as const) {
      const r = runScenario(fetchWebPage({ mss }), { seed, faults: { randomLoss: loss, manual: [] } });
      const w = new SpeechWriter(r);
      const kindOf = (id: string) => r.scenario.devices.find((d) => d.id === id)!.kind;
      let spoken = 0;
      for (const e of r.events) {
        const deviceId = 'deviceId' in e ? e.deviceId : e.type === 'tx' ? e.fromDevice : undefined;
        const s = w.speak(e);
        if (!s) continue;
        spoken++;
        expect(deviceId).toBeDefined();
        const kind = kindOf(deviceId!);
        expect(machinesFor(kind), `${e.type} on ${kind}`).toContain(s.machine);
        expect(machineFor(e, kind)).toBe(s.machine);
        expect(s.text).not.toContain('undefined');
        expect(s.text).not.toContain('NaN');
        expect(s.text.length).toBeGreaterThan(3);
      }
      expect(spoken).toBeGreaterThan(40);
    }
  });
});

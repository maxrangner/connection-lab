import { describe, expect, it } from 'vitest';
import { fetchWebPage, runScenario } from '../../sim';
import { machineFor, machinesFor } from '../iso/machines/Machine';
import { categoryOf, SpeechWriter } from './speech';

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

  it('only trouble and results become bubbles', () => {
    const r = runScenario(fetchWebPage({ mss: 536 }), { seed: 4, faults: { randomLoss: 0.15, manual: [] } });
    const w = new SpeechWriter(r);
    const seen = new Set<string>();
    for (const e of r.events) {
      const c = categoryOf(e, r.scenario.startDevice);
      if (e.type === 'drop' || e.type === 'tcp:retransmit' || e.type === 'tcp:ooo') expect(c).toBe('trouble');
      if (e.type === 'encapsulate' || e.type === 'decapsulate' || e.type === 'route' || e.type === 'forward' || e.type === 'nat:translate') expect(c).toBe('info');
      const s = w.speak(e);
      if (s) {
        expect(s.category).toBe(c);
        seen.add(s.category);
      }
    }
    expect(seen).toEqual(new Set(['trouble', 'result', 'info']));
  });
});

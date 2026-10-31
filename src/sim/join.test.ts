import { describe, expect, it } from 'vitest';
import { runScenario, type SimResult } from './run';
import { fetchWebPage, type Job } from './scenarios/fetchWebPage';

const JOBS: Job[] = ['page', 'photo', 'call', 'ping', 'trace'];
const CLEAN = { randomLoss: 0, manual: [] };
const first = { page: {}, photo: { site: 'httpbin.org' }, call: { call: true }, ping: { probe: 'ping' }, trace: { probe: 'traceroute' } } as const;
const run = (a: Job, b: Job, at: number): SimResult => runScenario(fetchWebPage({ ...first[a], join: { job: b, at } }), { seed: 1, faults: CLEAN, maxTime: 1000 });
const alone = (a: Job): SimResult => runScenario(fetchWebPage(first[a]), { seed: 1, faults: CLEAN, maxTime: 1000 });
/** The app says it finished. A second call finds the friend busy: it talks, hears nothing and hangs up, which is finished too. */
const finished = (r: SimResult, device: string): boolean =>
  r.events.some((e) => e.type === 'app' && e.deviceId === device && (/^(done|call-done|ping-done|trace-done)$/.test(e.action) || (e.action === 'error' && e.info?.reason === 'nobody answered')));

describe('a job dropped in during a run', () => {
  for (const a of JOBS) {
    for (const b of JOBS) {
      for (const at of [0.001, 0.02, 0.1, 1.5]) {
        it(`${b} joining ${a} at ${at} s: both finish, and what came before stays`, () => {
          const r = run(a, b, at);
          expect(finished(r, 'laptop')).toBe(true);
          expect(finished(r, 'phone')).toBe(true);
          const before = (x: SimResult): string[] => x.events.filter((e) => e.t < at).map((e) => JSON.stringify(e));
          expect(before(r)).toEqual(before(alone(a)));
        });
      }
    }
  }

  it('serves each device what it asked for from the one server', () => {
    const r = run('page', 'photo', 0.01);
    const got = (device: string): string => {
      const e = r.events.find((x) => x.type === 'app' && x.action === 'http-response-received' && x.deviceId === device);
      return new TextDecoder('latin1').decode(r.pdus.get((e as { pduId: string }).pduId)!.bytes.subarray(0, 400));
    };
    expect(got('laptop')).toMatch(/text\/html/i);
    expect(got('phone')).toMatch(/image\/jpeg/i);
  });

  it('works with the Setup on: a VPN, HTTPS, DHCP, a cold resolver and a second visit', () => {
    for (const opts of [{ vpn: true }, { https: true }, { dhcp: true }, { cold: true }, { revisit: true }, { thin: true }, { slow: true }, { noise: 0.3 }]) {
      for (const job of JOBS) {
        const r = runScenario(fetchWebPage({ ...opts, join: { job, at: 0.02 } }), { seed: 1, faults: CLEAN, maxTime: 1000 });
        expect(finished(r, 'phone')).toBe(true);
      }
    }
  });
});

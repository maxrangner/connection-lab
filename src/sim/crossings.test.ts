import { describe, expect, it } from 'vitest';
import { fetchWebPage, runScenario, type Cut, type SimResult } from '.';

const CLEAN = { randomLoss: 0, manual: [] };
const run = (opts: Parameters<typeof fetchWebPage>[0] = {}, seed = 1, cuts: Cut[] = []): SimResult => runScenario(fetchWebPage(opts), { seed, faults: { ...CLEAN, cuts }, maxTime: 1000 });
const fieldOf = (r: SimResult, frameId: string, key: string): string | undefined => r.pdus.get(frameId)!.layers.flatMap((l) => l.fields).find((f) => f.key === key)?.display;

describe('a port is not a protocol', () => {
  it('a VPN server whose NAT drew the WireGuard port still gets the answer back', () => {
    for (const seed of [16172, 137418]) {
      expect(run({ vpn: true }, seed).events.some((e) => e.type === 'app' && e.action === 'http-response-received'), `seed ${seed}`).toBe(true);
    }
  });

  it('plain DNS on an ephemeral port that happens to be the WireGuard port is DNS', () => {
    const r = run({}, 9194);
    const question = [...r.packets.values()].find((p) => p.kind === 'dns')!;
    const frame = r.events.find((e) => e.type === 'tx' && e.packetId === question.id);
    const layers = frame?.type === 'tx' ? r.pdus.get(frame.frameId)!.layers.map((l) => l.protocol) : [];
    expect(layers).toContain('dns');
    expect(layers).not.toContain('wireguard');
  });

  it('real WireGuard and real RTP still decode as such', () => {
    const r = run({ vpn: true, call: true });
    const seen = new Set(r.events.flatMap((e) => (e.type === 'tx' ? r.pdus.get(e.frameId)!.layers.map((l) => l.protocol) : [])));
    expect(seen).toContain('wireguard');
    const open = run({ call: true });
    expect(new Set(open.events.flatMap((e) => (e.type === 'tx' ? open.pdus.get(e.frameId)!.layers.map((l) => l.protocol) : [])))).toContain('rtp');
  });
});

describe('what belongs to one device', () => {
  it('a device with no tunnel advertises its own MSS, not the tunnel\'s', () => {
    const mssOf = (r: SimResult, device: string): string => {
      const syn = r.events.find((e) => e.type === 'tx' && r.packets.get(e.packetId)?.origin === device && r.packets.get(e.packetId)?.label.includes('SYN'));
      return syn?.type === 'tx' ? JSON.stringify(r.pdus.get(syn.frameId)!.layers.find((l) => l.protocol === 'tcp')?.fields) : '';
    };
    const r = run({ vpn: true, joins: [{ device: 'phone', job: 'photo', at: 0.1 }] });
    expect(mssOf(r, 'phone')).toContain('1460');
    expect(mssOf(r, 'phone')).not.toContain('1380');
  });
});

describe('a NAT', () => {
  it('lets no private address out on the public line', () => {
    const r = run({ cold: true }, 1, [{ link: 'up1', from: 0, to: 1 }, { link: 'up2', from: 0, to: 3 }, { link: 'up3', from: 0, to: 5 }]);
    for (const e of r.events) {
      if (e.type !== 'tx' || e.linkId !== 'wan') continue;
      expect(fieldOf(r, e.frameId, 'ipv4.src') ?? '').not.toMatch(/^192\.168\./);
    }
  });
});

describe('TCP in trouble', () => {
  const photo = { site: 'httpbin.org', thin: true } as const;

  it('what the peer says it has is not on its way, so a hole does not wait a timer each', () => {
    const r = run(photo, 1, [{ link: 'wan', from: 0.0432, to: 0.0532 }]);
    const got = r.events.find((e) => e.type === 'app' && e.action === 'http-response-received');
    expect(got?.t).toBeLessThan(3);
  });

  it('recovering, dup ACKs do not start another fast retransmit', () => {
    const data = [...run({ site: 'httpbin.org' }).packets.values()].filter((p) => p.origin === 'server' && /TCP|HTTP/.test(p.label));
    const lost = [data[1]!, data[9]!, data[10]!];
    const x = runScenario(fetchWebPage({ site: 'httpbin.org' }), { seed: 1, faults: { ...CLEAN, manual: lost.map((p) => ({ packetId: p.id, linkId: 'bb2' })) }, maxTime: 1000 });
    const causes = x.events.flatMap((e) => (e.type === 'tcp:retransmit' ? [e.cause] : []));
    expect(causes.filter((c) => c === 'fast').length).toBeLessThanOrEqual(1);
  });
});

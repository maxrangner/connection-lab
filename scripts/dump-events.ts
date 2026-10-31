// Debug helper: prints the event log of a scenario run. Usage: npx vite-node scripts/dump-events.ts [mss] [dhcp] [call] [thin] [photo] [lose:packetId@linkId]
import { fetchWebPage, runScenario } from '../src/sim';

const mss = Number(process.argv[2] ?? 1460);
const dhcp = process.argv.includes('dhcp');
const call = process.argv.includes('call');
const thin = process.argv.includes('thin');
const site = process.argv.includes('photo') ? ('httpbin.org' as const) : undefined;
const manual = process.argv.slice(3).filter((a) => a.startsWith('lose:')).map((a) => {
  const [packetId, linkId] = a.slice(5).split('@');
  return { packetId: packetId!, linkId: linkId! };
});
const r = runScenario(fetchWebPage({ mss, dhcp, call, thin, ...(site ? { site } : {}) }), { seed: 1, faults: { randomLoss: 0, manual } });
for (const e of r.events) {
  const { t, seq, type, ...rest } = e;
  const pdu = 'pduId' in rest && rest.pduId ? r.pdus.get(rest.pduId as string) : 'frameId' in rest ? r.pdus.get(rest.frameId as string) : undefined;
  const pk = 'packetId' in rest && rest.packetId ? r.packets.get(rest.packetId as string)?.label : '';
  const tail = pdu ? ` | ${pdu.layers.map((l) => l.summary).join(' / ')}` : '';
  console.log(`${(t * 1000).toFixed(3).padStart(10)}ms #${seq} ${type} ${JSON.stringify(rest)}${pk ? ` «${pk}»` : ''}${tail}`.slice(0, 400));
}
console.log(`end ${r.endTime}s, ${r.events.length} events, ${r.pdus.size} pdus`);

import { hexBytes, type Field, type LayerPdu, type PduSnapshot } from '../../sim';
import { layerLabel, PROTO_ROW, PROTOCOL_NAME, protocolColor, type LayerModel } from '../content/layers';
import type { Flight, Schedule, Track } from '../timeline/schedule';
import { button, h, segmented } from './dom';

export type Detail = 'clean' | 'full' | 'hex';

export interface InspectorHost {
  model(): LayerModel;
  detail(): Detail;
  setDetail(d: Detail): void;
  loseFrame(f: Flight): void;
  close(): void;
}

type Target = { kind: 'pdu'; pduId: string; flight?: Flight; track?: Track } | { kind: 'device'; deviceId: string };

function flatten(fields: Field[], out: Field[] = []): Field[] {
  for (const f of fields) {
    out.push(f);
    if (f.children) flatten(f.children, out);
  }
  return out;
}

function layerTitle(l: LayerPdu, model: LayerModel): string {
  return `${layerLabel(PROTO_ROW[l.protocol], model)} · ${PROTOCOL_NAME[l.protocol]}`;
}

export class Inspector {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private target: Target | undefined;
  private schedule: Schedule | undefined;
  private v = 0;

  constructor(private readonly host: InspectorHost) {
    this.body = h('div', { class: 'insp-body' });
    this.el = h('aside', { class: 'inspector', attrs: { 'aria-label': 'Inspector' } }, this.body);
  }

  get open(): boolean {
    return !!this.target;
  }

  get selectedPdu(): string | undefined {
    return this.target?.kind === 'pdu' ? this.target.pduId : undefined;
  }

  showPdu(s: Schedule, pduId: string, ctx: { flight?: Flight; track?: Track }, v: number): void {
    this.schedule = s;
    this.v = v;
    this.target = { kind: 'pdu', pduId, ...ctx };
    this.render();
  }

  showDevice(s: Schedule, deviceId: string, v: number): void {
    this.schedule = s;
    this.v = v;
    this.target = { kind: 'device', deviceId };
    this.render();
  }

  hide(): void {
    this.target = undefined;
    this.el.classList.remove('open');
  }

  /** Re-render after settings change or a re-simulation (the snapshot may not exist anymore). */
  refresh(s: Schedule, v: number): void {
    this.schedule = s;
    this.v = v;
    if (this.target?.kind === 'pdu' && !s.result.pdus.has(this.target.pduId)) return this.hide();
    if (this.target) this.render();
  }

  private render(): void {
    const s = this.schedule;
    const t = this.target;
    if (!s || !t) return;
    this.el.classList.add('open');
    this.body.replaceChildren(t.kind === 'pdu' ? this.renderPdu(s, t) : this.renderDevice(s, t.deviceId));
  }

  private header(title: string, sub: string, ...extra: HTMLElement[]): HTMLElement {
    return h(
      'div',
      { class: 'insp-head' },
      h('div', { class: 'insp-titles' }, h('div', { class: 'insp-title', text: title }), h('div', { class: 'insp-sub', text: sub })),
      ...extra,
      button('✕', () => this.host.close(), 'icon-btn', 'Close (Esc)'),
    );
  }

  private renderPdu(s: Schedule, t: Extract<Target, { kind: 'pdu' }>): HTMLElement {
    const pdu = s.result.pdus.get(t.pduId)!;
    const pk = s.result.packets.get(pdu.packetId);
    const sc = s.result.scenario;
    const name = (id: string): string => sc.devices.find((d) => d.id === id)?.label ?? id;
    let where = '';
    let lose: HTMLElement | null = null;
    if (t.flight) {
      const link = sc.links.find((l) => l.id === t.flight!.linkId);
      where = `On the wire: ${name(t.flight.from)} → ${name(t.flight.to)} (${link?.label ?? t.flight.linkId})`;
      const f = t.flight;
      if (f.lostAt === undefined && this.v < f.v1) {
        lose = button('Lose this frame', () => this.host.loseFrame(f), 'danger', 'Re-run the simulation with this frame lost on this link');
      } else if (f.lostAt !== undefined) {
        lose = h('span', { class: 'pill bad', text: 'lost on this link' });
      }
    } else if (t.track) {
      where = `Inside ${name(t.track.deviceId)}`;
    }
    const root = h('div', { class: 'insp-pdu' });
    root.append(this.header(pk?.label ?? pdu.packetId, `${where} · ${pdu.bytes.length} bytes`));
    if (pk?.retransmitOf) root.append(h('p', { class: 'note warn', text: 'This is a retransmission: same bytes and sequence number as a segment that was not acknowledged in time.' }));
    if (pk?.kind === 'stream') root.append(h('p', { class: 'note', text: 'Application bytes as the program sees them: one continuous stream. TCP splits it into segments for sending and reassembles it on arrival.' }));
    const tools = h('div', { class: 'insp-tools' }, segmented<Detail>('Detail', [
      { value: 'clean', label: 'Clean', title: 'Only the fields that matter here' },
      { value: 'full', label: 'Full', title: 'Every header field with byte offsets' },
      { value: 'hex', label: 'Hex', title: 'The raw bytes' },
    ], this.host.detail(), (d) => {
      this.host.setDetail(d);
      this.render();
    }), lose);
    root.append(tools);
    const detail = this.host.detail();
    if (detail === 'hex') root.append(this.hexView(pdu));
    else for (const l of pdu.layers) root.append(this.layerSection(l, detail));
    if (t.flight) root.append(h('p', { class: 'note', text: 'On the wire every frame is preceded by 7 bytes of preamble (0x55: alternating bits for clock sync) and a start-of-frame delimiter (0xD5). Each byte is sent least-significant bit first.' }));
    return root;
  }

  private layerSection(l: LayerPdu, detail: Detail): HTMLElement {
    const color = protocolColor(l.protocol);
    const hdr = l.headerEnd - l.start;
    const trailer = l.end - l.payloadEnd;
    const sizes = PROTO_ROW[l.protocol] === 5 ? `${l.end - l.start} B` : `${hdr} B header${trailer ? ` + ${trailer} B trailer` : ''}`;
    const sec = h('section', { class: 'layer', attrs: { style: `--lc:${color}` } });
    sec.append(h('div', { class: 'layer-head' }, h('span', { class: 'layer-name', text: layerTitle(l, this.host.model()) }), h('span', { class: 'layer-size', text: sizes })));
    sec.append(h('div', { class: 'layer-summary', text: l.summary }));
    const list = h('div', { class: 'fields' });
    const add = (f: Field, depth: number): void => {
      if (detail === 'clean' && f.importance !== 'key') return;
      if (detail === 'clean') {
        list.append(h('div', { class: `field clean d${depth}` }, h('div', { class: 'f-row' }, h('span', { class: 'f-name', text: f.name }), h('span', { class: 'f-val', text: f.display })), h('div', { class: 'f-explain', text: f.explain })));
      } else {
        const off = f.bits ? `@${f.offset - l.start} bit ${f.bits.start}+${f.bits.count}` : `@${f.offset - l.start} +${f.length}`;
        const d = h('details', { class: `field full d${depth}` }, h('summary', {}, h('span', { class: 'f-name', text: f.name }), h('span', { class: 'f-val', text: f.display }), h('span', { class: 'f-off', text: off })), h('div', { class: 'f-explain', text: f.explain }));
        list.append(d);
      }
      for (const c of f.children ?? []) add(c, depth + 1);
    };
    for (const f of l.fields) add(f, 0);
    if (!list.children.length) list.append(h('div', { class: 'f-explain', text: 'Nothing essential here; switch to Full to see every field.' }));
    sec.append(list);
    return sec;
  }

  private hexView(pdu: PduSnapshot): HTMLElement {
    const all = pdu.layers.flatMap((l) => flatten(l.fields).map((f) => ({ f, l })));
    // Most specific field per byte.
    const owner: ({ f: Field; l: LayerPdu } | undefined)[] = new Array(pdu.bytes.length);
    for (const x of all) {
      for (let i = x.f.offset; i < x.f.offset + x.f.length && i < pdu.bytes.length; i++) {
        const cur = owner[i];
        if (!cur || x.f.length <= cur.f.length) owner[i] = x;
      }
    }
    const layerOf = (i: number): LayerPdu | undefined => {
      for (let d = pdu.layers.length - 1; d >= 0; d--) {
        const l = pdu.layers[d]!;
        if (i >= l.start && i < l.end) return l;
      }
      return undefined;
    };
    const info = h('div', { class: 'hex-info', text: 'Hover a byte to see which field it belongs to.' });
    const grid = h('div', { class: 'hex' });
    const cells: HTMLElement[] = [];
    const highlight = (f: Field | undefined): void => {
      for (const c of cells) c.classList.remove('hl');
      if (!f) return;
      for (let i = f.offset; i < f.offset + f.length; i++) cells[i]?.classList.add('hl');
    };
    for (let row = 0; row < pdu.bytes.length; row += 16) {
      const line = h('div', { class: 'hex-line' }, h('span', { class: 'hex-off', text: row.toString(16).padStart(4, '0') }));
      const bytesEl = h('span', { class: 'hex-bytes' });
      const asc = h('span', { class: 'hex-ascii' });
      for (let i = row; i < Math.min(row + 16, pdu.bytes.length); i++) {
        const l = layerOf(i);
        const inTrailer = l && i >= l.payloadEnd && i < l.end;
        const color = l ? protocolColor(l.protocol) : '#94a3b8';
        const c = h('span', { class: `hb${inTrailer ? ' trailer' : ''}`, text: hexBytes(pdu.bytes, i, i + 1), attrs: { style: `--lc:${color}` } });
        const o = owner[i];
        c.addEventListener('mouseenter', () => {
          highlight(o?.f);
          info.replaceChildren(
            o ? h('b', { text: `${o.f.name}: ` }) : '',
            o ? o.f.display : `byte ${i}`,
            h('div', { class: 'f-explain', text: o ? `${layerTitle(o.l, this.host.model())} · offset ${o.f.offset} · ${o.f.explain}` : '' }),
          );
        });
        cells[i] = c;
        bytesEl.append(c);
        const b = pdu.bytes[i] ?? 0;
        asc.append(h('span', { class: 'ha', text: b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·', attrs: { style: `--lc:${color}` } }));
      }
      line.append(bytesEl, asc);
      grid.append(line);
    }
    grid.addEventListener('mouseleave', () => highlight(undefined));
    const legend = h('div', { class: 'hex-legend' }, ...pdu.layers.map((l) => h('span', { class: 'chip', text: PROTOCOL_NAME[l.protocol], attrs: { style: `--lc:${protocolColor(l.protocol)}` } })));
    return h('div', { class: 'hex-wrap' }, legend, grid, info);
  }

  private renderDevice(s: Schedule, id: string): HTMLElement {
    const spec = s.result.scenario.devices.find((d) => d.id === id)!;
    const v = this.v;
    const past = s.result.events.filter((e) => (s.eventV[e.seq] ?? Infinity) <= v);
    const arp = new Map<string, string>(Object.entries(spec.arp ?? {}));
    const nat: string[] = [];
    let tcp = '';
    for (const e of past) {
      if (e.type === 'arp:learn' && e.deviceId === id) arp.set(e.ip, e.mac);
      if (e.type === 'nat:add' && e.deviceId === id) nat.push(`${e.entry.proto.toUpperCase()}  ${e.entry.inside.ip}:${e.entry.inside.port} ⇄ ${e.entry.outside.ip}:${e.entry.outside.port}  (peer ${e.entry.remote.ip}:${e.entry.remote.port})`);
      if (e.type === 'tcp:state' && e.deviceId === id) tcp = `${e.connId.split(':').slice(1).join(':')}  ${e.to}`;
    }
    const blurb: Record<string, string> = {
      laptop: 'An end host. Runs the browser, a stub DNS resolver and a full TCP/IP stack. It sends everything that is not on its own network to the default gateway.',
      'home-router': 'Forwards packets between your home network and your ISP (layer 3), and does NAT: rewrites private addresses and ports to its single public address, and back.',
      router: "Your ISP's router. Looks only at the IP header (layer 3) to choose where to send each packet. The real internet path has around 10 such routers; we show one.",
      'dns-resolver': "A recursive resolver (Cloudflare's 1.1.1.1). It answers from its cache, or asks the DNS hierarchy on your behalf.",
      'web-server': "A Cloudflare edge server for example.com. It serves the page from its cache ('cf-cache-status: HIT').",
    };
    const table = (title: string, head: string[], rows: string[][]): HTMLElement =>
      h('section', { class: 'dev-sec' }, h('h4', { text: title }), rows.length
        ? h('table', {}, h('thead', {}, h('tr', {}, ...head.map((x) => h('th', { text: x })))), h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c) => h('td', { text: c }))))))
        : h('div', { class: 'f-explain', text: 'empty' }));
    const root = h('div', { class: 'insp-dev' });
    root.append(this.header(spec.label, spec.sublabel ?? spec.kind));
    root.append(h('p', { class: 'note', text: blurb[spec.kind] ?? '' }));
    root.append(table('Interfaces', ['name', 'IP', 'MAC'], spec.ifaces.map((i) => [i.name, `${i.ip}/${i.prefixLen}`, i.mac])));
    root.append(table('Routing table', ['destination', 'via', 'interface'], spec.routes.map((r) => [r.prefixLen === 0 ? 'default' : `${r.network}/${r.prefixLen}`, r.via ?? 'direct', r.iface.split('.')[1] ?? r.iface])));
    root.append(table('ARP cache (now)', ['IP', 'MAC'], [...arp.entries()].map(([ip, mac]) => [ip, mac])));
    if (spec.nat) root.append(table('NAT table (now)', ['mapping'], nat.map((x) => [x])));
    if (tcp) root.append(table('TCP (now)', ['connection'], [[tcp]]));
    return root;
  }
}

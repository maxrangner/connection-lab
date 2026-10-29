import type { DeviceKind, LayerNum, Protocol } from '../../sim';

export type LayerModel = 'tcpip' | 'osi';

/** One color per layer, used everywhere: byte blocks, card rows, inspector, legend. Mirrors CSS vars. */
export const LAYER_COLOR: Record<LayerNum, string> = {
  1: '#94a3b8',
  2: '#f59e0b',
  3: '#3b82f6',
  4: '#a855f7',
  5: '#22c55e',
};

/** ARP rides in Ethernet but is its own protocol; a lighter amber keeps it distinct from the Ethernet header. */
export const ARP_COLOR = '#fcd34d';

export function protocolColor(p: Protocol): string {
  if (p === 'arp') return ARP_COLOR;
  return LAYER_COLOR[PROTO_ROW[p]];
}

/** The card row a PDU of this protocol sits in. ARP is handled at the link layer row. */
export const PROTO_ROW: Record<Protocol, LayerNum> = {
  ethernet: 2,
  arp: 2,
  ipv4: 3,
  udp: 4,
  tcp: 4,
  dns: 5,
  http: 5,
};

export const PROTOCOL_NAME: Record<Protocol, string> = {
  ethernet: 'Ethernet',
  arp: 'ARP',
  ipv4: 'IPv4',
  udp: 'UDP',
  tcp: 'TCP',
  dns: 'DNS',
  http: 'HTTP',
};

export interface RowDef {
  /** TCP/IP layer this row hosts, or null for OSI pass-through rows (6, 5). */
  layer: LayerNum | null;
  number: number;
  name: string;
  /** Thin, informational row (OSI presentation/session). */
  thin?: boolean;
  /** Dimmed row the device only peeks into (NAT reads/rewrites ports). */
  peek?: boolean;
}

const TCPIP_NAMES: Record<LayerNum, string> = {
  5: 'Application',
  4: 'Transport',
  3: 'Network',
  2: 'Link',
  1: 'Physical',
};

const OSI_NAMES: Record<LayerNum, string> = {
  5: 'Application',
  4: 'Transport',
  3: 'Network',
  2: 'Data link',
  1: 'Physical',
};

export function layerLabel(layer: LayerNum, model: LayerModel): string {
  if (model === 'osi') return `L${layer === 5 ? 7 : layer} ${OSI_NAMES[layer]}`;
  return `L${layer} ${TCPIP_NAMES[layer]}`;
}

export function rowsFor(kind: DeviceKind, model: LayerModel): RowDef[] {
  const isRouter = kind === 'router' || kind === 'home-router';
  const names = model === 'osi' ? OSI_NAMES : TCPIP_NAMES;
  const row = (layer: LayerNum, extra: Partial<RowDef> = {}): RowDef => ({
    layer,
    number: model === 'osi' && layer === 5 ? 7 : layer,
    name: names[layer],
    ...extra,
  });
  if (isRouter) {
    const rows: RowDef[] = [];
    if (kind === 'home-router') rows.push(row(4, { peek: true, name: 'Transport (NAT)' }));
    rows.push(row(3), row(2), row(1));
    return rows;
  }
  if (model === 'osi') {
    return [
      row(5),
      { layer: null, number: 6, name: 'Presentation', thin: true },
      { layer: null, number: 5, name: 'Session', thin: true },
      row(4),
      row(3),
      row(2),
      row(1),
    ];
  }
  return [row(5), row(4), row(3), row(2), row(1)];
}

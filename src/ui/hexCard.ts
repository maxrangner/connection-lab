import type { Field, LayerPdu, PduSnapshot } from '../sim';
import type { PartKey } from './story';
import { buttonMark, drawCross } from './icons';
import { COLOR } from './NetworkScene';

/**
 * The bytes of a packet, exactly as they are at this moment, coloured by the piece they belong to; the piece whose pill
 * was open is bright, the rest dim. Touch a byte and the row under the grid names its field. Nothing here is made up:
 * it is the snapshot the simulation left behind.
 */

/** The colour of each protocol's bytes, by the piece of the packet it is drawn as. */
const PROTO_COLOR: Record<string, string> = { ethernet: COLOR.eth, wifi: COLOR.wifi, arp: COLOR.app, icmp: COLOR.app, ipv4: COLOR.ip, udp: COLOR.udp, tcp: COLOR.tcp, dns: COLOR.app, dhcp: COLOR.app, mqtt: COLOR.app, http: COLOR.app, tls: COLOR.app, wireguard: 'var(--tunnel)' };
const PROTO_NAME: Record<string, string> = { ethernet: 'Ethernet', wifi: 'Wi-Fi', arp: 'ARP', icmp: 'ICMP', ipv4: 'IP', udp: 'UDP', tcp: 'TCP', dns: 'DNS', dhcp: 'DHCP', mqtt: 'MQTT', http: 'HTTP', tls: 'TLS', wireguard: 'WireGuard' };
const PER_ROW = 16;

/** Which layer each byte belongs to: the innermost one that spans it. */
export function ownerOf(pdu: PduSnapshot): (LayerPdu | undefined)[] {
  const owner: (LayerPdu | undefined)[] = new Array(pdu.bytes.length).fill(undefined);
  for (const l of pdu.layers) for (let i = l.start; i < l.end; i++) owner[i] = l;
  return owner;
}

/** The byte range [from, to) of a piece of the packet in a snapshot, or null if the snapshot has no such piece. */
export function rangeOf(pdu: PduSnapshot, key: PartKey): [number, number] | null {
  const find = (...protocols: string[]): LayerPdu | undefined => pdu.layers.find((l) => protocols.includes(l.protocol));
  const link = find('ethernet', 'wifi');
  const ip = find('ipv4');
  const l4 = find('tcp', 'udp');
  const wg = find('wireguard');
  switch (key) {
    case 'ethH':
      return link ? [link.start, link.headerEnd] : null;
    case 'ethT':
      return link && link.end > link.payloadEnd ? [link.payloadEnd, link.end] : null;
    case 'vpn':
      return wg && ip ? [ip.start, wg.headerEnd] : null;
    case 'ip':
      return ip && !wg ? [ip.start, ip.headerEnd] : null;
    case 'l4':
      return l4 && !wg ? [l4.start, l4.headerEnd] : null;
    case 'card': {
      const app = find('http', 'dns', 'dhcp', 'tls', 'arp', 'icmp');
      if (app) return [app.start, app.end];
      return l4 && !wg && l4.payloadEnd > l4.headerEnd ? [l4.headerEnd, l4.payloadEnd] : null;
    }
  }
}

/** The narrowest field covering byte `i` in any layer, with the layer it is in. */
export function fieldAt(pdu: PduSnapshot, i: number): { layer: LayerPdu; field: Field } | null {
  let best: { layer: LayerPdu; field: Field } | null = null;
  const walk = (layer: LayerPdu, fields: Field[]): void => {
    for (const f of fields) {
      if (i < f.offset || i >= f.offset + f.length) continue;
      if (!best || f.length <= best.field.length) best = { layer, field: f };
      if (f.children) walk(layer, f.children);
    }
  };
  for (const l of pdu.layers) walk(l, l.fields);
  return best;
}

export class HexCard {
  private readonly panel = document.createElement('div');
  private readonly title = document.createElement('div');
  private readonly grid = document.createElement('div');
  private readonly note = document.createElement('div');
  private key: PartKey | null = null;
  private pdu: PduSnapshot | null = null;

  constructor(root: HTMLElement, onClose: () => void) {
    this.panel.className = 'hex-card';
    this.panel.hidden = true;
    const top = document.createElement('div');
    top.className = 'hex-top';
    this.title.className = 'hex-title';
    const close = document.createElement('button');
    close.appendChild(buttonMark(drawCross));
    close.setAttribute('aria-label', 'Close the bytes');
    close.addEventListener('click', onClose);
    top.append(this.title, close);
    this.grid.className = 'hex-grid';
    this.note.className = 'hex-note';
    this.panel.append(top, this.grid, this.note);
    root.appendChild(this.panel);
    const name = (e: Event): void => {
      const t = (e.target as Element).closest<HTMLElement>('[data-i]');
      if (t && this.pdu) this.describe(Number(t.dataset.i));
    };
    this.grid.addEventListener('pointerover', name);
    this.grid.addEventListener('pointerdown', name);
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  /** Show this snapshot with this piece bright. Showing the same again costs nothing. */
  show(pdu: PduSnapshot, key: PartKey): void {
    this.panel.hidden = false;
    // By the snapshot itself: its number starts over every run.
    if (this.pdu === pdu && this.key === key) return;
    this.key = key;
    this.pdu = pdu;
    const owner = ownerOf(pdu);
    const range = rangeOf(pdu, key);
    this.title.textContent = `${pdu.bytes.length} bytes`;
    this.grid.replaceChildren();
    for (let row = 0; row < pdu.bytes.length; row += PER_ROW) {
      const line = document.createElement('div');
      line.className = 'hex-row';
      const off = document.createElement('span');
      off.className = 'hex-off';
      off.textContent = row.toString(16).padStart(4, '0');
      line.appendChild(off);
      for (let i = row; i < Math.min(row + PER_ROW, pdu.bytes.length); i++) {
        const b = document.createElement('span');
        b.className = 'hex-byte';
        b.dataset.i = String(i);
        b.textContent = pdu.bytes[i]!.toString(16).padStart(2, '0');
        b.style.color = PROTO_COLOR[owner[i]?.protocol ?? ''] ?? '';
        if (range && (i < range[0] || i >= range[1])) b.classList.add('dim');
        line.appendChild(b);
      }
      this.grid.appendChild(line);
    }
    this.describe(range ? range[0] : 0);
  }

  hide(): void {
    this.panel.hidden = true;
  }

  /** The row under the grid: which field byte `i` is part of. */
  private describe(i: number): void {
    if (!this.pdu) return;
    const hit = fieldAt(this.pdu, i);
    const layer = ownerOf(this.pdu)[i];
    const where = PROTO_NAME[(hit?.layer ?? layer)?.protocol ?? ''] ?? '';
    this.note.textContent = hit ? `${where} · ${hit.field.name}: ${hit.field.display}` : `${where || 'data'} · byte ${i}`;
  }
}

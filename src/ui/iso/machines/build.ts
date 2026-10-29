import { el } from '../../scene/svg';
import { LAYER_COLOR } from '../../content/layers';
import { fmtTime } from '../../content/format';
import type { Act, DeviceState } from '../../timeline/schedule';
import { FD, MACHINE, PART_D } from '../layout';
import { at, billboard, box, cylinder, line, placeBillboard, tile } from '../prims';
import { clamp01, easeOut, iso, lerp, type Vec3 } from '../project';
import { local, type MachineBuilder, type MachineCtx, type MachineView } from './base';
import type { MachineKind } from './Machine';

const STEEL = '#94a3b8';
const DARK = '#475569';
const WOOD = '#a0784a';
const BRASS = '#d4a017';

/** One beat of motion: 0 → 1 → 0 over the act, peaking early. */
const pulse = (u: number): number => Math.sin(Math.PI * clamp01(u));
/** Press: quickly down, hold, back up. */
const press = (u: number): number => (u < 0.25 ? easeOut(u / 0.25) : u < 0.6 ? 1 : 1 - easeOut((u - 0.6) / 0.4));

const evType = (act: Act | undefined): string => act?.event.type ?? '';

/** Rotates a group around a world pivot (screen-space rotation, which reads as a swing). */
function rotateAbout(g: SVGElement, p: Vec3, deg: number): void {
  const s = iso(p.x, p.y, p.z);
  g.setAttribute('transform', `rotate(${deg.toFixed(2)} ${s.sx.toFixed(2)} ${s.sy.toFixed(2)})`);
}

// ───────────────────────────────────────────── app floor ─────────────────────────────────────────────

const browser: MachineBuilder = (parent, ctx) => {
  const { tower: t, floor: f } = ctx;
  const g = el('g', { class: 'machine m-browser' }, parent);
  const base = local(t, MACHINE.x - 1.9, MACHINE.y - 0.4, f.top);
  box(g, { x: base.x, y: base.y, z: base.z, w: 3.8, d: 0.45, h: 0.3, color: STEEL }); // stand
  box(g, { x: base.x, y: base.y, z: base.z + 0.3, w: 3.8, d: 0.3, h: 2.3, color: DARK }); // monitor
  const screen = el('g', { class: 'screen' }, g);
  // Screen face: the +y face of the monitor, drawn as a lighter plate.
  const sx0 = base.x + 0.2;
  const sz0 = base.z + 0.5;
  const face = el('path', { class: 'screen-face', d: `M${P(sx0, base.y + 0.3, sz0 + 1.9)}L${P(sx0 + 3.4, base.y + 0.3, sz0 + 1.9)}L${P(sx0 + 3.4, base.y + 0.3, sz0)}L${P(sx0, base.y + 0.3, sz0)}Z` }, screen);
  const l1 = billboard(g, local(t, MACHINE.x, MACHINE.y - 0.2, f.top + 2.1), '', 'mtext small');
  const l2 = billboard(g, local(t, MACHINE.x, MACHINE.y - 0.2, f.top + 1.3), '', 'mtext tiny');
  const mosaic = el('g', { class: 'mosaic' }, g);
  let mosaicBuilt = false;
  const anchor = local(t, MACHINE.x, MACHINE.y, f.top + 2.4);
  return {
    kind: 'browser',
    g,
    anchor,
    render(_v, st, act, u) {
      const a = evType(act) === 'app' ? pulse(u) : 0;
      face.style.filter = a > 0.05 ? 'url(#glow)' : '';
      const app = act?.event.type === 'app' ? act.event : undefined;
      if (st.pageReady) {
        l1.textContent = 'Example Domain';
        l2.textContent = 'page rendered ✓';
        if (!mosaicBuilt) {
          mosaicBuilt = true;
          const o = iso(sx0 + 0.3, base.y + 0.31, sz0 + 1.15);
          for (let i = 0; i < 60; i++) {
            el('rect', { x: o.sx + (i % 15) * 5.2, y: o.sy + Math.floor(i / 15) * 5, width: 4, height: 3.6, fill: i < 22 ? '#86efac' : i < 26 ? '#64748b' : '#22c55e', opacity: i < 22 ? 0.55 : 0.95 }, mosaic);
          }
        }
      } else if (st.dnsAnswer) {
        l1.textContent = 'example.com';
        l2.textContent = `= ${st.dnsAnswer[0] ?? ''}`;
      } else if (app && app.action !== 'start') {
        l1.textContent = 'example.com';
        l2.textContent = app.action === 'dns-lookup' ? 'looking up…' : '';
      } else {
        l1.textContent = 'http://example.com/';
        l2.textContent = st.timer?.kind === 'dns-retry' ? `waiting for DNS ${fmtTime(st.timer.remaining)}` : '';
      }
    },
  };
};

const dnsDesk: MachineBuilder = (parent, ctx) => {
  const { tower: t, floor: f } = ctx;
  const g = el('g', { class: 'machine m-dns' }, parent);
  const base = local(t, MACHINE.x - 1.4, MACHINE.y - 0.5, f.top);
  box(g, { x: base.x, y: base.y, z: base.z, w: 2.8, d: 1.2, h: 2.2, color: WOOD }); // cabinet
  const drawers: SVGGElement[] = [];
  for (let i = 0; i < 3; i++) {
    const dg = el('g', {}, g);
    box(dg, { x: base.x + 0.15, y: base.y + 1.1, z: base.z + 0.2 + i * 0.65, w: 2.5, d: 0.25, h: 0.5, color: '#a37d4a' });
    drawers.push(dg);
  }
  const lbl = billboard(g, local(t, MACHINE.x, MACHINE.y - 0.3, f.top + 1.5), '', 'mtext small');
  return {
    kind: 'dnsDesk',
    g,
    anchor: local(t, MACHINE.x, MACHINE.y, f.top + 2.6),
    render(_v, _st, act, u) {
      const a = evType(act) === 'app' ? press(u) : 0;
      const d = iso(0, 0.9 * a, 0);
      drawers[1]!.setAttribute('transform', `translate(${d.sx.toFixed(2)},${d.sy.toFixed(2)})`);
      lbl.textContent = a > 0.5 ? 'example.com → 104.20.23.154' : '';
    },
  };
};

const httpShelf: MachineBuilder = (parent, ctx) => {
  const { tower: t, floor: f } = ctx;
  const g = el('g', { class: 'machine m-http' }, parent);
  const base = local(t, MACHINE.x - 1.5, MACHINE.y - 0.5, f.top);
  box(g, { x: base.x, y: base.y, z: base.z, w: 3, d: 1.1, h: 0.2, color: STEEL });
  box(g, { x: base.x, y: base.y, z: base.z + 1.2, w: 3, d: 1.1, h: 0.15, color: STEEL });
  box(g, { x: base.x, y: base.y, z: base.z, w: 0.15, d: 1.1, h: 2.2, color: STEEL });
  box(g, { x: base.x + 2.85, y: base.y, z: base.z, w: 0.15, d: 1.1, h: 2.2, color: STEEL });
  const page = el('g', {}, g);
  box(page, { x: base.x + 0.4, y: base.y + 0.2, z: base.z + 1.35, w: 2.2, d: 0.7, h: 0.35, color: LAYER_COLOR[5] });
  billboard(g, local(t, MACHINE.x, MACHINE.y - 0.2, f.top + 1.95), '/ (932 B)', 'mtext small');
  return {
    kind: 'httpShelf',
    g,
    anchor: local(t, MACHINE.x, MACHINE.y, f.top + 2.6),
    render(_v, _st, act, u) {
      const a = evType(act) === 'app' ? pulse(u) : 0;
      const d = iso(0, 0, 0.5 * a);
      page.setAttribute('transform', `translate(${d.sx.toFixed(2)},${d.sy.toFixed(2)})`);
    },
  };
};

// ───────────────────────────────────────────── transport ─────────────────────────────────────────────

const tcpClerk: MachineBuilder = (parent, ctx) => {
  const { tower: t, floor: f } = ctx;
  const g = el('g', { class: 'machine m-tcp' }, parent);
  const base = local(t, MACHINE.x - 2.2, MACHINE.y - 0.4, f.top);
  box(g, { x: base.x, y: base.y, z: base.z, w: 2.4, d: 1.2, h: 0.9, color: WOOD }); // desk
  // stamp: post + arm
  const stampPivot = { x: base.x + 1.9, y: base.y + 0.6, z: base.z + 0.9 };
  cylinder(g, { x: stampPivot.x, y: stampPivot.y, z: stampPivot.z, r: 0.12, h: 1.0, color: STEEL });
  const arm = el('g', { class: 'stamp-arm' }, g);
  box(arm, { x: stampPivot.x - 0.9, y: stampPivot.y - 0.15, z: stampPivot.z + 0.85, w: 1.0, d: 0.3, h: 0.15, color: DARK });
  box(arm, { x: stampPivot.x - 1.0, y: stampPivot.y - 0.25, z: stampPivot.z + 0.55, w: 0.45, d: 0.5, h: 0.3, color: LAYER_COLOR[4] });
  // copy shelf: a rack right of the desk
  const shelfX = base.x + 2.7;
  box(g, { x: shelfX, y: base.y, z: base.z, w: 1.4, d: 1.2, h: 0.12, color: STEEL });
  box(g, { x: shelfX, y: base.y, z: base.z, w: 0.1, d: 1.2, h: 1.9, color: STEEL });
  const shelfItems = el('g', { class: 'shelf' }, g);
  const shelfLbl = billboard(g, local(t, MACHINE.x + 1.8, MACHINE.y - 0.3, f.top + 2.15), 'copies', 'mtext small');
  // hourglass: a glass cylinder with a sand level, left of the desk
  const hgX = base.x - 0.5;
  const hgY = base.y + 0.5;
  cylinder(g, { x: hgX, y: hgY, z: base.z, r: 0.28, h: 0.1, color: BRASS });
  const sand = el('g', { class: 'sand' }, g);
  const sandCyl = cylinder(sand, { x: hgX, y: hgY, z: base.z + 0.1, r: 0.2, h: 1.0, color: '#fbbf24' });
  cylinder(g, { x: hgX, y: hgY, z: base.z + 1.15, r: 0.28, h: 0.08, color: BRASS });
  const timerLbl = billboard(g, local(t, MACHINE.x - 2.7, MACHINE.y + 0.1, f.top + 1.6), '', 'mtext small warn');
  // UDP chute: a slanted plate at the far left
  const chute = el('g', { class: 'chute' }, g);
  tile(chute, base.x - 1.3, base.y + 0.2, 0.7, 0.9, base.z + 0.35, { fill: LAYER_COLOR[4], opacity: 0.6 });
  billboard(g, local(t, MACHINE.x - 3.0, MACHINE.y + 0.6, f.top + 0.5), 'UDP', 'mtext tiny');
  const stateLbl = billboard(g, local(t, MACHINE.x, MACHINE.y - 0.3, f.top + 2.3), '', 'mtext state');
  let built = -1;
  const anchor = local(t, MACHINE.x, MACHINE.y, f.top + 2.5);
  return {
    kind: 'tcpClerk',
    g,
    anchor,
    render(v, st, act, u) {
      const type = evType(act);
      const stamping = type === 'encapsulate' && act?.event.type === 'encapsulate' && act.event.protocol === 'tcp';
      const retx = type === 'tcp:retransmit';
      const a = stamping || retx ? press(u) : 0;
      rotateAbout(arm, stampPivot, -28 + 34 * a);
      const n = st.outstanding.length;
      if (n !== built) {
        built = n;
        shelfItems.replaceChildren();
        for (let i = 0; i < Math.min(n, 6); i++) {
          box(shelfItems, { x: shelfX + 0.25, y: base.y + 0.2, z: base.z + 0.15 + i * 0.28, w: 1.0, d: 0.8, h: 0.22, color: LAYER_COLOR[4] });
        }
        shelfLbl.textContent = n ? `${n} unacked` : 'no copies';
      }
      const udp = type === 'encapsulate' && act?.event.type === 'encapsulate' && act.event.protocol === 'udp' ? pulse(u) : 0;
      chute.style.opacity = (0.6 + 0.4 * udp).toFixed(2);
      const tm = st.timer && (st.timer.kind === 'tcp-rto' || st.timer.kind === 'tcp-timewait') ? st.timer : undefined;
      sand.style.display = tm ? '' : 'none';
      if (tm) {
        const level = 1 - tm.fraction;
        sandCyl.setAttribute('transform', `translate(0,${((1 - level) * 32).toFixed(1)}) scale(1,${Math.max(0.02, level).toFixed(3)})`);
        timerLbl.textContent = `${tm.kind === 'tcp-rto' ? 'RTO' : 'TIME_WAIT'} ${fmtTime(tm.remaining)}`;
      } else timerLbl.textContent = '';
      stateLbl.textContent = st.tcpState ? st.tcpState : '';
      void v;
    },
  };
};

// ───────────────────────────────────────────── network ─────────────────────────────────────────────

const netStation: MachineBuilder = (parent, ctx) => {
  const { tower: t, floor: f } = ctx;
  const g = el('g', { class: 'machine m-net' }, parent);
  // signpost
  const post = local(t, MACHINE.x - 1.2, MACHINE.y, f.top);
  cylinder(g, { x: post.x, y: post.y, z: post.z, r: 0.12, h: 2.2, color: STEEL });
  const arrow = el('g', { class: 'arrow' }, g);
  box(arrow, { x: post.x - 0.1, y: post.y - 0.12, z: post.z + 1.7, w: 1.3, d: 0.24, h: 0.32, color: LAYER_COLOR[3] });
  const arrowLbl = billboard(g, local(t, MACHINE.x - 1.2, MACHINE.y - 0.1, f.top + 2.55), '', 'mtext small');
  // TTL punch
  const punchX = MACHINE.x + 0.8;
  const pb = local(t, punchX, MACHINE.y - 0.4, f.top);
  box(g, { x: pb.x, y: pb.y, z: pb.z, w: 1.3, d: 1.0, h: 0.4, color: DARK });
  box(g, { x: pb.x + 1.05, y: pb.y + 0.3, z: pb.z + 0.4, w: 0.2, d: 0.4, h: 1.5, color: STEEL });
  const head = el('g', { class: 'punch-head' }, g);
  box(head, { x: pb.x + 0.2, y: pb.y + 0.2, z: pb.z + 1.3, w: 0.9, d: 0.6, h: 0.3, color: STEEL });
  const punchLbl = billboard(g, local(t, punchX + 0.6, MACHINE.y - 0.3, f.top + 2.0), 'TTL −1', 'mtext tiny');
  return {
    kind: 'netStation',
    g,
    anchor: local(t, MACHINE.x, MACHINE.y, f.top + 2.7),
    render(_v, st, act, u) {
      const type = evType(act);
      const swing = type === 'route' ? pulse(u) * 10 : 0;
      const dir = st.route?.outIface.endsWith('lan') || st.route?.outIface.endsWith('cust') || st.route?.outIface.endsWith('eth0') && st.route.nextHop.startsWith('198') ? 180 : 0;
      rotateAbout(arrow, { ...post, z: post.z + 1.86 }, (dir ? 180 : 0) + swing);
      arrowLbl.textContent = st.route ? `→ ${st.route.nextHop}` : '';
      const p = type === 'forward' ? press(u) : 0;
      const d = iso(0, 0, -0.75 * p);
      head.setAttribute('transform', `translate(${d.sx.toFixed(2)},${d.sy.toFixed(2)})`);
      punchLbl.style.opacity = p > 0.5 ? '1' : '0.5';
    },
  };
};

const natDesk: MachineBuilder = (parent, ctx) => {
  const { tower: t, floor: f } = ctx;
  const g = el('g', { class: 'machine m-nat' }, parent);
  const base = local(t, MACHINE.x + 1.6, MACHINE.y - 0.5, f.top);
  box(g, { x: base.x, y: base.y, z: base.z, w: 1.8, d: 1.0, h: 1.0, color: WOOD });
  const plate = el('g', { class: 'nat-plate' }, g);
  box(plate, { x: base.x + 0.3, y: base.y + 0.3, z: base.z + 1.0, w: 1.2, d: 0.5, h: 0.12, color: '#f8fafc' });
  const plateLbl = billboard(g, local(t, MACHINE.x + 2.5, MACHINE.y - 0.2, f.top + 1.45), 'NAT', 'mtext tiny');
  const ledger = billboard(g, local(t, MACHINE.x + 2.5, MACHINE.y, f.top + 2.2), '', 'mtext small');
  return {
    kind: 'natDesk',
    g,
    anchor: local(t, MACHINE.x + 2.5, MACHINE.y, f.top + 2.5),
    render(_v, st, act, u) {
      const type = evType(act);
      const flip = type === 'nat:translate' ? pulse(u) : 0;
      const c = iso(base.x + 0.9, base.y + 0.55, base.z + 1.06);
      plate.setAttribute('transform', `translate(${c.sx.toFixed(2)},${c.sy.toFixed(2)}) scale(${(1 - 1.8 * flip * (1 - flip)).toFixed(3)},1) translate(${(-c.sx).toFixed(2)},${(-c.sy).toFixed(2)})`);
      plateLbl.textContent = type === 'nat:translate' && act?.event.type === 'nat:translate' ? `${act.event.after.ip}:${act.event.after.port}` : 'NAT';
      ledger.textContent = st.nat.length ? `${st.nat.length} mapping${st.nat.length > 1 ? 's' : ''}` : '';
    },
  };
};

// ───────────────────────────────────────────── link ─────────────────────────────────────────────

const linkStation: MachineBuilder = (parent, ctx) => {
  const { tower: t, floor: f } = ctx;
  const g = el('g', { class: 'machine m-link' }, parent);
  // megaphone on a stand (left)
  const mp = local(t, MACHINE.x - 1.9, MACHINE.y + 0.2, f.top);
  cylinder(g, { x: mp.x, y: mp.y, z: mp.z, r: 0.12, h: 1.1, color: STEEL });
  const horn = el('g', { class: 'horn' }, g);
  const hornHit = el('g', { class: 'machine-hit' }, horn);
  cylinder(hornHit, { x: mp.x, y: mp.y, z: mp.z + 1.1, r: 0.22, h: 0.35, color: BRASS });
  cylinder(hornHit, { x: mp.x, y: mp.y, z: mp.z + 1.45, r: 0.42, h: 0.3, color: BRASS });
  const shout = el('g', { class: 'shout' }, g);
  for (let i = 1; i <= 3; i++) {
    const c = iso(mp.x, mp.y, mp.z + 1.9 + i * 0.25);
    el('ellipse', { cx: c.sx, cy: c.sy, rx: 10 + i * 9, ry: 5 + i * 4.5, class: 'shout-ring' }, shout);
  }
  // address book (billboard list)
  const bookLbl = billboard(g, local(t, MACHINE.x - 1.9, MACHINE.y + 0.1, f.top + 2.35), 'ARP cache', 'mtext tiny');
  const bookList = billboard(g, local(t, MACHINE.x - 1.9, MACHINE.y + 0.1, f.top + 2.05), '', 'mtext small');
  // bolter (press) in the middle
  const bb = local(t, MACHINE.x + 0.2, MACHINE.y - 0.4, f.top);
  box(g, { x: bb.x, y: bb.y, z: bb.z, w: 1.4, d: 1.0, h: 0.3, color: DARK });
  box(g, { x: bb.x + 1.15, y: bb.y + 0.3, z: bb.z + 0.3, w: 0.2, d: 0.4, h: 1.7, color: STEEL });
  const bolt = el('g', { class: 'bolt-head' }, g);
  box(bolt, { x: bb.x + 0.2, y: bb.y + 0.2, z: bb.z + 1.4, w: 0.9, d: 0.6, h: 0.3, color: LAYER_COLOR[2] });
  billboard(g, local(t, MACHINE.x + 0.9, MACHINE.y - 0.3, f.top + 2.15), 'shell press', 'mtext tiny');
  // checksum scale (right)
  const sb = local(t, MACHINE.x + 2.3, MACHINE.y + 0.2, f.top);
  cylinder(g, { x: sb.x, y: sb.y, z: sb.z, r: 0.14, h: 0.9, color: STEEL });
  const pan = el('g', { class: 'pan' }, g);
  tile(pan, sb.x - 0.6, sb.y - 0.4, 1.2, 0.8, sb.z + 0.95, { fill: BRASS, opacity: 0.9 });
  const scaleLbl = billboard(g, local(t, MACHINE.x + 2.3, MACHINE.y + 0.2, f.top + 1.5), 'CRC check', 'mtext tiny');
  return {
    kind: 'linkStation',
    g,
    anchor: local(t, MACHINE.x, MACHINE.y, f.top + 2.7),
    hit: hornHit,
    render(_v, st, act, u, blocked) {
      const type = evType(act);
      const ev = act?.event;
      const arpTx = type === 'encapsulate' && ev?.type === 'encapsulate' && ev.protocol === 'arp';
      const a = arpTx ? pulse(u) : 0;
      shout.style.opacity = a.toFixed(2);
      horn.classList.toggle('blocked', blocked);
      const c = iso(mp.x, mp.y, mp.z + 1.5);
      horn.setAttribute('transform', `translate(${c.sx},${c.sy}) scale(${(1 + 0.15 * a).toFixed(3)}) translate(${-c.sx},${-c.sy})`);
      const ethTx = type === 'encapsulate' && ev?.type === 'encapsulate' && ev.protocol === 'ethernet';
      const p = ethTx ? press(u) : 0;
      const d = iso(0, 0, -0.8 * p);
      bolt.setAttribute('transform', `translate(${d.sx.toFixed(2)},${d.sy.toFixed(2)})`);
      const weigh = type === 'decapsulate' && ev?.type === 'decapsulate' && ev.layer === 2 ? pulse(u) : 0;
      const sc = iso(sb.x, sb.y, sb.z + 0.95);
      pan.setAttribute('transform', `translate(${sc.sx},${sc.sy}) rotate(${(-6 * weigh).toFixed(2)}) translate(${-sc.sx},${-sc.sy})`);
      scaleLbl.textContent = weigh > 0.6 ? 'CRC ✓' : 'CRC check';
      const n = st.arp.length;
      bookList.textContent = n ? `${n} entr${n === 1 ? 'y' : 'ies'}` : 'empty';
      bookLbl.textContent = 'ARP cache';
    },
  };
};

// ───────────────────────────────────────────── physical ─────────────────────────────────────────────

const port: MachineBuilder = (parent, ctx) => {
  const { floor: f, port: p } = ctx;
  if (!p) throw new Error('port machine needs a port');
  const g = el('g', { class: 'machine m-port' }, parent);
  const s = p.stand;
  box(g, { x: s.x - 0.5, y: s.y - 0.45, z: f.top, w: 1.0, d: 0.9, h: 0.8, color: DARK });
  const led = el('circle', { class: 'led', r: 3 }, g);
  const lc = iso(s.x, s.y + 0.46, f.top + 0.55);
  led.setAttribute('cx', lc.sx.toFixed(1));
  led.setAttribute('cy', lc.sy.toFixed(1));
  // lever
  const pivot = { x: s.x, y: s.y, z: f.top + 0.8 };
  const lever = el('g', { class: 'lever machine-hit' }, g);
  line(lever, pivot, { ...pivot, z: pivot.z + 0.9 }, { class: 'lever-rod' });
  const knob = el('circle', { class: 'lever-knob', r: 4.5 }, lever);
  const kc = iso(pivot.x, pivot.y, pivot.z + 0.9);
  knob.setAttribute('cx', kc.sx.toFixed(1));
  knob.setAttribute('cy', kc.sy.toFixed(1));
  // cable stub from the stand down to the socket
  line(g, { x: s.x, y: s.y + 0.45, z: f.top + 0.1 }, p.socket, { class: 'cable-stub' });
  const ifaceName = p.ifaceId.split('.')[1] ?? p.ifaceId;
  billboard(g, { x: s.x, y: s.y, z: f.top + 2.1 }, ifaceName, 'mtext tiny');
  return {
    kind: 'port',
    iface: p.ifaceId,
    g,
    anchor: { x: s.x, y: s.y, z: f.top + 2.3 },
    hit: lever,
    render(v, _st, act, u, blocked) {
      const type = evType(act);
      const sending = type === 'tx' ? press(u) : 0;
      rotateAbout(lever, pivot, (p.side === 'left' || p.side === 'left2' ? -1 : 1) * 40 * sending);
      lever.classList.toggle('blocked', blocked);
      const active = type === 'tx' || type === 'rx';
      led.setAttribute('fill', active ? (Math.sin(v * 40) > 0 ? '#22c55e' : '#166534') : '#1f2937');
    },
  };
};

export const BUILDERS: Record<MachineKind, MachineBuilder> = { browser, dnsDesk, httpShelf, tcpClerk, netStation, natDesk, linkStation, port };

function P(x: number, y: number, z: number): string {
  const p = iso(x, y, z);
  return `${p.sx.toFixed(2)} ${p.sy.toFixed(2)}`;
}

export { lerp, placeBillboard, at, FD, PART_D };
export type { MachineCtx, MachineView, DeviceState };

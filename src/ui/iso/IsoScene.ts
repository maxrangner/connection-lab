import type { DeviceSpec, LayerNum } from '../../sim';
import { LAYER_COLOR, layerLabel, PROTOCOL_NAME, type LayerModel } from '../content/layers';
import { MAX_LEN, GizmoView, type GizmoPose } from '../gizmo/GizmoView';
import { el, show } from '../scene/svg';
import type { Bubble, Flight, Gate, Keyframe, Schedule, Track } from '../timeline/schedule';
import { Bubbles } from './Bubbles';
import { Camera, type CameraMode, type ScreenRect } from './Camera';
import { buildWorld, FD, floorOf, FLOOR_H, FW, PART_D, SLOT, type TowerGeom, type WorldGeom } from './layout';
import { MACHINE_FLOOR, machinesFor, type MachineKind } from './machines/Machine';
import { billboard, box, line, tile } from './prims';
import { clamp01, easeInOut, easeOut, iso, lerp, U, type Vec3 } from './project';
import { buildStation, type StationView } from './stations';

export interface SceneHandlers {
  onPickPdu(pduId: string, ctx: { flight?: Flight; track?: Track }): void;
  onPickDevice(deviceId: string): void;
  /** The operator did what a gate asked for. */
  onGateAction(gate: Gate): void;
  onDismissBubble(b: Bubble): void;
}

export interface RenderCtx {
  selectedPdu?: string;
  /** Gate playback is stopped at, if any. */
  blocked?: Gate;
  model: LayerModel;
}

interface Factory {
  spec: DeviceSpec;
  tower: TowerGeom;
  g: SVGGElement;
  stations: StationView[];
}

function lerpV(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/** Isometric scene: calm towers of glass floors with one station each, packets as gizmos that travel whole. */
export class IsoScene {
  readonly svg: SVGSVGElement;
  readonly camera: Camera;
  readonly gOverlay: SVGGElement;
  private gGround: SVGGElement;
  private gFactories: SVGGElement;
  private gGizmos: SVGGElement;
  private gTags: SVGGElement;
  private gWire: SVGGElement;
  private bubbles: Bubbles;
  private hint: HTMLElement;
  private world!: WorldGeom;
  private factories = new Map<string, Factory>();
  private schedule!: Schedule;
  private gizmos = new Map<string, GizmoView>();
  private visible = new Set<string>();
  /** What each visible gizmo currently is (for clicks). */
  private pickCtx = new Map<string, { flight?: Flight; track?: Track }>();
  private dirOf = new Map<string, 1 | -1>();
  private incoming = new Set<string>();
  private tags: SVGTextElement[] = [];
  private lostMarks = new Map<string, SVGGElement>();
  private blockedGate: Gate | undefined;
  private drag: { gate: Gate; track: Track; dx: number; dy: number; start: { x: number; y: number }; moved: number } | undefined;

  constructor(
    private readonly container: HTMLElement,
    private readonly handlers: SceneHandlers,
  ) {
    this.svg = el('svg', { class: 'scene iso', preserveAspectRatio: 'xMidYMid meet' });
    container.appendChild(this.svg);
    const defs = el('defs', {}, this.svg);
    const glow = el('filter', { id: 'glow', x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs);
    el('feGaussianBlur', { stdDeviation: 2.2, result: 'b' }, glow);
    const merge = el('feMerge', {}, glow);
    el('feMergeNode', { in: 'b' }, merge);
    el('feMergeNode', { in: 'SourceGraphic' }, merge);
    this.gGround = el('g', { class: 'ground' }, this.svg);
    this.gFactories = el('g', { class: 'factories' }, this.svg);
    this.gGizmos = el('g', { class: 'gizmos' }, this.svg);
    this.gWire = el('g', { class: 'wire' }, this.svg);
    this.gTags = el('g', { class: 'tags' }, this.svg);
    this.gOverlay = el('g', { class: 'overlay' }, this.svg);
    this.camera = new Camera(this.svg, container);
    this.bubbles = new Bubbles(container, this.svg);
    this.bubbles.setDismiss((b) => this.handlers.onDismissBubble(b));
    this.hint = document.createElement('div');
    this.hint.className = 'hint';
    this.hint.style.display = 'none';
    container.appendChild(this.hint);
    this.installOperator();
  }

  setSchedule(s: Schedule, model: LayerModel): void {
    this.schedule = s;
    this.world = buildWorld(s.result.scenario);
    for (const g of [this.gGround, this.gFactories, this.gGizmos, this.gWire, this.gTags]) g.replaceChildren();
    this.factories.clear();
    this.gizmos.clear();
    this.visible.clear();
    this.pickCtx.clear();
    this.tags = [];
    this.lostMarks.clear();
    this.buildGround();
    const ordered = [...s.result.scenario.devices].sort((a, b) => this.world.towers.get(a.id)!.depth - this.world.towers.get(b.id)!.depth);
    for (const d of ordered) this.buildFactory(d, model);
    this.computeDirections();
    const B = this.world.bounds;
    const corners = [iso(B.x0, B.y0, B.zTop), iso(B.x1, B.y0, B.zTop), iso(B.x0, B.y1, 0), iso(B.x1, B.y1, 0), iso(B.x1, B.y0, 0), iso(B.x0, B.y1, B.zTop)];
    this.camera.setBounds({ x0: Math.min(...corners.map((c) => c.sx)) - 20, y0: Math.min(...corners.map((c) => c.sy)) - 60, x1: Math.max(...corners.map((c) => c.sx)) + 20, y1: Math.max(...corners.map((c) => c.sy)) + 30 });
  }

  /**
   * A packet never changes direction: requests travel +x, replies −x. Its byte 0 always leads. Packets that never
   * fly (application streams) take the direction of the device's sending side, or the opposite if they arrived.
   */
  private computeDirections(): void {
    const s = this.schedule;
    this.dirOf.clear();
    this.incoming.clear();
    const towerX = (id: string): number => this.world.towers.get(id)!.origin.x;
    for (const f of s.flights) if (!this.dirOf.has(f.packetId)) this.dirOf.set(f.packetId, towerX(f.to) > towerX(f.from) ? 1 : -1);
    for (const t of s.tracks) {
      const first = t.kfs[0];
      if (!first || first.mode !== 'appear') continue;
      const e = s.result.events[first.seq];
      if (e?.type === 'app' && e.action.endsWith('-received')) this.incoming.add(t.id);
    }
  }

  private sendDir(deviceId: string): 1 | -1 {
    const t = this.world.towers.get(deviceId)!;
    const side = t.ports[0]?.side ?? 'right';
    return side === 'right' || side === 'right2' ? 1 : -1;
  }

  private trackDir(t: Track): 1 | -1 {
    const d = this.dirOf.get(t.packetId);
    if (d) return d;
    const send = this.sendDir(t.deviceId);
    return this.incoming.has(t.id) ? (send > 0 ? -1 : 1) : send;
  }

  get sceneBounds(): ScreenRect {
    return this.camera.sceneBounds;
  }

  setCameraMode(m: CameraMode): void {
    this.camera.setMode(m);
  }

  get cameraMode(): CameraMode {
    return this.camera.mode;
  }

  set insets(v: { right: number; bottom: number }) {
    this.camera.insets = v;
  }

  toScene(cx: number, cy: number): { x: number; y: number } {
    return this.camera.toScene(cx, cy);
  }

  /** Screen point of a device's top floor slot (the URL card's drop target). */
  deviceCenter(id: string): { x: number; y: number } {
    const t = this.world.towers.get(id)!;
    const f = t.floors[t.floors.length - 1]!;
    const p = iso(f.slot.x + MAX_LEN / 2, f.slot.y + 0.5, f.top + 0.6);
    return { x: p.sx, y: p.sy };
  }

  setBlocked(g: Gate | undefined): void {
    this.blockedGate = g;
  }

  // ───────────────────────────── building ─────────────────────────────

  private buildGround(): void {
    for (const t of this.world.towers.values()) {
      tile(this.gGround, t.origin.x - 0.4, t.origin.y - 0.4, FW + 0.8, FD + 0.8, 0, { class: 'pad' });
    }
    for (const c of this.world.cables.values()) {
      const g = el('g', { class: 'cable', 'data-id': c.id }, this.gGround);
      const a = c.points[0]!;
      const b = c.points[c.points.length - 1]!;
      line(g, a, b, { class: 'cable-shadow' });
      line(g, a, b, { class: 'cable-line' });
      billboard(g, { x: (a.x + b.x) / 2, y: a.y, z: 0 }, c.spec.label, 'cable-label', { 'text-anchor': 'middle', dy: 18 });
    }
  }

  private buildFactory(spec: DeviceSpec, model: LayerModel): void {
    const tower = this.world.towers.get(spec.id)!;
    const g = el('g', { class: `factory dev-${spec.kind}`, 'data-id': spec.id }, this.gFactories);
    const o = tower.origin;
    const topFloor = tower.floors[tower.floors.length - 1]!;
    // A faint elevator band behind the slot: the path packets take between floors.
    const x0 = o.x + SLOT.x - 0.2;
    const x1 = o.x + SLOT.x + MAX_LEN + 0.2;
    const y = o.y + SLOT.y - 0.05;
    const p = (x: number, z: number): string => {
      const s = iso(x, y, z);
      return `${s.sx.toFixed(1)} ${s.sy.toFixed(1)}`;
    };
    el('path', { class: 'shaft', d: `M${p(x0, 0)}L${p(x1, 0)}L${p(x1, topFloor.top + 1.6)}L${p(x0, topFloor.top + 1.6)}Z` }, g);
    const stations: StationView[] = [];
    for (const f of tower.floors) {
      const fg = el('g', { class: 'floor', 'data-layer': f.layer }, g);
      box(fg, { x: o.x, y: o.y, z: f.z, w: FW, d: FD, h: 0.12, color: '#22304d', cls: 'glass' });
      box(fg, { x: o.x, y: o.y + FD - 0.1, z: f.z + 0.12, w: FW, d: 0.1, h: 0.03, color: LAYER_COLOR[f.layer] });
      billboard(fg, { x: o.x + 0.15, y: o.y + FD, z: f.z + 0.14 }, layerLabel(f.layer, model), 'floor-label', { dy: 12 });
      for (const kind of machinesFor(spec.kind)) {
        if (MACHINE_FLOOR[kind] !== f.layer) continue;
        if (kind === 'port') for (const port of tower.ports) stations.push(buildStation(fg, kind, tower, f, port));
        else stations.push(buildStation(fg, kind, tower, f));
      }
    }
    if (model === 'osi' && spec.kind !== 'router' && spec.kind !== 'home-router') {
      billboard(g, { x: o.x + FW - 0.1, y: o.y + FD, z: topFloor.top + 0.05 }, 'L6/L5 inside the app', 'floor-label plaque', { 'text-anchor': 'end', dy: 12 });
    }
    // Name above the tower; click it for the device's tables.
    const name = el('g', { class: 'tower-name' }, g);
    billboard(name, { x: o.x + FW / 2, y: o.y + FD / 2, z: topFloor.top + FLOOR_H * 0.55 }, spec.label, 'tower-title', { 'text-anchor': 'middle' });
    billboard(name, { x: o.x + FW / 2, y: o.y + FD / 2, z: topFloor.top + FLOOR_H * 0.55 }, spec.sublabel ?? '', 'tower-sub', { 'text-anchor': 'middle', dy: 15 });
    name.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handlers.onPickDevice(spec.id);
    });
    this.factories.set(spec.id, { spec, tower, g, stations });
  }

  // ───────────────────────────── per frame ─────────────────────────────

  render(v: number, dt: number, ctx: RenderCtx): void {
    if (!this.schedule) return;
    const s = this.schedule;
    const speaking = this.activeBubbles(v, ctx.blocked);
    const speakingDev = new Set(speaking.map((b) => b.deviceId));
    for (const f of this.factories.values()) {
      const st = s.deviceStateAt(f.spec.id, v);
      f.g.classList.toggle('dim', speaking.length > 0 && !speakingDev.has(f.spec.id));
      for (const m of f.stations) {
        const act = this.actFor(f.spec.id, m, v);
        const u = act ? (v - act.v0) / Math.max(1e-6, act.v1 - act.v0) : 0;
        const blocked = !!ctx.blocked && ctx.blocked.kind === 'operator' && ctx.blocked.deviceId === f.spec.id && ctx.blocked.machine === m.kind && (!ctx.blocked.iface || ctx.blocked.iface === m.iface);
        m.render(v, st, act, u, blocked);
      }
    }
    const now = new Set<string>();
    this.pickCtx.clear();
    const tagIdx = this.renderTracks(v, ctx, now, 0);
    this.renderFlights(v, ctx, now);
    for (const id of this.visible) if (!now.has(id)) show(this.gizmos.get(id)!.g, false);
    this.visible = now;
    for (let i = tagIdx; i < this.tags.length; i++) this.tags[i]!.style.display = 'none';
    this.renderBubbles(v, speaking, ctx);
    this.renderHint(ctx.blocked);
    this.camera.update(this.focusFrame(v), (this.camera.sceneBounds.x1 - this.camera.sceneBounds.x0) / 2.6, dt);
  }

  private actFor(deviceId: string, m: StationView, v: number) {
    let best: Schedule['acts'][number] | undefined;
    for (const a of this.schedule.acts) {
      if (a.v0 > v) break;
      if (a.deviceId !== deviceId || a.machine !== m.kind) continue;
      if (m.kind === 'port' && a.iface && a.iface !== m.iface) continue;
      if (v < a.v1 + 0.15) best = a;
    }
    return best;
  }

  private gizmo(pduId: string, packetId: string, dir: 1 | -1): GizmoView {
    let g = this.gizmos.get(pduId);
    if (!g) {
      const pdu = this.schedule.result.pdus.get(pduId)!;
      g = new GizmoView(pdu, this.schedule.result.packets.get(packetId), dir);
      g.g.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handlers.onPickPdu(pduId, this.pickCtx.get(pduId) ?? {});
      });
      g.g.addEventListener('pointerdown', (e) => this.gizmoPointerDown(e, pduId));
      this.gGizmos.appendChild(g.g);
      this.gizmos.set(pduId, g);
    }
    return g;
  }

  /** Lead position of a gizmo resting in a floor's slot. */
  private slotLead(t: TowerGeom, z: number, dir: 1 | -1): Vec3 {
    const slot = t.floors[0]!.slot;
    return { x: dir > 0 ? slot.x + MAX_LEN : slot.x, y: slot.y, z };
  }

  private portOf(t: TowerGeom, ifaceId: string | undefined) {
    return t.ports.find((p) => p.ifaceId === ifaceId) ?? t.ports[0]!;
  }

  /** Where the gizmo sits on the cable next to a socket (lead at the socket, centred on the cable). */
  private cableLead(t: TowerGeom, ifaceId: string | undefined): Vec3 {
    const p = this.portOf(t, ifaceId);
    return { x: p.socket.x, y: p.socket.y - PART_D / 2, z: 0 };
  }

  private edgeLead(t: TowerGeom, dir: 1 | -1, z: number, inbound: boolean): Vec3 {
    const o = t.origin;
    const slot = t.floors[0]!.slot;
    // Outbound: the leading face reaches the tower edge on its side. Inbound: it has just come in on the other side.
    const x = inbound ? (dir > 0 ? o.x + 0.3 : o.x + FW - 0.3) : dir > 0 ? o.x + FW + 0.3 : o.x - 0.3;
    return { x, y: slot.y, z };
  }

  private renderTracks(v: number, ctx: RenderCtx, now: Set<string>, tagIdx: number): number {
    for (const tr of this.schedule.tracks) {
      const first = tr.kfs[0];
      if (!first || v < first.v0 || v >= tr.end) continue;
      const f = this.factories.get(tr.deviceId);
      if (!f) continue;
      const t = f.tower;
      let kf = first;
      for (const k of tr.kfs) if (k.v0 <= v) kf = k;
      const u = clamp01((v - kf.v0) / Math.max(1e-6, kf.v1 - kf.v0));
      const e = easeInOut(u);
      const dir = this.trackDir(tr);
      const zOf = (row: LayerNum): number => floorOf(t, row).top;
      let pduId = kf.pduId;
      const pose: GizmoPose = { lead: this.slotLead(t, lerp(zOf(kf.fromRow), zOf(kf.row), e), dir), grow: 1, spread: 0, assemble: 1, diff: 0, opacity: 1, consumed: 0, lost: 0 };
      const isApp = (id: string): boolean => {
        const p = this.schedule.result.pdus.get(id)?.first;
        return p === 'dns' || p === 'http';
      };
      switch (kf.mode) {
        case 'appear':
          pose.assemble = u;
          break;
        case 'encap':
          if (isApp(kf.pduId)) pose.assemble = u;
          else pose.grow = u;
          break;
        case 'decap':
          if (u < 1 && kf.fromPduId) {
            pduId = kf.fromPduId;
            pose.grow = 1 - u;
          }
          break;
        case 'change':
          pose.diff = u < 0.8 ? Math.sin(Math.PI * (u / 0.8)) : 0.3;
          pose.diffBytes = kf.diff;
          break;
        case 'tx': {
          if (kf.fromPduId) pduId = kf.fromPduId;
          const zPhys = zOf(1);
          const a = clamp01(u / 0.2);
          const b = clamp01((u - 0.2) / 0.4);
          const c = clamp01((u - 0.6) / 0.4);
          const atSlot = this.slotLead(t, lerp(zOf(kf.fromRow), zPhys, easeInOut(a)), dir);
          const edge = this.edgeLead(t, dir, zPhys, false);
          const cable = this.cableLead(t, kf.iface);
          let lead = atSlot;
          if (b > 0) lead = lerpV(atSlot, edge, easeInOut(b));
          if (c > 0) lead = lerpV(edge, cable, easeInOut(c));
          pose.lead = lead;
          pose.spread = easeInOut(c);
          break;
        }
        case 'rx': {
          const zPhys = zOf(1);
          const a = clamp01(u / 0.5);
          const b = clamp01((u - 0.5) / 0.3);
          const c = clamp01((u - 0.8) / 0.2);
          const cable = this.cableLead(t, kf.iface);
          const edge = this.edgeLead(t, dir, zPhys, true);
          const atSlot = this.slotLead(t, zPhys, dir);
          let lead = lerpV(cable, edge, easeInOut(a));
          if (b > 0) lead = lerpV(edge, atSlot, easeInOut(b));
          if (c > 0) lead = this.slotLead(t, lerp(zPhys, zOf(kf.row), easeInOut(c)), dir);
          pose.lead = lead;
          pose.spread = 1 - easeInOut(a);
          break;
        }
      }
      const left = tr.end - v;
      if (left < 0.4) {
        const k = clamp01(left / 0.4);
        pose.opacity *= k;
        if (tr.endKind === 'absorb') pose.lead = { ...pose.lead, z: pose.lead.z + (1 - k) * 0.6 };
      }
      if (tr.isStream && tr.consumed?.length) {
        let bytes = 0;
        for (const c of tr.consumed) if (c.v <= v) bytes = c.bytes;
        const total = this.schedule.result.pdus.get(pduId)?.bytes.length ?? 1;
        pose.consumed = clamp01(bytes / total);
      }
      if (this.drag && this.drag.track === tr) {
        pose.lead = { x: pose.lead.x + this.drag.dx, y: pose.lead.y + this.drag.dy, z: pose.lead.z };
      }
      const gv = this.gizmo(pduId, tr.packetId, dir);
      gv.pose(pose);
      gv.g.classList.toggle('selected', ctx.selectedPdu === pduId);
      gv.g.classList.toggle('dropped', tr.endKind === 'drop' && left < 1.0);
      gv.g.classList.toggle('draggable', !!ctx.blocked && ctx.blocked.action === 'drag-cell' && ctx.blocked.deviceId === tr.deviceId && tr.isStream === true);
      show(gv.g, true);
      now.add(pduId);
      this.pickCtx.set(pduId, { track: tr });
      tagIdx = this.renderTag(tagIdx, kf, u, tr.deviceId);
    }
    return tagIdx;
  }

  /** A short text rising from the station that acts on the packet: "+IP 20 B", "TTL 64 → 63". */
  private renderTag(idx: number, kf: Keyframe, u: number, deviceId: string): number {
    if (u >= 1 || (kf.mode !== 'encap' && kf.mode !== 'decap' && kf.mode !== 'change')) return idx;
    const text = this.tagText(kf);
    if (!text) return idx;
    let t = this.tags[idx];
    if (!t) {
      t = el('text', { class: 'tag', 'text-anchor': 'middle' }, this.gTags);
      this.tags[idx] = t;
    }
    if (t.textContent !== text) t.textContent = text;
    t.setAttribute('class', `tag tag-${kf.mode}`);
    const act = this.schedule.acts.find((a) => a.seq === kf.seq);
    const a = act ? this.anchorFor(deviceId, act.machine, act.iface) : undefined;
    if (!a) return idx;
    const s = iso(a.x, a.y, a.z + 0.2 + 0.9 * easeOut(u));
    t.setAttribute('x', s.sx.toFixed(1));
    t.setAttribute('y', s.sy.toFixed(1));
    t.style.opacity = Math.min(1, Math.sin(Math.PI * u) * 1.6).toFixed(3);
    t.style.display = '';
    return idx + 1;
  }

  private tagText(kf: Keyframe): string | undefined {
    const r = this.schedule.result;
    if (kf.mode === 'change') {
      const e = r.events[kf.seq];
      if (e?.type === 'forward') return `TTL ${e.ttlBefore} → ${e.ttlAfter}`;
      if (e?.type === 'nat:translate') return `${e.direction === 'out' ? 'source' : 'destination'} → ${e.after.ip}:${e.after.port}`;
      return undefined;
    }
    const pdu = r.pdus.get(kf.mode === 'decap' ? (kf.fromPduId ?? kf.pduId) : kf.pduId);
    const top = pdu?.layers[0];
    if (!top || top.protocol === 'dns' || top.protocol === 'http') return undefined;
    const name = PROTOCOL_NAME[top.protocol];
    if (kf.mode === 'decap') return `−${name}`;
    const hdr = top.headerEnd - top.start;
    const trailer = top.end - top.payloadEnd;
    if (top.protocol === 'arp') return `ARP ${hdr} B`;
    return `+${name} ${hdr} B${trailer ? ` + ${trailer} B` : ''}`;
  }

  private renderFlights(v: number, ctx: RenderCtx, now: Set<string>): void {
    const busyCables = new Set<string>();
    for (const fl of this.schedule.flights) {
      if (v < fl.v0 || v >= fl.v1) {
        const m = this.lostMarks.get(fl.id);
        if (m) m.style.display = 'none';
        continue;
      }
      const from = this.world.towers.get(fl.from)!;
      const to = this.world.towers.get(fl.to)!;
      const dir = this.dirOf.get(fl.packetId) ?? (to.origin.x > from.origin.x ? 1 : -1);
      const start = this.cableLead(from, fl.fromIface);
      const end = this.cableLead(to, fl.toIface);
      const lostAt = fl.lostAt;
      const travelEnd = lostAt ?? fl.v1;
      const total = lostAt !== undefined ? (lostAt - fl.v0) * 2 : fl.v1 - fl.v0;
      const u = clamp01((Math.min(v, travelEnd) - fl.v0) / Math.max(1e-6, total));
      const lead = lerpV(start, end, u);
      const lost = lostAt !== undefined && v >= lostAt ? v - lostAt : 0;
      const gv = this.gizmo(fl.frameId, fl.packetId, dir);
      gv.pose({ lead, grow: 1, spread: 1, assemble: 1, diff: 0, opacity: 1, consumed: 0, lost });
      gv.g.classList.toggle('selected', ctx.selectedPdu === fl.frameId);
      gv.g.classList.toggle('dropped', false);
      show(gv.g, true);
      now.add(fl.frameId);
      this.pickCtx.set(fl.frameId, { flight: fl });
      busyCables.add(fl.linkId);
      this.renderLost(fl, lead, lost);
    }
    for (const c of Array.from(this.gGround.querySelectorAll('.cable'))) c.classList.toggle('busy', busyCables.has(c.getAttribute('data-id') ?? ''));
  }

  private renderLost(fl: Flight, lead: Vec3, age: number): void {
    let g = this.lostMarks.get(fl.id);
    if (age <= 0) {
      if (g) g.style.display = 'none';
      return;
    }
    if (!g) {
      g = el('g', { class: 'lost' }, this.gWire);
      let seed = fl.seq * 9301 + 49297;
      const rnd = (): number => ((seed = (seed * 233280 + 49297) % 233280) / 233280);
      for (let i = 0; i < 14; i++) el('rect', { width: 2.6, height: 2.6, fill: i % 3 ? '#f59e0b' : '#e2e8f0', 'data-vx': (rnd() - 0.5) * 90, 'data-vy': (rnd() - 0.8) * 80 }, g);
      el('text', { class: 'lost-text', 'text-anchor': 'middle' }, g).textContent = '✕ lost';
      this.lostMarks.set(fl.id, g);
    }
    g.style.display = '';
    const p = iso(lead.x, lead.y, 0.4);
    const k = clamp01(age / 1.0);
    const e = easeOut(k);
    for (const r of Array.from(g.querySelectorAll('rect'))) {
      r.setAttribute('x', (p.sx + Number(r.getAttribute('data-vx')) * e).toFixed(1));
      r.setAttribute('y', (p.sy + Number(r.getAttribute('data-vy')) * e + 50 * k * k).toFixed(1));
      r.style.opacity = (1 - k * 0.9).toFixed(2);
    }
    const t = g.querySelector('text')!;
    t.setAttribute('x', p.sx.toFixed(1));
    t.setAttribute('y', (p.sy - 30).toFixed(1));
  }

  // ───────────────────────────── bubbles, hints, camera ─────────────────────────────

  private activeBubbles(v: number, blocked: Gate | undefined): Bubble[] {
    const byDev = new Map<string, Bubble>();
    for (const b of this.schedule.bubbles) {
      if (b.v0 > v) break;
      if (!b.shown) continue;
      if (v < b.v1 || (blocked?.kind === 'bubble' && blocked.seq === b.seq)) byDev.set(b.deviceId, b);
    }
    return [...byDev.values()].slice(-2);
  }

  private anchorFor(deviceId: string, machine: MachineKind, iface?: string): Vec3 {
    const f = this.factories.get(deviceId);
    const m = f?.stations.find((x) => x.kind === machine && (machine !== 'port' || !iface || x.iface === iface));
    if (m) return m.anchor;
    const t = this.world.towers.get(deviceId)!;
    return { x: t.origin.x + FW / 2, y: t.origin.y + FD / 2, z: t.roofZ };
  }

  private renderBubbles(v: number, speaking: Bubble[], ctx: RenderCtx): void {
    this.bubbles.render(
      speaking.map((b) => {
        const a = this.anchorFor(b.deviceId, b.machine, b.iface);
        return {
          b,
          anchor: { ...a, z: a.z + 0.4 },
          gate: !!ctx.blocked && ctx.blocked.kind === 'bubble' && ctx.blocked.seq === b.seq,
          age: v - b.v0,
          left: b.v1 - v,
        };
      }),
    );
  }

  private renderHint(blocked: Gate | undefined): void {
    if (!blocked || blocked.kind !== 'operator') {
      this.hint.style.display = 'none';
      return;
    }
    if (this.hint.dataset.id !== blocked.id) {
      this.hint.dataset.id = blocked.id;
      this.hint.replaceChildren();
      const t = document.createElement('div');
      t.className = 'hint-text';
      t.textContent = blocked.hint;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn hint-skip';
      btn.textContent = 'Do it for me';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handlers.onGateAction(blocked);
      });
      this.hint.append(t, btn);
    }
    const a = this.anchorFor(blocked.deviceId, blocked.machine, blocked.iface);
    const s = iso(a.x + 2.2, a.y, a.z);
    const m = this.svg.getScreenCTM();
    const r = this.container.getBoundingClientRect();
    if (m) {
      const p = new DOMPoint(s.sx, s.sy).matrixTransform(m);
      this.hint.style.transform = `translate(${(p.x - r.left).toFixed(1)}px, ${(p.y - r.top).toFixed(1)}px) translate(0, -50%)`;
    }
    this.hint.style.display = '';
  }

  private towerRect(t: TowerGeom): ScreenRect {
    const o = t.origin;
    const top = t.floors[t.floors.length - 1]!.top + FLOOR_H * 0.8;
    const pts = [iso(o.x, o.y, top), iso(o.x + FW, o.y, top), iso(o.x, o.y + FD + 2.5, 0), iso(o.x + FW, o.y + FD + 2.5, 0), iso(o.x + FW, o.y, 0), iso(o.x, o.y + FD, 0)];
    return { x0: Math.min(...pts.map((p) => p.sx)) - 40, y0: Math.min(...pts.map((p) => p.sy)) - 40, x1: Math.max(...pts.map((p) => p.sx)) + 40, y1: Math.max(...pts.map((p) => p.sy)) + 20 };
  }

  private focusFrame(v: number): ScreenRect | undefined {
    if (v >= this.schedule.duration - 1.6) return undefined;
    let bestV = -Infinity;
    let ids: string[] | undefined;
    for (const b of this.schedule.bubbles) {
      if (b.v0 > v) break;
      if (b.v0 >= bestV) {
        bestV = b.v0;
        ids = [b.deviceId];
      }
    }
    for (const f of this.schedule.flights) {
      if (f.v0 > v || f.v0 < bestV) continue;
      bestV = f.v0;
      ids = v < f.v1 ? [f.from, f.to] : [f.to];
    }
    if (!ids) return undefined;
    let r: ScreenRect | undefined;
    for (const id of ids) {
      const tr = this.towerRect(this.world.towers.get(id)!);
      r = r ? { x0: Math.min(r.x0, tr.x0), y0: Math.min(r.y0, tr.y0), x1: Math.max(r.x1, tr.x1), y1: Math.max(r.y1, tr.y1) } : tr;
    }
    return r;
  }

  // ───────────────────────────── operator interactions ─────────────────────────────

  private installOperator(): void {
    this.svg.addEventListener('pointerdown', (e) => {
      const g = this.blockedGate;
      if (!g || g.kind !== 'operator' || g.action === 'drag-cell') return;
      const f = this.factories.get(g.deviceId);
      const m = f?.stations.find((x) => x.kind === g.machine && (!g.iface || x.iface === g.iface));
      if (!m || !m.hit.contains(e.target as Node)) return;
      e.stopPropagation();
      this.handlers.onGateAction(g);
    });
    this.svg.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      const p = this.camera.toScene(e.clientX, e.clientY);
      const dsx = p.x - d.start.x;
      const dsy = p.y - d.start.y;
      // Screen delta → world delta in the floor plane.
      d.dx = (dsx / U + (2 * dsy) / U) / 2;
      d.dy = ((2 * dsy) / U - dsx / U) / 2;
      d.moved = Math.hypot(dsx, dsy);
    });
    const up = (): void => {
      const d = this.drag;
      if (!d) return;
      this.drag = undefined;
      // Any deliberate drag hands the data to the transport station.
      if (d.moved > 30) this.handlers.onGateAction(d.gate);
    };
    this.svg.addEventListener('pointerup', up);
    this.svg.addEventListener('pointercancel', up);
  }

  private gizmoPointerDown(e: PointerEvent, pduId: string): void {
    const g = this.blockedGate;
    const track = this.pickCtx.get(pduId)?.track;
    if (!g || g.action !== 'drag-cell' || !track || g.deviceId !== track.deviceId || !track.isStream) return;
    e.stopPropagation();
    this.svg.setPointerCapture(e.pointerId);
    this.drag = { gate: g, track, dx: 0, dy: 0, start: this.camera.toScene(e.clientX, e.clientY), moved: 0 };
  }
}

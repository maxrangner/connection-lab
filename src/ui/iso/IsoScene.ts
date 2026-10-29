import type { DeviceSpec, LayerNum } from '../../sim';
import { LAYER_COLOR, layerLabel, type LayerModel } from '../content/layers';
import { GizmoView, type GizmoPose } from '../gizmo/GizmoView';
import { el, show } from '../scene/svg';
import type { Bubble, Flight, Gate, Schedule, Track } from '../timeline/schedule';
import { Bubbles } from './Bubbles';
import { Camera, type CameraMode, type ScreenRect } from './Camera';
import { buildWorld, FD, floorOf, FLOOR_H, FW, MACHINE, PART_D, ROOF_T, SLAB_T, type FloorGeom, type TowerGeom, type WorldGeom } from './layout';
import { BUILDERS } from './machines/build';
import type { MachineView } from './machines/base';
import { MACHINE_NAME, machinesFor, type MachineKind } from './machines/Machine';
import { billboard, box, line, tile } from './prims';
import { clamp01, easeInOut, easeOut, iso, lerp, U, type Vec3 } from './project';
import { Train } from './Train';

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
  gGizmos: SVGGElement;
  floors: { geom: FloorGeom; slab: SVGGElement }[];
  machines: MachineView[];
}

/** Isometric scene: factories (towers of floors with machines), gizmos moving through them, trains on cables. */
export class IsoScene {
  readonly svg: SVGSVGElement;
  readonly camera: Camera;
  readonly gOverlay: SVGGElement;
  private gGround: SVGGElement;
  private gFactories: SVGGElement;
  private gWire: SVGGElement;
  private gLabels: SVGGElement;
  private bubbles: Bubbles;
  private hint: HTMLElement;
  private world!: WorldGeom;
  private factories = new Map<string, Factory>();
  private schedule!: Schedule;
  private gizmos = new Map<string, GizmoView>();
  private trains = new Map<string, Train>();
  private visibleGizmos = new Set<string>();
  private visibleTrains = new Set<string>();
  private drag: { gate: Gate; track: Track; dx: number; dy: number; start: { x: number; y: number }; active: boolean } | undefined;
  private leverStart: { x: number; y: number } | undefined;

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
    this.gWire = el('g', { class: 'wire' }, this.svg);
    this.gLabels = el('g', { class: 'labels' }, this.svg);
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
    this.gGround.replaceChildren();
    this.gFactories.replaceChildren();
    this.gWire.replaceChildren();
    this.gLabels.replaceChildren();
    this.factories.clear();
    this.gizmos.clear();
    this.trains.clear();
    this.visibleGizmos.clear();
    this.visibleTrains.clear();
    this.buildGround();
    const ordered = [...s.result.scenario.devices].sort((a, b) => this.world.towers.get(a.id)!.depth - this.world.towers.get(b.id)!.depth);
    for (const d of ordered) this.buildFactory(d, model);
    const B = this.world.bounds;
    const corners = [iso(B.x0, B.y0, B.zTop), iso(B.x1, B.y0, B.zTop), iso(B.x0, B.y1, 0), iso(B.x1, B.y1, 0), iso(B.x1, B.y0, 0), iso(B.x0, B.y1, B.zTop)];
    this.camera.setBounds({ x0: Math.min(...corners.map((c) => c.sx)) - 20, y0: Math.min(...corners.map((c) => c.sy)) - 60, x1: Math.max(...corners.map((c) => c.sx)) + 20, y1: Math.max(...corners.map((c) => c.sy)) + 30 });
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

  /** Screen point of the app floor slot of a device (drop target for the URL card). */
  deviceCenter(id: string): { x: number; y: number } {
    const t = this.world.towers.get(id)!;
    const f = t.floors[t.floors.length - 1]!;
    const p = iso(f.slot.x + 1.2, f.slot.y + 0.5, f.top + 0.6);
    return { x: p.sx, y: p.sy };
  }

  // ───────────────────────────── building ─────────────────────────────

  private buildGround(): void {
    for (const t of this.world.towers.values()) {
      tile(this.gGround, t.origin.x - 0.4, t.origin.y - 0.4, FW + 0.8, FD + 0.8, 0, { class: 'pad' });
    }
    for (const c of this.world.cables.values()) {
      const g = el('g', { class: 'cable', 'data-id': c.id }, this.gGround);
      for (let i = 0; i + 1 < c.points.length; i++) {
        line(g, c.points[i]!, c.points[i + 1]!, { class: 'cable-shadow' });
        line(g, c.points[i]!, c.points[i + 1]!, { class: 'cable-line' });
      }
      // Label on the longest segment.
      let best = 0;
      for (let i = 1; i < c.segLen.length; i++) if (c.segLen[i]! > c.segLen[best]!) best = i;
      const a = c.points[best]!;
      const b = c.points[best + 1]!;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: 0 };
      billboard(this.gGround, mid, c.spec.label, 'cable-label', { 'text-anchor': 'middle', dy: 16 });
    }
  }

  private buildFactory(spec: DeviceSpec, model: LayerModel): void {
    const tower = this.world.towers.get(spec.id)!;
    const g = el('g', { class: `factory dev-${spec.kind}`, 'data-id': spec.id }, this.gFactories);
    const o = tower.origin;
    const H = tower.floors.length * FLOOR_H;
    // Back columns.
    box(g, { x: o.x, y: o.y, z: 0, w: 0.3, d: 0.3, h: H, color: '#1e293b' });
    box(g, { x: o.x + FW - 0.3, y: o.y, z: 0, w: 0.3, d: 0.3, h: H, color: '#1e293b' });
    const floors: Factory['floors'] = [];
    const machines: MachineView[] = [];
    for (const f of tower.floors) {
      const slab = el('g', { class: 'floor', 'data-layer': f.layer }, g);
      box(slab, { x: o.x, y: o.y, z: f.z, w: FW, d: FD, h: SLAB_T, color: '#273449', cls: 'slab' });
      // Layer color strip along the front edge.
      box(slab, { x: o.x, y: o.y + FD - 0.12, z: f.z + SLAB_T - 0.02, w: FW, d: 0.12, h: 0.04, color: LAYER_COLOR[f.layer] });
      billboard(slab, { x: o.x + 2.2, y: o.y + FD, z: f.z + SLAB_T + 0.05 }, layerLabel(f.layer, model), 'floor-label', { dy: 14 });
      floors.push({ geom: f, slab });
      // Machines on this floor.
      for (const kind of machinesFor(spec.kind)) {
        if (floorFor(kind) !== f.layer) continue;
        if (kind === 'port') {
          for (const p of tower.ports) machines.push(BUILDERS.port(slab, { deviceId: spec.id, tower, floor: f, port: p }));
        } else machines.push(BUILDERS[kind](slab, { deviceId: spec.id, tower, floor: f }));
      }
    }
    // Nameplates: every machine says what it is.
    for (const m of machines) {
      if (m.kind === 'port') continue;
      // On the floor just in front of the machine (the back of a floor visually touches the slab above).
      const f = tower.floors.find((x) => x.layer === floorFor(m.kind))!;
      billboard(g, { x: m.anchor.x, y: MACHINE.y + 1.25 + o.y, z: f.top + 0.02 }, MACHINE_NAME[m.kind], 'nameplate', { 'text-anchor': 'middle', dy: 4 });
    }
    // Roof + sign.
    box(g, { x: o.x, y: o.y, z: H, w: FW, d: FD, h: ROOF_T, color: '#1f2b40' });
    const sign = { x: o.x + FW / 2, y: o.y + FD / 2, z: H + ROOF_T };
    box(g, { x: sign.x - 1.6, y: sign.y - 0.15, z: sign.z, w: 3.2, d: 0.3, h: 1.1, color: '#0f172a' });
    billboard(g, { x: sign.x, y: sign.y, z: sign.z + 0.75 }, spec.label, 'sign-title', { 'text-anchor': 'middle' });
    billboard(g, { x: sign.x, y: sign.y, z: sign.z + 0.3 }, spec.sublabel ?? '', 'sign-sub', { 'text-anchor': 'middle' });
    if (model === 'osi' && spec.kind !== 'router' && spec.kind !== 'home-router') {
      const top = tower.floors[tower.floors.length - 1]!;
      billboard(g, { x: o.x + FW - 0.2, y: o.y + FD, z: top.top + 0.05 }, 'L6 Presentation · L5 Session: inside the app', 'floor-label plaque', { 'text-anchor': 'end', dy: 14 });
    }
    const hit = el('g', { class: 'factory-hit' }, g);
    const hitTile = tile(hit, o.x, o.y, FW, FD, H + ROOF_T, { fill: 'transparent' });
    hitTile.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handlers.onPickDevice(spec.id);
    });
    const gGizmos = el('g', { class: 'gizmos' }, g);
    this.factories.set(spec.id, { spec, tower, g, gGizmos, floors, machines });
  }

  // ───────────────────────────── per frame ─────────────────────────────

  render(v: number, dt: number, ctx: RenderCtx): void {
    if (!this.schedule) return;
    const s = this.schedule;
    const speaking = this.activeBubbles(v, ctx.blocked);
    const speakingDev = new Set(speaking.map((b) => b.deviceId));
    for (const f of this.factories.values()) {
      const st = s.deviceStateAt(f.spec.id, v);
      const busy = (s.busySpans.get(f.spec.id) ?? []).some(([a, b]) => v >= a && v <= b);
      f.g.classList.toggle('busy', busy);
      f.g.classList.toggle('dim', speaking.length > 0 && !speakingDev.has(f.spec.id));
      for (const m of f.machines) {
        const act = this.actFor(f.spec.id, m, v);
        const u = act ? clamp01((v - act.v0) / Math.max(1e-6, act.v1 - act.v0)) : 0;
        const blocked = !!ctx.blocked && ctx.blocked.kind === 'operator' && ctx.blocked.deviceId === f.spec.id && ctx.blocked.machine === m.kind && (!ctx.blocked.iface || ctx.blocked.iface === m.iface);
        m.render(v, st, act, u, blocked);
      }
    }
    this.renderTracks(v, ctx);
    this.renderFlights(v, ctx);
    this.renderBubbles(v, speaking, ctx);
    this.renderHint(ctx.blocked);
    this.camera.update(this.focusFrame(v, speaking), (this.camera.sceneBounds.x1 - this.camera.sceneBounds.x0) / 2.6, dt);
  }

  private actFor(deviceId: string, m: MachineView, v: number) {
    let best: Schedule['acts'][number] | undefined;
    for (const a of this.schedule.acts) {
      if (a.deviceId !== deviceId || a.machine !== m.kind) continue;
      if (m.kind === 'port' && a.iface && a.iface !== m.iface) continue;
      if (a.v0 <= v && v < a.v1 + 0.25) best = a;
      if (a.v0 > v) break;
    }
    return best;
  }

  private gizmo(track: Track, pduId: string): GizmoView {
    const key = `${track.id}:${pduId}`;
    let g = this.gizmos.get(key);
    if (!g) {
      const pdu = this.schedule.result.pdus.get(pduId)!;
      g = new GizmoView(pdu, this.schedule.result.packets.get(track.packetId));
      g.g.addEventListener('click', (e) => {
        e.stopPropagation();
        this.handlers.onPickPdu(pduId, { track });
      });
      g.g.addEventListener('pointerdown', (e) => this.gizmoPointerDown(e, track));
      this.factories.get(track.deviceId)!.gGizmos.appendChild(g.g);
      this.gizmos.set(key, g);
    }
    return g;
  }

  private renderTracks(v: number, ctx: RenderCtx): void {
    const now = new Set<string>();
    for (const tr of this.schedule.tracks) {
      const first = tr.kfs[0];
      if (!first || v < first.v0 || v >= tr.end) continue;
      const f = this.factories.get(tr.deviceId);
      if (!f) continue;
      let kf = first;
      for (const k of tr.kfs) if (k.v0 <= v) kf = k;
      const u = clamp01((v - kf.v0) / Math.max(1e-6, kf.v1 - kf.v0));
      const e = easeInOut(u);
      const zFrom = floorOf(f.tower, kf.fromRow).top;
      const zTo = floorOf(f.tower, kf.row).top;
      let z = lerp(zFrom, zTo, e);
      let pduId = kf.pduId;
      const pose: GizmoPose = { origin: { x: 0, y: 0, z: 0 }, grow: 1, scatter: 0, scatterDir: 1, diff: 0, opacity: 1, consumed: 0 };
      switch (kf.mode) {
        case 'appear':
          pose.opacity = e;
          z += (1 - e) * 0.6;
          break;
        case 'encap':
          pose.grow = u;
          break;
        case 'decap':
          if (u < 1 && kf.fromPduId) {
            pduId = kf.fromPduId;
            pose.grow = 1 - u;
          }
          break;
        case 'change':
          pose.diff = u < 0.8 ? Math.sin(Math.PI * (u / 0.8)) : 0.35;
          pose.diffBytes = kf.diff;
          break;
        case 'rx':
          if (kf.fromPduId === undefined) {
            pose.scatter = 1 - easeOut(u);
            pose.scatterDir = this.portDir(f, kf.iface);
          }
          break;
        case 'tx':
          if (kf.fromPduId) pduId = kf.fromPduId;
          pose.scatter = easeInOut(u);
          pose.scatterDir = this.portDir(f, kf.iface);
          break;
      }
      const left = tr.end - v;
      if (left < 0.4) {
        const k = clamp01(left / 0.4);
        pose.opacity *= k;
        if (tr.endKind === 'absorb') z += (1 - k) * 0.5;
      }
      if (tr.isStream && tr.consumed?.length) {
        let bytes = 0;
        for (const c of tr.consumed) if (c.v <= v) bytes = c.bytes;
        const total = this.schedule.result.pdus.get(pduId)?.bytes.length ?? 1;
        pose.consumed = clamp01(bytes / total);
      }
      const gv = this.gizmo(tr, pduId);
      const key = `${tr.id}:${pduId}`;
      now.add(key);
      const slot = f.tower.floors[0]!.slot;
      pose.origin = { x: slot.x, y: slot.y, z };
      // Operator drag offset.
      if (this.drag && this.drag.track === tr && this.drag.active) {
        pose.origin = { x: slot.x + this.drag.dx, y: slot.y + this.drag.dy, z };
      }
      gv.pose(pose);
      gv.g.classList.toggle('selected', ctx.selectedPdu === pduId);
      gv.g.classList.toggle('dropped', tr.endKind === 'drop' && left < 1.0);
      gv.g.classList.toggle('draggable', !!ctx.blocked && ctx.blocked.action === 'drag-cell' && ctx.blocked.deviceId === tr.deviceId && tr.isStream === true);
      show(gv.g, true);
    }
    for (const key of this.visibleGizmos) if (!now.has(key)) show(this.gizmos.get(key)!.g, false);
    this.visibleGizmos = now;
  }

  private portDir(f: Factory, ifaceId: string | undefined): 1 | -1 {
    const p = f.tower.ports.find((x) => x.ifaceId === ifaceId);
    return p?.side === 'left' || p?.side === 'left2' ? -1 : 1;
  }

  private renderFlights(v: number, ctx: RenderCtx): void {
    const now = new Set<string>();
    const busyCables = new Set<string>();
    for (const fl of this.schedule.flights) {
      if (v < fl.v0 || v >= fl.v1) continue;
      let tr = this.trains.get(fl.id);
      const cable = this.world.cables.get(fl.linkId)!;
      if (!tr) {
        const pdu = this.schedule.result.pdus.get(fl.frameId)!;
        tr = new Train(pdu, this.schedule.result.packets.get(fl.packetId), cable, fl.wireBytes);
        tr.g.addEventListener('click', (e) => {
          e.stopPropagation();
          this.handlers.onPickPdu(fl.frameId, { flight: fl });
        });
        this.gWire.appendChild(tr.g);
        this.trains.set(fl.id, tr);
      }
      const forward = cable.a === fl.from;
      const lost = fl.lostAt !== undefined && v >= fl.lostAt;
      const travelEnd = fl.lostAt ?? fl.v1;
      const total = fl.lostAt !== undefined ? (fl.lostAt - fl.v0) * 2 : fl.v1 - fl.v0;
      const u = clamp01((Math.min(v, travelEnd) - fl.v0) / Math.max(1e-6, total));
      // The head travels the cable plus the train's own length, so the tail arrives too.
      const dist = cable.length + tr.length;
      const sRaw = lerp(0, dist, u);
      const sHead = forward ? sRaw : cable.length - sRaw;
      tr.pose(sHead, forward ? 1 : -1, v, lost ? v - fl.lostAt! : 0, 1);
      tr.g.classList.toggle('selected', ctx.selectedPdu === fl.frameId);
      show(tr.g, true);
      now.add(fl.id);
      busyCables.add(fl.linkId);
    }
    for (const id of this.visibleTrains) if (!now.has(id)) show(this.trains.get(id)!.g, false);
    this.visibleTrains = now;
    for (const c of Array.from(this.gGround.querySelectorAll('.cable'))) c.classList.toggle('busy', busyCables.has(c.getAttribute('data-id') ?? ''));
  }

  // ───────────────────────────── bubbles, hints, camera ─────────────────────────────

  private activeBubbles(v: number, blocked: Gate | undefined): Bubble[] {
    const out: Bubble[] = [];
    for (const b of this.schedule.bubbles) {
      if (b.v0 > v) break;
      if (v < b.v1 || (blocked?.kind === 'bubble' && blocked.seq === b.seq)) out.push(b);
    }
    // Keep at most one bubble per device (the latest).
    const byDev = new Map<string, Bubble>();
    for (const b of out) byDev.set(b.deviceId, b);
    return [...byDev.values()].slice(-2);
  }

  private anchorFor(deviceId: string, machine: MachineKind, iface?: string): Vec3 {
    const f = this.factories.get(deviceId);
    const m = f?.machines.find((x) => x.kind === machine && (machine !== 'port' || !iface || x.iface === iface));
    if (m) return m.anchor;
    const t = this.world.towers.get(deviceId)!;
    return { x: t.origin.x + FW / 2, y: t.origin.y + FD / 2, z: t.roofZ + 1.5 };
  }

  private renderBubbles(v: number, speaking: Bubble[], ctx: RenderCtx): void {
    this.bubbles.render(
      speaking.map((b) => ({
        b,
        anchor: { ...this.anchorFor(b.deviceId, b.machine, b.iface), z: this.anchorFor(b.deviceId, b.machine, b.iface).z + 0.55 },
        gate: !!ctx.blocked && ctx.blocked.kind === 'bubble' && ctx.blocked.seq === b.seq,
        age: v - b.v0,
        left: b.v1 - v,
      })),
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
    // Beside the machine (to its right), not on top of it.
    const a = this.anchorFor(blocked.deviceId, blocked.machine, blocked.iface);
    const s = iso(a.x + 1.6, a.y, a.z - 0.6);
    const m = this.svg.getScreenCTM();
    const r = this.container.getBoundingClientRect();
    if (m) {
      const p = new DOMPoint(s.sx, s.sy).matrixTransform(m);
      this.hint.style.transform = `translate(${(p.x - r.left).toFixed(1)}px, ${(p.y - r.top).toFixed(1)}px) translate(0, -50%)`;
    }
    this.hint.style.display = '';
  }

  private towerRect(t: TowerGeom, extraTop = 0): ScreenRect {
    const o = t.origin;
    const pts = [iso(o.x, o.y, t.roofZ + 2.2 + extraTop), iso(o.x + FW, o.y, t.roofZ + 2.2 + extraTop), iso(o.x, o.y + FD + 1.5, 0), iso(o.x + FW, o.y + FD + 1.5, 0), iso(o.x + FW, o.y, 0), iso(o.x, o.y + FD, 0)];
    return { x0: Math.min(...pts.map((p) => p.sx)) - 40, y0: Math.min(...pts.map((p) => p.sy)) - 90, x1: Math.max(...pts.map((p) => p.sx)) + 40, y1: Math.max(...pts.map((p) => p.sy)) + 20 };
  }

  private focusFrame(v: number, speaking: Bubble[]): ScreenRect | undefined {
    if (v >= this.schedule.duration - 1.6) return undefined;
    let bestV = -Infinity;
    let ids: string[] | undefined;
    const last = speaking[speaking.length - 1];
    if (last) {
      bestV = last.v0;
      ids = [last.deviceId];
    }
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
      const t = this.world.towers.get(id)!;
      const tr = this.towerRect(t);
      r = r ? { x0: Math.min(r.x0, tr.x0), y0: Math.min(r.y0, tr.y0), x1: Math.max(r.x1, tr.x1), y1: Math.max(r.y1, tr.y1) } : tr;
    }
    return r;
  }

  // ───────────────────────────── operator interactions ─────────────────────────────

  private blockedGate: Gate | undefined;

  setBlocked(g: Gate | undefined): void {
    this.blockedGate = g;
  }

  private installOperator(): void {
    // Megaphone press and lever pull are wired per machine via their `hit` elements.
    this.svg.addEventListener('pointerdown', (e) => {
      const g = this.blockedGate;
      if (!g || g.kind !== 'operator') return;
      const target = e.target as Element;
      const f = this.factories.get(g.deviceId);
      const m = f?.machines.find((x) => x.kind === g.machine && (!g.iface || x.iface === g.iface));
      if (!m?.hit || !m.hit.contains(target)) return;
      e.stopPropagation();
      if (g.action === 'press-arp') {
        this.handlers.onGateAction(g);
      } else if (g.action === 'pull-lever') {
        this.leverStart = { x: e.clientX, y: e.clientY };
        this.svg.setPointerCapture(e.pointerId);
      }
    });
    this.svg.addEventListener('pointermove', (e) => {
      if (this.leverStart && this.blockedGate?.action === 'pull-lever') {
        if (Math.hypot(e.clientX - this.leverStart.x, e.clientY - this.leverStart.y) > 40) {
          this.leverStart = undefined;
          this.handlers.onGateAction(this.blockedGate);
        }
      }
      if (this.drag?.active) {
        const p = this.camera.toScene(e.clientX, e.clientY);
        const d = this.drag;
        // Move in the floor plane: screen delta → world delta at the floor's height.
        const dsx = p.x - d.start.x;
        const dsy = p.y - d.start.y;
        d.dx = (dsx / U + (2 * dsy) / U) / 2;
        d.dy = ((2 * dsy) / U - dsx / U) / 2;
      }
    });
    const up = (e: PointerEvent): void => {
      this.leverStart = undefined;
      if (this.drag?.active) {
        const d = this.drag;
        d.active = false;
        // Dropped near the transport floor slot (one floor down)?
        const f = this.factories.get(d.track.deviceId)!;
        const from = floorOf(f.tower, 5);
        const to = floorOf(f.tower, 4);
        const dz = from.top - to.top;
        // The user drags down on screen; a drop within ~1.5 tiles of the chassis counts.
        const dropped = { x: d.dx, y: d.dy };
        const target = { x: 0, y: dz * 2 }; // moving "down" on screen in the floor plane ≈ +x+y
        const dist = Math.hypot(dropped.x - target.x / 2, dropped.y - target.y / 2);
        if (dist < 1.6 || Math.hypot(d.dx, d.dy) > 1.2) this.handlers.onGateAction(d.gate);
        this.drag = undefined;
        void e;
      }
    };
    this.svg.addEventListener('pointerup', up);
    this.svg.addEventListener('pointercancel', up);
  }

  private gizmoPointerDown(e: PointerEvent, track: Track): void {
    const g = this.blockedGate;
    if (!g || g.action !== 'drag-cell' || g.deviceId !== track.deviceId || !track.isStream) return;
    e.stopPropagation();
    this.svg.setPointerCapture(e.pointerId);
    this.drag = { gate: g, track, dx: 0, dy: 0, start: this.camera.toScene(e.clientX, e.clientY), active: true };
  }
}

function floorFor(kind: MachineKind): LayerNum {
  return kind === 'browser' || kind === 'dnsDesk' || kind === 'httpShelf' ? 5 : kind === 'tcpClerk' ? 4 : kind === 'netStation' || kind === 'natDesk' ? 3 : kind === 'linkStation' ? 2 : 1;
}

export { PART_D };

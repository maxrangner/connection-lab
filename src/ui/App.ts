import { CAPTURED_AT, fetchWebPage, runScenario, type ManualFault, type SimResult } from '../sim';
import { ARP_COLOR, LAYER_COLOR, layerLabel } from './content/layers';
import { fmtTime } from './content/format';
import { IsoScene } from './iso/IsoScene';
import { Controls } from './panels/Controls';
import { button, h } from './panels/dom';
import { Inspector, type Detail } from './panels/Inspector';
import { Receipt } from './panels/Receipt';
import { loadSettings, saveSettings, SettingsPanel, type Settings } from './panels/SettingsPanel';
import { UrlCard } from './scene/UrlCard';
import { Player } from './timeline/Player';
import { buildSchedule, type Flight, type Gate, type Schedule } from './timeline/schedule';

export class App {
  private settings: Settings = loadSettings();
  private faults: ManualFault[] = [];
  private result!: SimResult;
  private schedule!: Schedule;
  private readonly scene: IsoScene;
  private readonly player: Player;
  private readonly controls: Controls;
  private readonly inspector: Inspector;
  private readonly receipt: Receipt;
  private readonly settingsPanel: SettingsPanel;
  private card: UrlCard | undefined;
  private started = false;
  private readonly skipEl: HTMLElement;
  private readonly legendEl: HTMLElement;
  private readonly doneEl: HTMLElement;
  private readonly stage: HTMLElement;

  constructor(root: HTMLElement) {
    this.stage = h('div', { class: 'stage' });
    this.player = new Player((v, dt) => this.frame(v, dt));
    this.scene = new IsoScene(this.stage, {
      onPickPdu: (pduId, ctx) => {
        this.player.setPlaying(false);
        this.inspector.showPdu(this.schedule, pduId, ctx, this.player.v);
      },
      onPickDevice: (id) => {
        this.player.setPlaying(false);
        this.inspector.showDevice(this.schedule, id, this.player.v);
      },
      onGateAction: (gate) => this.releaseGate(gate),
      onDismissBubble: () => this.player.release(true),
    });
    this.inspector = new Inspector({
      model: () => this.settings.model,
      detail: () => this.settings.detail,
      setDetail: (d: Detail) => this.change({ detail: d }),
      loseFrame: (f) => this.loseFrame(f),
      close: () => this.inspector.hide(),
    });
    this.receipt = new Receipt((b) => {
      this.player.setPlaying(false);
      this.player.seek(b.v0 + 0.05);
    });
    this.controls = new Controls(this.player, {
      stepNext: () => this.stepNext(),
      stepPrev: () => this.stepPrev(),
      restart: () => this.restart(),
      toggleReceipt: () => this.receipt.toggle(),
    });
    this.settingsPanel = new SettingsPanel(
      {
        change: (p) => this.change(p),
        clearFaults: () => {
          this.faults = [];
          this.resimulate(0);
          this.settingsPanel.render();
        },
        faultCount: () => this.faults.length,
      },
      () => this.settings,
    );
    this.skipEl = h('div', { class: 'skip' });
    this.legendEl = h('div', { class: 'legend' });
    this.doneEl = h('div', { class: 'done' });
    const header = h(
      'header',
      { class: 'top' },
      h('div', { class: 'brand' }, h('span', { class: 'logo', text: '◆' }), h('h1', { text: 'How the Internet Works' }), h('span', { class: 'scenario', text: 'Fetch http://example.com/' })),
      h('div', { class: 'top-actions' }, button('Settings', () => this.settingsPanel.toggle(), '', 'Settings')),
    );
    this.stage.append(this.skipEl, this.legendEl, this.doneEl, this.receipt.el, this.inspector.el, this.settingsPanel.el);
    root.append(header, this.stage, this.controls.el);
    this.simulate();
    this.scene.setCameraMode('overview');
    this.renderLegend();
    const laptop = this.scene.deviceCenter('laptop');
    this.card = new UrlCard(this.scene, 'http://example.com/', 'laptop', { x: laptop.x + 560, y: laptop.y + 40 }, () => this.start());
    this.player.onState(() => {
      if (this.player.playing && !this.started) {
        this.player.setPlaying(false);
        this.card?.autoDrop();
      }
    });
    this.player.onGate(() => this.scene.setBlocked(this.blockedGate()));
    this.installKeys();
    if (import.meta.env.DEV) this.exposeDebugHandle();
  }

  private simulate(): void {
    this.result = runScenario(fetchWebPage({ mss: this.settings.mss }), {
      seed: this.settings.seed,
      faults: { randomLoss: this.settings.loss, manual: this.faults },
    });
    this.schedule = buildSchedule(this.result);
    this.player.duration = this.schedule.duration;
    this.applyGates();
    this.scene.setSchedule(this.schedule, this.settings.model);
    this.controls.setSchedule(this.schedule);
    this.receipt.setSchedule(this.schedule);
    this.inspector.refresh(this.schedule, this.player.v);
  }

  private applyGates(): void {
    const s = this.settings;
    this.player.gates = this.schedule.gates.filter((g) => (g.kind === 'operator' ? s.operator : s.stepBubbles)).map((g) => g.v);
    this.player.blockedAt = undefined;
    this.scene.setBlocked(undefined);
  }

  private blockedGate(): Gate | undefined {
    const at = this.player.blockedAt;
    if (at === undefined) return undefined;
    return this.schedule.gates.find((g) => Math.abs(g.v - at) < 1e-9 && (g.kind === 'operator' ? this.settings.operator : this.settings.stepBubbles));
  }

  private releaseGate(gate: Gate): void {
    if (this.player.blockedAt === undefined || Math.abs(this.player.blockedAt - gate.v) > 1e-6) return;
    this.scene.setBlocked(undefined);
    this.player.release(true);
  }

  private resimulate(seekTo: number): void {
    this.simulate();
    this.player.seek(seekTo);
    if (this.started) this.player.setPlaying(true);
  }

  private start(): void {
    this.started = true;
    this.card?.destroy();
    this.card = undefined;
    this.scene.setCameraMode(this.settings.camera);
    this.player.seek(0);
    this.player.setPlaying(true);
  }

  private restart(): void {
    if (!this.started) {
      this.card?.autoDrop();
      return;
    }
    this.inspector.hide();
    this.player.seek(0);
    this.player.setPlaying(true);
  }

  private stepNext(): void {
    if (!this.started) {
      this.card?.autoDrop();
      return;
    }
    if (this.player.blockedAt !== undefined) {
      this.scene.setBlocked(undefined);
      this.player.release(false);
    }
    const v = this.player.v;
    const b = this.schedule.bubbles.find((x) => x.v0 + 0.35 > v + 0.02);
    this.player.playTo(b ? b.v0 + 0.35 : this.schedule.duration);
  }

  private stepPrev(): void {
    const v = this.player.v;
    const done = this.schedule.bubbles.filter((x) => x.v0 + 0.35 < v - 0.02);
    this.player.setPlaying(false);
    this.player.seek(done.length ? done[done.length - 1]!.v0 + 0.35 : 0);
  }

  private loseFrame(f: Flight): void {
    this.faults.push({ packetId: f.packetId, linkId: f.linkId });
    this.inspector.hide();
    this.simulate();
    const nf = this.schedule.flights.find((x) => x.packetId === f.packetId && x.linkId === f.linkId);
    this.player.seek(nf ? nf.v0 + 0.05 : f.v0);
    this.player.setPlaying(true);
  }

  private change(p: Partial<Settings>): void {
    const prev = this.settings;
    this.settings = { ...prev, ...p };
    saveSettings(this.settings);
    if ((p.mss !== undefined && p.mss !== prev.mss) || (p.loss !== undefined && p.loss !== prev.loss) || (p.seed !== undefined && p.seed !== prev.seed)) this.resetSim();
    if (p.model && p.model !== prev.model) {
      this.scene.setSchedule(this.schedule, this.settings.model);
      this.renderLegend();
    }
    if (p.operator !== undefined || p.stepBubbles !== undefined) this.applyGates();
    if (p.camera && this.started) this.scene.setCameraMode(p.camera);
    this.inspector.refresh(this.schedule, this.player.v);
    this.settingsPanel.render();
  }

  private resetSim(): void {
    this.faults = [];
    this.inspector.hide();
    this.resimulate(0);
  }

  private renderLegend(): void {
    const m = this.settings.model;
    const chips = ([5, 4, 3, 2, 1] as const).map((l) => h('span', { class: 'chip', text: layerLabel(l, m), attrs: { style: `--lc:${LAYER_COLOR[l]}` } }));
    chips.splice(4, 0, h('span', { class: 'chip', text: 'ARP', attrs: { style: `--lc:${ARP_COLOR}` } }));
    this.legendEl.replaceChildren(h('span', { class: 'legend-title', text: 'part length = bytes' }), ...chips);
  }

  private frame(v: number, dt: number): void {
    const wide = window.innerWidth > 900;
    this.scene.insets = this.inspector.open ? { right: wide ? this.inspector.el.offsetWidth : 0, bottom: wide ? 0 : this.inspector.el.offsetHeight } : { right: 0, bottom: 0 };
    const blocked = this.blockedGate();
    this.scene.render(v, dt, { selectedPdu: this.inspector.selectedPdu, blocked, model: this.settings.model });
    this.card?.update(dt);
    this.controls.update(v, this.started, blocked?.kind === 'operator' ? blocked.hint : blocked ? 'Click the bubble to continue' : undefined);
    this.receipt.update(v);
    const skip = this.schedule.skips.find((s) => v >= s.v0 && v < s.v1);
    if (skip) {
      const k = (v - skip.v0) / (skip.v1 - skip.v0);
      this.skipEl.textContent = `⏩ ${fmtTime(skip.dt * k)} / ${fmtTime(skip.dt)}: waiting, nothing on the wire`;
      this.skipEl.classList.add('on');
    } else this.skipEl.classList.remove('on');
    this.renderDone(v);
  }

  private renderDone(v: number): void {
    const doneEv = this.result.events.find((e) => e.type === 'app' && e.deviceId === 'laptop' && (e.action === 'done' || e.action === 'error'));
    const at = doneEv ? this.schedule.eventV[doneEv.seq]! + 1 : Infinity;
    const show = v >= at && this.started;
    if (show && !this.doneEl.classList.contains('on')) {
      const ok = doneEv?.type === 'app' && doneEv.action === 'done';
      const frames = this.schedule.flights.length;
      const lost = this.schedule.flights.filter((f) => f.lostAt !== undefined).length;
      const loadT = this.result.events.find((e) => e.type === 'app' && e.action === 'http-response-received');
      this.doneEl.replaceChildren(
        h('b', { text: ok ? 'Page loaded' : 'Load failed' }),
        h('span', { text: `${loadT ? fmtTime(loadT.t) : '—'} simulated · ${frames} frames on the wire${lost ? ` · ${lost} lost` : ''}` }),
        h('span', { class: 'done-note', text: `Response bytes captured from example.com on ${CAPTURED_AT.slice(0, 10)}.` }),
        button('Replay', () => this.restart()),
        button('Lose a packet', () => {
          this.settingsPanel.close();
          this.player.setPlaying(false);
          const f = this.schedule.flights.find((x) => this.result.packets.get(x.packetId)?.label.startsWith('HTTP 200'));
          if (f) {
            this.player.seek(f.v0 + 0.4);
            this.inspector.showPdu(this.schedule, f.frameId, { flight: f }, this.player.v);
          }
        }),
      );
    }
    this.doneEl.classList.toggle('on', show);
  }

  private installKeys(): void {
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === ' ') {
        e.preventDefault();
        if (!this.started) this.card?.autoDrop();
        else if (this.player.blockedAt !== undefined) {
          this.scene.setBlocked(undefined);
          this.player.release(true);
        } else this.player.toggle();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.stepNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.stepPrev();
      } else if (e.key === 'Escape') {
        this.inspector.hide();
        this.settingsPanel.close();
        this.receipt.close();
      } else if (e.key === 'f' || e.key === 'F') {
        this.change({ camera: this.settings.camera === 'follow' ? 'overview' : 'follow' });
      } else if (e.key === 'r' || e.key === 'R') {
        this.receipt.toggle();
      }
    });
  }

  /** Dev-only hook for scripts/screenshot*.mjs and manual poking in the console. */
  private exposeDebugHandle(): void {
    (window as unknown as Record<string, unknown>).__ie = {
      seek: (v: number) => {
        this.player.setPlaying(false);
        this.player.seek(v);
      },
      play: () => this.player.setPlaying(true),
      start: () => this.card?.autoDrop(),
      release: () => {
        this.scene.setBlocked(undefined);
        this.player.release(true);
      },
      info: () => ({
        duration: this.schedule.duration,
        bubbles: this.schedule.bubbles.map((b) => ({ v: b.v0, v1: b.v1, device: b.deviceId, machine: b.machine, shown: b.shown, text: b.text.slice(0, 80) })),
        gates: this.schedule.gates.filter((g) => g.kind === 'operator').map((g) => ({ id: g.id, v: g.v, action: g.action, device: g.deviceId })),
        flights: this.schedule.flights.map((f) => ({ id: f.id, v0: f.v0, v1: f.v1, lostAt: f.lostAt, link: f.linkId, label: this.result.packets.get(f.packetId)?.label })),
        blockedAt: this.player.blockedAt,
        started: this.started,
        playerGates: this.player.gates,
      }),
      pickFlight: (id: string, v: number) => {
        const f = this.schedule.flights.find((x) => x.id === id);
        if (!f) return;
        this.player.setPlaying(false);
        this.player.seek(v);
        this.inspector.showPdu(this.schedule, f.frameId, { flight: f }, v);
      },
      pickDevice: (id: string) => this.inspector.showDevice(this.schedule, id, this.player.v),
      settings: (p: Partial<Settings>) => this.change(p),
      lose: (id: string) => {
        const f = this.schedule.flights.find((x) => x.id === id);
        if (f) this.loseFrame(f);
      },
      receipt: () => this.receipt.toggle(),
      v: () => this.player.v,
      player: this.player,
    };
  }
}

import type { LayerModel } from '../content/layers';
import type { CameraMode } from '../iso/Camera';
import { button, h, segmented } from './dom';
import type { Detail } from './Inspector';

export interface Settings {
  model: LayerModel;
  detail: Detail;
  mss: number;
  loss: number;
  seed: number;
  camera: Exclude<CameraMode, 'free'>;
  /** The factory waits for you at key moments. */
  operator: boolean;
  /** Playback pauses at every speech bubble until you click it away. */
  stepBubbles: boolean;
}

export const DEFAULT_SETTINGS: Settings = { model: 'tcpip', detail: 'clean', mss: 1460, loss: 0, seed: 1, camera: 'follow', operator: false, stepBubbles: false };

const KEY = 'ie.settings.v2';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

export interface SettingsHost {
  change(patch: Partial<Settings>): void;
  clearFaults(): void;
  faultCount(): number;
}

export class SettingsPanel {
  readonly el: HTMLElement;

  constructor(
    private readonly host: SettingsHost,
    private settings: () => Settings,
  ) {
    this.el = h('div', { class: 'settings', attrs: { role: 'dialog', 'aria-label': 'Settings' } });
  }

  toggle(): void {
    if (this.el.classList.contains('open')) this.el.classList.remove('open');
    else {
      this.render();
      this.el.classList.add('open');
    }
  }

  close(): void {
    this.el.classList.remove('open');
  }

  render(): void {
    const s = this.settings();
    const row = (label: string, hint: string, control: HTMLElement): HTMLElement =>
      h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, h('b', { text: label }), h('span', { text: hint })), control);
    const onOff = (name: string, value: boolean, set: (v: boolean) => void): HTMLElement =>
      segmented<'on' | 'off'>(name, [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }], value ? 'on' : 'off', (v) => set(v === 'on'));
    this.el.replaceChildren(
      h('div', { class: 'set-head' }, h('b', { text: 'Settings' }), button('✕', () => this.close(), 'icon-btn')),
      row('You operate', 'The factory waits for you: press the megaphone, drag the data into the TCP chassis, pull the lever.', onOff('Operator', s.operator, (operator) => this.host.change({ operator }))),
      row('Step through bubbles', 'Every speech bubble pauses playback until you click it away.', onOff('Step', s.stepBubbles, (stepBubbles) => this.host.change({ stepBubbles }))),
      row('Layer model', 'Same packets, different textbook names.', segmented<LayerModel>('Layer model', [
        { value: 'tcpip', label: 'TCP/IP (5)' },
        { value: 'osi', label: 'OSI (7)' },
      ], s.model, (model) => this.host.change({ model }))),
      row('Inspector detail', 'How much a clicked part or frame shows.', segmented<Detail>('Detail', [
        { value: 'clean', label: 'Clean' },
        { value: 'full', label: 'Full' },
        { value: 'hex', label: 'Hex' },
      ], s.detail, (detail) => this.host.change({ detail }))),
      row('Laptop MSS', '536 forces the 932-byte response into two segments.', segmented<number>('MSS', [
        { value: 1460, label: '1460', title: 'Ethernet: 1500 MTU − 40' },
        { value: 536, label: '536', title: 'IPv4 default when nothing better is known' },
      ], s.mss, (mss) => this.host.change({ mss }))),
      row('Random packet loss', 'Every frame on every cable has this chance to be lost. Under heavy loss DNS often gives up: the resolver library only asks twice.', segmented<number>('Loss', [
        { value: 0, label: '0%' },
        { value: 0.05, label: '5%' },
        { value: 0.15, label: '15%' },
        { value: 0.3, label: '30%' },
      ], s.loss, (loss) => this.host.change({ loss }))),
      row('Randomness', `Seed ${s.seed}: picks ports, sequence numbers, IDs and which frames get lost.`, button('New seed', () => this.host.change({ seed: 1 + Math.floor(Math.random() * 99999) }))),
      row('Camera', 'Follow the action, or keep the whole map in view. Scroll or pinch to zoom, drag to pan, F to toggle.', segmented<Settings['camera']>('Camera', [
        { value: 'follow', label: 'Follow' },
        { value: 'overview', label: 'Overview' },
      ], s.camera, (camera) => this.host.change({ camera }))),
      this.host.faultCount()
        ? row('Lost on purpose', `${this.host.faultCount()} frame(s) you chose to lose.`, button('Clear', () => this.host.clearFaults()))
        : h('p', { class: 'set-tip', text: 'Tip: pause, click a train on a cable, and press "Lose this frame" to see how the protocols recover.' }),
    );
  }
}

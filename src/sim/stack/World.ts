import { rngFor, type Rng } from '../core/Rng';
import { Simulator } from '../core/Simulator';
import { isCut, lostToNoise, shouldDrop, type FaultPlan } from '../faults';
import type { LinkSpec, Scenario } from '../model';
import { WIFI_DIFS } from '../proto/wifi';
import type { Device } from './Device';

/** Bytes of preamble + start-of-frame delimiter that precede every Ethernet frame on the wire. */
export const PREAMBLE_BYTES = 8;
/** Minimum idle gap between frames: 12 byte times. */
export const INTERFRAME_GAP_BYTES = 12;

export class World {
  readonly sim = new Simulator();
  readonly devices = new Map<string, Device>();
  readonly links = new Map<string, Link>();
  readonly ifaceOwner = new Map<string, Device>();
  readonly ifaceLink = new Map<string, Link>();

  constructor(
    readonly scenario: Scenario,
    readonly seed: number,
    readonly faults: FaultPlan,
  ) {}

  rng(label: string): Rng {
    return rngFor(this.seed, label);
  }
}

/** How a frame goes on a Wi-Fi link with noise: which try of its packet this is, or that it is an Ack (never retried). */
export interface WifiSend {
  attempt?: number;
  ack?: boolean;
}

export class Link {
  private busyUntil = new Map<string, number>();
  /** Per port, when each frame waiting in its transmit buffer starts on the wire. Only kept for a link with a finite `queue`. */
  private waiting = new Map<string, number[]>();

  constructor(
    readonly world: World,
    readonly spec: LinkSpec,
  ) {}

  peerOf(ifaceId: string): string {
    return ifaceId === this.spec.a ? this.spec.b : this.spec.a;
  }

  /** Both ends are Wi-Fi radios. */
  get wifi(): boolean {
    return [this.spec.a, this.spec.b].every((id) => this.world.ifaceOwner.get(id)?.iface(id).wifi);
  }

  /**
   * A noisy radio, so the real 802.11 link layer is on: both directions share the air, every unicast data frame is
   * acknowledged, and one with no Ack is sent again. Off (noise 0, the default) the link is a perfect cable through the air.
   */
  get arq(): boolean {
    return (this.spec.noise ?? 0) > 0 && this.wifi;
  }

  /**
   * Puts a frame on the wire. Each direction serializes one frame at a time (full duplex). The last bit arrives
   * after serialization time plus propagation delay. A frame that finds the port busy waits its turn; with a finite
   * `queue` the wait is an event, and a frame that finds the buffer full is dropped at once (tail drop), silently.
   *
   * On a noisy Wi-Fi link (`arq`) the two radios share one air (half duplex): a data frame waits DIFS after the air falls
   * silent, an Ack only SIFS (its sender waits that long before calling), which is why the Ack always gets in first. Frames
   * take their turn in the order they are handed in; nobody collides (no carrier sense is modelled beyond that).
   * After the propagation delay the frame is lost to interference with the link's `noise` chance, decided by hash per
   * packet and attempt; else the far radio receives it. Returns when the last bit leaves, or nothing if the port dropped it.
   */
  transmit(fromIface: string, frame: Uint8Array, packetId: string, frameId: string, wifi: WifiSend = {}): number | undefined {
    const sim = this.world.sim;
    const toIface = this.peerOf(fromIface);
    const from = this.world.ifaceOwner.get(fromIface);
    const to = this.world.ifaceOwner.get(toIface);
    if (!from || !to) throw new Error(`link ${this.spec.id} not wired`);
    const bps = this.spec.bitsPerSecond;
    const wireBytes = frame.length + PREAMBLE_BYTES;
    const arq = this.arq;
    const port = arq ? 'air' : fromIface;
    const idle = this.busyUntil.get(port) ?? 0;
    // An Ack goes at once: it is called SIFS after the frame it answers, inside the DIFS every data frame must leave after
    // the air falls silent, so the air is free for it even when a data frame has already reserved its turn after that.
    const start = wifi.ack ? sim.now : Math.max(sim.now, arq ? idle + WIFI_DIFS : idle);
    if (this.spec.queue !== undefined && start > sim.now) {
      // The frames still waiting ahead of it: the one being clocked out right now has left the buffer.
      const ahead = (this.waiting.get(fromIface) ?? []).filter((s) => s > sim.now);
      if (ahead.length >= this.spec.queue) {
        sim.emit({ type: 'drop', packetId, reason: 'queue-full', deviceId: from.id, linkId: this.spec.id, frameId });
        return undefined;
      }
      this.waiting.set(fromIface, [...ahead, start]);
      sim.emit({ type: 'queue', deviceId: from.id, iface: fromIface, linkId: this.spec.id, packetId, frameId, depth: ahead.length, wait: start - sim.now });
    }
    const txEnd = start + (wireBytes * 8) / bps;
    this.busyUntil.set(port, Math.max(idle, txEnd + (arq ? 0 : (INTERFRAME_GAP_BYTES * 8) / bps)));
    const arrive = txEnd + this.spec.delay;
    sim.at(start, () => {
      sim.emit({
        type: 'tx',
        linkId: this.spec.id,
        fromDevice: from.id,
        fromIface,
        toDevice: to.id,
        toIface,
        packetId,
        frameId,
        start,
        txEnd,
        arrive,
        wireBytes,
      });
      if (shouldDrop(this.world.faults, this.world.seed, this.spec.id, packetId, start)) {
        sim.at(start + (arrive - start) / 2, () =>
          sim.emit({ type: 'drop', packetId, reason: isCut(this.world.faults, this.spec.id, start) ? 'cut' : 'fault', linkId: this.spec.id, frameId }),
        );
      } else if (arq && lostToNoise(this.world.seed, this.spec.id, packetId, wifi.attempt ?? 0, this.spec.noise!)) {
        // Damaged on the air: the receiver's FCS check fails and it says nothing.
        sim.at(arrive, () => sim.emit({ type: 'drop', packetId, reason: 'interference', deviceId: to.id, linkId: this.spec.id, frameId }));
      } else {
        sim.at(arrive, () => to.receiveFrame(toIface, frame, packetId, frameId));
      }
    });
    return txEnd;
  }
}

import { rngFor, type Rng } from '../core/Rng';
import { Simulator } from '../core/Simulator';
import { isCut, shouldDrop, type FaultPlan } from '../faults';
import type { LinkSpec, Scenario } from '../model';
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

export class Link {
  private busyUntil = new Map<string, number>();

  constructor(
    readonly world: World,
    readonly spec: LinkSpec,
  ) {}

  peerOf(ifaceId: string): string {
    return ifaceId === this.spec.a ? this.spec.b : this.spec.a;
  }

  /**
   * Puts a frame on the wire. Each direction serializes one frame at a time (full duplex). The last bit arrives
   * after serialization time plus propagation delay.
   */
  transmit(fromIface: string, frame: Uint8Array, packetId: string, frameId: string): void {
    const sim = this.world.sim;
    const toIface = this.peerOf(fromIface);
    const from = this.world.ifaceOwner.get(fromIface);
    const to = this.world.ifaceOwner.get(toIface);
    if (!from || !to) throw new Error(`link ${this.spec.id} not wired`);
    const bps = this.spec.bitsPerSecond;
    const wireBytes = frame.length + PREAMBLE_BYTES;
    const start = Math.max(sim.now, this.busyUntil.get(fromIface) ?? 0);
    const txEnd = start + (wireBytes * 8) / bps;
    this.busyUntil.set(fromIface, txEnd + (INTERFRAME_GAP_BYTES * 8) / bps);
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
      } else {
        sim.at(arrive, () => to.receiveFrame(toIface, frame, packetId, frameId));
      }
    });
  }
}

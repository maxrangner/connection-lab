import { hash32 } from './core/Rng';

export interface ManualFault {
  packetId: string;
  linkId: string;
}

/**
 * Which frames get lost. Random decisions are keyed by (seed, link, packet), not by RNG draw order, so adding a
 * manual fault never changes what happened before it.
 */
export interface FaultPlan {
  /** Probability in [0, 1) that any single frame is lost on any link. */
  randomLoss: number;
  manual: ManualFault[];
  /** If set, random loss only happens on these links (e.g. the internet side, not the home cable). */
  lossyLinks?: string[];
}

export const NO_FAULTS: FaultPlan = { randomLoss: 0, manual: [] };

export function shouldDrop(plan: FaultPlan, seed: number, linkId: string, packetId: string): boolean {
  if (plan.manual.some((m) => m.packetId === packetId && m.linkId === linkId)) return true;
  if (plan.randomLoss > 0 && (!plan.lossyLinks || plan.lossyLinks.includes(linkId))) {
    return hash32(`${linkId}|${packetId}`, seed ^ 0x5eed) / 4294967296 < plan.randomLoss;
  }
  return false;
}

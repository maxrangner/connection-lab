import { hash32 } from './core/Rng';

export interface ManualFault {
  packetId: string;
  linkId: string;
}

/** Sim-time span [from, to) during which random loss is active; `to` omitted means "until the end". */
export interface LossWindow {
  from: number;
  to?: number;
  /** If set, only these links are affected during the window (bad weather on one line). */
  links?: string[];
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
  /** If set, random loss only applies to frames sent inside one of these windows (weather that comes and goes). */
  lossWindows?: LossWindow[];
  /**
   * Outcomes already decided, keyed "packetId@linkId" (true: lost). Used to keep what a viewer has already seen
   * unchanged when the weather changes mid-run.
   */
  decided?: Record<string, boolean>;
}

export const NO_FAULTS: FaultPlan = { randomLoss: 0, manual: [] };

export function shouldDrop(plan: FaultPlan, seed: number, linkId: string, packetId: string, now = 0): boolean {
  if (plan.manual.some((m) => m.packetId === packetId && m.linkId === linkId)) return true;
  const decided = plan.decided?.[`${packetId}@${linkId}`];
  if (decided !== undefined) return decided;
  if (plan.randomLoss <= 0) return false;
  if (plan.lossyLinks && !plan.lossyLinks.includes(linkId)) return false;
  if (plan.lossWindows && !plan.lossWindows.some((w) => now >= w.from && (w.to === undefined || now < w.to) && (!w.links || w.links.includes(linkId)))) return false;
  return hash32(`${linkId}|${packetId}`, seed ^ 0x5eed) / 4294967296 < plan.randomLoss;
}

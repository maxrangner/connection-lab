import { hash32 } from './core/Rng';

export interface ManualFault {
  packetId: string;
  linkId: string;
}

/** A cable cut through for a span of sim time; `to` omitted means it stays cut. */
export interface Cut {
  link: string;
  from: number;
  to?: number;
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
  /**
   * Outcomes already decided, keyed "packetId@linkId" (true: lost). Used to keep what a viewer has already seen
   * unchanged when a cable is cut or mended mid-run.
   */
  decided?: Record<string, boolean>;
  /** Cut cables: every frame sent while a cable is cut is lost. */
  cuts?: Cut[];
}

export const NO_FAULTS: FaultPlan = { randomLoss: 0, manual: [] };

export function isCut(plan: FaultPlan, linkId: string, now: number): boolean {
  return !!plan.cuts?.some((c) => c.link === linkId && now >= c.from && (c.to === undefined || now < c.to));
}

export function shouldDrop(plan: FaultPlan, seed: number, linkId: string, packetId: string, now = 0): boolean {
  if (plan.manual.some((m) => m.packetId === packetId && m.linkId === linkId)) return true;
  const decided = plan.decided?.[`${packetId}@${linkId}`];
  if (decided !== undefined) return decided;
  if (isCut(plan, linkId, now)) return true;
  if (plan.randomLoss <= 0) return false;
  if (plan.lossyLinks && !plan.lossyLinks.includes(linkId)) return false;
  return hash32(`${linkId}|${packetId}`, seed ^ 0x5eed) / 4294967296 < plan.randomLoss;
}

/**
 * Lost to interference on a noisy radio (`LinkSpec.noise`): keyed by (seed, link, packet, attempt), so every try of the
 * same frame rolls its own dice and turning noise on never changes what happened before the first loss.
 */
export function lostToNoise(seed: number, linkId: string, packetId: string, attempt: number, noise: number): boolean {
  if (noise <= 0) return false;
  return hash32(`${linkId}|${packetId}|${attempt}|noise`, seed ^ 0x5eed) / 4294967296 < noise;
}

/** How many slots a Wi-Fi sender backs off before retry `attempt` of a frame: a hash-keyed draw from 0..cw, for the same reason. */
export function backoffSlots(seed: number, linkId: string, packetId: string, attempt: number, cw: number): number {
  return hash32(`${linkId}|${packetId}|${attempt}|backoff`, seed ^ 0x5eed) % (cw + 1);
}

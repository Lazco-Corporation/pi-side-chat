import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Where a side chat forks off the main branch.
 *
 * A side chat inherits the main conversation only up to a settled point, because the entries of a
 * run in progress can still change: a tool call may wait for its result, or the run may be retried.
 * What the main thread did after that point reaches the side chat as a short digest instead.
 */
export interface ForkPoint {
  /** The newest main entry that the side chat inherits. Null when it inherits nothing. */
  leafId: string | null;
  /** The root-to-leaf main entries that the side chat starts from. */
  inherited: SessionEntry[];
}

/**
 * While the main agent is idle, the whole branch is settled. While it runs, the fork stops at the
 * leaf of the last settled run, and nothing is inherited when that leaf is not on the branch, for
 * example during the first run of the session.
 */
export function chooseForkPoint(
  branch: readonly SessionEntry[],
  stableLeafId: string | null,
  mainIsIdle: boolean,
): ForkPoint {
  if (mainIsIdle) return { leafId: branch.at(-1)?.id ?? null, inherited: [...branch] };
  const index = stableLeafId === null ? -1 : branch.findIndex((entry) => entry.id === stableLeafId);
  if (index < 0) return { leafId: null, inherited: [] };
  return { leafId: stableLeafId, inherited: branch.slice(0, index + 1) };
}

/**
 * The main entries after the fork point. Without a fork point, that is the whole branch. When the
 * user moved to another branch, the inherited entries are not on it, so there is no activity since.
 */
export function activitySince(branch: readonly SessionEntry[], leafId: string | null): SessionEntry[] {
  if (leafId === null) return [...branch];
  const index = branch.findIndex((entry) => entry.id === leafId);
  return index < 0 ? [] : branch.slice(index + 1);
}

import { STANDUP_MAX_THREADS, type StandupBucket, type StandupThread } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../../types";

export interface StandupEntry {
  readonly thread: SidebarThreadSummary;
  readonly buckets: ReadonlyArray<StandupBucket>;
  /** Why a halted thread stopped. */
  readonly note: string | undefined;
  /** Latest standup-relevant moment, for ordering. */
  readonly at: number;
}

const NOTE_MAX = 300;

export function startOfLocalDay(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);

function haltNote(thread: SidebarThreadSummary, dayStart: number): string | undefined {
  if (thread.settledOverride === "settled") return undefined;
  const turn = thread.latestTurn;
  const turnAt = time(turn?.completedAt ?? turn?.startedAt ?? turn?.requestedAt);
  if (turnAt >= dayStart) {
    if (thread.hasPendingApprovals) return "waiting for approval";
    if (thread.hasPendingUserInput) return "waiting for an answer";
    if (turn?.state === "interrupted") return "stopped before finishing";
    if (turn?.state === "error") return "turn failed";
  }
  const session = thread.session;
  if (session?.status === "error" && time(session.updatedAt) >= dayStart) {
    const reason = session.lastError?.trim();
    return reason ? `session error: ${reason.slice(0, NOTE_MAX)}` : "session error";
  }
  return undefined;
}

/**
 * Today's standup from the thread shells: started is created today; closed is
 * settled today or a linked PR merged today; halted is an unsettled thread whose
 * latest turn stopped, failed, or waits on the user today. A thread may be in
 * several buckets. Auto-settle backdates settledAt to the last activity, so
 * inactivity sweeps do not count as closing work today.
 */
export function deriveStandupEntries(
  threads: ReadonlyArray<SidebarThreadSummary>,
  dayStart: number,
): StandupEntry[] {
  const entries: StandupEntry[] = [];
  for (const thread of threads) {
    const createdAt = time(thread.createdAt);
    // NaN (never settled, not merged) fails the comparison and drops out.
    const closedAt = [
      thread.settledOverride === "settled" ? time(thread.settledAt) : Number.NaN,
      ...thread.pullRequests.map((pullRequest) =>
        pullRequest.snapshot?.state === "merged" ? time(pullRequest.snapshot.mergedAt) : Number.NaN,
      ),
    ].filter((at) => at >= dayStart);
    const note = haltNote(thread, dayStart);

    const buckets: StandupBucket[] = [];
    if (createdAt >= dayStart) buckets.push("started");
    if (closedAt.length > 0) buckets.push("closed");
    if (note !== undefined) buckets.push("halted");
    if (buckets.length === 0) continue;

    const turnAt = time(thread.latestTurn?.completedAt ?? thread.latestTurn?.startedAt);
    const at = Math.max(createdAt, ...closedAt, Number.isNaN(turnAt) ? 0 : turnAt);
    entries.push({ thread, buckets, note, at });
  }
  return entries.toSorted((left, right) => right.at - left.at);
}

/** What a summary was written from; a different key means the lists moved on. */
export function standupEntriesKey(entries: ReadonlyArray<StandupEntry>): string {
  return entries
    .map((entry) => `${entry.thread.environmentId}/${entry.thread.id}:${entry.buckets.join("+")}`)
    .toSorted()
    .join("|");
}

/** The most recent threads, up to what one summary request may carry. */
export function toStandupThreads(entries: ReadonlyArray<StandupEntry>): StandupThread[] {
  return entries.slice(0, STANDUP_MAX_THREADS).map((entry) => ({
    threadId: entry.thread.id,
    buckets: entry.buckets,
    ...(entry.note !== undefined ? { note: entry.note } : {}),
  }));
}

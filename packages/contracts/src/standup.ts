/**
 * Standup summary contract.
 *
 * The client sorts the thread shells it already holds into today's buckets and
 * asks each environment to summarize its own threads. The environment reads the
 * messages itself, so thread history never crosses the wire.
 *
 * @module standup
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Most threads one summary request may carry. */
export const STANDUP_MAX_THREADS = 100;

export const StandupBucket = Schema.Literals(["started", "closed", "halted"]);
export type StandupBucket = typeof StandupBucket.Type;

export const StandupThread = Schema.Struct({
  threadId: ThreadId,
  buckets: Schema.Array(StandupBucket).check(Schema.isMinLength(1)),
  /** Why a halted thread stopped, for example "waiting for approval". */
  note: Schema.optional(TrimmedNonEmptyString),
});
export type StandupThread = typeof StandupThread.Type;

export const StandupSummaryInput = Schema.Struct({
  threads: Schema.Array(StandupThread).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(STANDUP_MAX_THREADS),
  ),
});
export type StandupSummaryInput = typeof StandupSummaryInput.Type;

export const StandupSummary = Schema.Struct({
  /** Markdown. */
  summary: Schema.String,
  generatedAt: IsoDateTime,
});
export type StandupSummary = typeof StandupSummary.Type;

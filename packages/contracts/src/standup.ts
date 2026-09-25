/**
 * Standup contract.
 *
 * Each environment reports the threads it holds that saw work in a time window
 * (normally one local day, which the client picks) and writes their standup. The
 * environment reads its own history, so thread messages never cross the wire.
 *
 * @module standup
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Where a thread stood at the end of the reported day. */
export const StandupStatus = Schema.Literals(["done", "in-progress", "blocked"]);
export type StandupStatus = typeof StandupStatus.Type;

/** A half-open window, `from` inclusive and `to` exclusive. */
export const StandupDayInput = Schema.Struct({
  from: IsoDateTime,
  to: IsoDateTime,
});
export type StandupDayInput = typeof StandupDayInput.Type;

export const StandupDayThread = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  projectTitle: Schema.NullOr(Schema.String),
  status: StandupStatus,
  /** Signals behind the status, for example "new · waiting for approval". */
  note: Schema.NullOr(Schema.String),
});
export type StandupDayThread = typeof StandupDayThread.Type;

export const StandupDay = Schema.Struct({
  threads: Schema.Array(StandupDayThread),
  /** Identifies the threads and statuses; a summary with another key is out of date. */
  key: Schema.String,
});
export type StandupDay = typeof StandupDay.Type;

export const StandupSummary = Schema.Struct({
  /** Markdown. */
  summary: Schema.String,
  generatedAt: IsoDateTime,
  /** The {@link StandupDay} key the summary was written from. */
  key: Schema.String,
});
export type StandupSummary = typeof StandupSummary.Type;

export class StandupError extends Schema.TaggedError<StandupError>()("StandupError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

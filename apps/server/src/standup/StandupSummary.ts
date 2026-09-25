import * as NodeOS from "node:os";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { type StandupDayInput, StandupError, type StandupSummary } from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  formatThreadTitleContext,
  limitTitleMessage,
} from "../textGeneration/ThreadTitleContext.ts";
import { readStandupThreadMessages, selectStandupDay, standupDayKey } from "./StandupDay.ts";

/** Most threads one summary reads; the most recently active win. */
const MAX_THREADS = 100;
/** Thread history the prompt carries in total, shared evenly across threads. */
const CONTEXT_BUDGET = 60_000;
const THREAD_CONTEXT_MAX = 4_000;

/**
 * Writes the standup for a window from this environment's own history, so
 * thread messages never cross the wire. Returns the day key it was written from.
 */
export const generateStandupSummary = Effect.fn("generateStandupSummary")(function* (
  input: StandupDayInput,
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const now = DateTime.formatIso(yield* DateTime.now);
  const entries = yield* selectStandupDay(input, now);
  if (entries.length === 0) {
    return yield* new StandupError({ detail: "No thread work on this day." });
  }
  const selected = entries.slice(0, MAX_THREADS);
  const budget = Math.min(THREAD_CONTEXT_MAX, Math.floor(CONTEXT_BUDGET / selected.length));
  const threads = yield* Effect.forEach(
    selected,
    (entry) =>
      readStandupThreadMessages(entry.threadId, input).pipe(
        Effect.map((messages) => ({
          title: entry.title,
          projectTitle: entry.projectTitle ?? undefined,
          branch: entry.branch,
          pullRequests: entry.pullRequests.map(
            (pullRequest) =>
              `${pullRequest.repository}#${pullRequest.number}` +
              (pullRequest.title ? ` ${pullRequest.title}` : "") +
              (pullRequest.state ? ` (${pullRequest.state})` : ""),
          ),
          status: entry.status,
          note: entry.note ?? undefined,
          context: limitTitleMessage(formatThreadTitleContext(messages).message, budget),
        })),
      ),
    { concurrency: 4 },
  );

  const { textGenerationModelSelection: modelSelection } = yield* settings.getSettings.pipe(
    Effect.mapError(
      (cause) => new StandupError({ detail: "Could not read text generation settings.", cause }),
    ),
  );
  const { summary } = yield* textGeneration
    .generateStandupSummary({ cwd: NodeOS.tmpdir(), threads, modelSelection })
    .pipe(Effect.mapError((cause) => new StandupError({ detail: cause.message, cause })));
  return {
    summary: summary.trim(),
    generatedAt: DateTime.formatIso(yield* DateTime.now),
    key: standupDayKey(entries),
  } satisfies StandupSummary;
});

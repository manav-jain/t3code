import * as NodeOS from "node:os";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  type StandupSummary,
  type StandupSummaryInput,
  TextGenerationError,
} from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  formatThreadTitleContext,
  limitTitleMessage,
} from "../textGeneration/ThreadTitleContext.ts";

/** Thread history the prompt carries in total, shared evenly across threads. */
const CONTEXT_BUDGET = 60_000;
const THREAD_CONTEXT_MAX = 4_000;

const failure = (detail: string, cause?: unknown) =>
  new TextGenerationError({ operation: "generateStandupSummary", detail, cause });

/**
 * Writes the standup for threads the client bucketed. Reads each thread's own
 * history here so messages never cross the wire, and skips ids this environment
 * does not know.
 */
export const generateStandupSummary = Effect.fn("generateStandupSummary")(function* (
  input: StandupSummaryInput,
) {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const budget = Math.min(THREAD_CONTEXT_MAX, Math.floor(CONTEXT_BUDGET / input.threads.length));
  const threads = yield* Effect.forEach(
    input.threads,
    (entry) =>
      Effect.gen(function* () {
        const thread = Option.getOrUndefined(
          yield* snapshots.getThreadDetailById(entry.threadId, { activityKinds: [] }),
        );
        if (!thread) return [];
        const project = Option.getOrUndefined(
          yield* snapshots.getProjectShellById(thread.projectId),
        );
        return [
          {
            title: thread.title,
            projectTitle: project?.title,
            buckets: entry.buckets,
            note: entry.note,
            context: limitTitleMessage(formatThreadTitleContext(thread.messages).message, budget),
          },
        ];
      }),
    { concurrency: 4 },
  ).pipe(
    Effect.map((found) => found.flat()),
    Effect.mapError((cause) => failure("Failed to read today's threads.", cause)),
  );
  if (threads.length === 0) {
    return yield* failure("None of these threads exist on this environment.");
  }

  const { textGenerationModelSelection: modelSelection } = yield* settings.getSettings.pipe(
    Effect.mapError((cause) => failure("Failed to read text generation settings.", cause)),
  );
  const { summary } = yield* textGeneration.generateStandupSummary({
    cwd: NodeOS.tmpdir(),
    threads,
    modelSelection,
  });
  return {
    summary: summary.trim(),
    generatedAt: DateTime.formatIso(yield* DateTime.now),
  } satisfies StandupSummary;
});

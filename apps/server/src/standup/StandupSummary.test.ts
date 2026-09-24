import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  type OrchestrationProjectShell,
  type OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { generateStandupSummary } from "./StandupSummary.ts";

const loginThread = {
  id: ThreadId.make("thread-login"),
  projectId: ProjectId.make("project-web"),
  title: "Fix login redirect",
  messages: [
    { role: "user", text: "The login page loops back to itself after SSO." },
    { role: "assistant", text: "Found it: the callback drops the return path." },
  ],
} as unknown as OrchestrationThread;

const run = (threadIds: ReadonlyArray<ThreadId>) => {
  const requests: TextGeneration.StandupSummaryGenerationInput[] = [];
  const layer = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
      getThreadDetailById: (threadId) =>
        Effect.succeed(threadId === loginThread.id ? Option.some(loginThread) : Option.none()),
      getProjectShellById: () =>
        Effect.succeed(Option.some({ title: "Web" } as OrchestrationProjectShell)),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateStandupSummary: (input) => {
        requests.push(input);
        return Effect.succeed({ summary: "\n## Halted\n- **Fix login redirect**\n" });
      },
    }),
    ServerSettings.layerTest(),
  );
  return generateStandupSummary({
    threads: threadIds.map((threadId) => ({
      threadId,
      buckets: ["started", "halted"],
      note: "waiting for approval",
    })),
  }).pipe(
    Effect.map((result) => ({ result, requests })),
    Effect.provide(layer),
  );
};

it.effect("summarizes the threads this environment owns and skips the rest", () =>
  Effect.gen(function* () {
    const { result, requests } = yield* run([loginThread.id, ThreadId.make("thread-elsewhere")]);

    assert.strictEqual(result.summary, "## Halted\n- **Fix login redirect**");
    assert.strictEqual(requests.length, 1);
    const [thread] = requests[0]!.threads;
    assert.strictEqual(requests[0]!.threads.length, 1);
    assert.deepStrictEqual(
      { title: thread!.title, project: thread!.projectTitle, note: thread!.note },
      { title: "Fix login redirect", project: "Web", note: "waiting for approval" },
    );
    assert.deepStrictEqual(thread!.buckets, ["started", "halted"]);
    assert.include(thread!.context, "loops back to itself after SSO");
    assert.include(thread!.context, "callback drops the return path");
  }),
);

it.effect("fails instead of summarizing nothing when no thread is known here", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(run([ThreadId.make("thread-elsewhere")]));
    assert.include(error.message, "None of these threads exist on this environment.");
  }),
);

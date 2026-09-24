import {
  OrchestrationCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const decodeCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const KEY = { channelId: "C0123ABC", threadTs: "1712345678.123456" };

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: THREAD_ID,
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: NOW,
};

const decideAndProject = (model: OrchestrationReadModel, command: unknown) =>
  Effect.gen(function* () {
    const decided = yield* decideOrchestrationCommand({
      readModel: model,
      command: yield* decodeCommand(command),
    });
    const events = Array.isArray(decided) ? decided : [decided];
    let next = model;
    for (const event of events) {
      next = yield* projectEvent(next, { ...event, sequence: next.snapshotSequence + 1 });
    }
    return next;
  });

it.layer(NodeServices.layer)("slack thread link decider", (it) => {
  it.effect("links once, rejects a second link, and unlinks", () =>
    Effect.gen(function* () {
      const link = {
        type: "thread.slack-thread.link",
        commandId: "link",
        threadId: THREAD_ID,
        ...KEY,
        url: "https://acme.slack.com/archives/C0123ABC/p1712345999000001?thread_ts=1712345678.123456",
        source: "manual",
      };
      const linked = yield* decideAndProject(readModel, link);
      expect(linked.threads[0]!.slackThreads).toEqual([
        { ...KEY, url: link.url, source: "manual", linkedAt: expect.any(String) },
      ]);

      const duplicate = yield* decideAndProject(linked, {
        ...link,
        commandId: "link-again",
        url: "https://acme.slack.com/archives/C0123ABC/p1712345678123456",
      }).pipe(Effect.flip);
      expect(duplicate._tag).toBe("OrchestrationCommandInvariantError");

      const unlink = { type: "thread.slack-thread.unlink", threadId: THREAD_ID, ...KEY };
      const unlinked = yield* decideAndProject(linked, { ...unlink, commandId: "unlink" });
      expect(unlinked.threads[0]!.slackThreads).toEqual([]);

      const missing = yield* decideAndProject(unlinked, {
        ...unlink,
        commandId: "unlink-again",
      }).pipe(Effect.flip);
      expect(missing._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});

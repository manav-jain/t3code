import { CommandId, type OrchestrationCommand } from "@t3tools/contracts";
import { parseSlackThreadUrl } from "@t3tools/shared/slackThreadUrl";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as SlackThreads from "../../../slack/SlackThreads.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { SlackThreadLinkFailedError, SlackThreadUrlInvalidError, SlackToolkit } from "./tools.ts";

const parseUrl = (url: string) => {
  const key = parseSlackThreadUrl(url);
  return key === null ? Effect.fail(new SlackThreadUrlInvalidError({})) : Effect.succeed(key);
};

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const slack = yield* SlackThreads.SlackThreads;
  const crypto = yield* Crypto.Crypto;

  // Every provider session may manage its own thread's links, as with pull requests,
  // so there is no capability to check; the invocation only names the thread.
  const currentThread = Effect.gen(function* () {
    const { threadId } = yield* McpInvocationContext.McpInvocationContext;
    const thread = yield* snapshots
      .getThreadShellById(threadId)
      .pipe(Effect.mapError((cause) => new SlackThreadLinkFailedError({ cause })));
    if (Option.isNone(thread)) {
      return yield* new SlackThreadLinkFailedError({ cause: `Thread ${threadId} was not found.` });
    }
    return thread.value;
  });

  /** True when the command applied; false when the decider found nothing to change. */
  const dispatch = (
    command: Extract<
      OrchestrationCommand,
      { type: "thread.slack-thread.link" | "thread.slack-thread.unlink" }
    >,
  ) =>
    engine.dispatch(command).pipe(
      Effect.as(true),
      Effect.catchTags({ OrchestrationCommandInvariantError: () => Effect.succeed(false) }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.fail(new SlackThreadLinkFailedError({ cause })),
      ),
    );

  const commandId = (tag: string, threadId: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:${tag}:${threadId}:${uuid}`)),
    );

  return SlackToolkit.of({
    link_slack_thread: ({ url }) =>
      Effect.gen(function* () {
        const key = yield* parseUrl(url);
        const thread = yield* currentThread;
        const linked = yield* dispatch({
          type: "thread.slack-thread.link",
          commandId: yield* commandId("mcp-slack-link", thread.id),
          threadId: thread.id,
          ...key,
          url,
          source: "agent",
        });
        return { ...key, alreadyLinked: !linked };
      }),
    unlink_slack_thread: ({ url }) =>
      Effect.gen(function* () {
        const key = yield* parseUrl(url);
        const thread = yield* currentThread;
        const wasLinked = yield* dispatch({
          type: "thread.slack-thread.unlink",
          commandId: yield* commandId("mcp-slack-unlink", thread.id),
          threadId: thread.id,
          ...key,
        });
        return { ...key, wasLinked };
      }),
    list_thread_slack_threads: () =>
      currentThread.pipe(Effect.map((thread) => ({ slackThreads: thread.slackThreads ?? [] }))),
    read_slack_thread: ({ url }) => parseUrl(url).pipe(Effect.flatMap(slack.read)),
  });
});

export const SlackToolkitHandlersLive = SlackToolkit.toLayer(make);

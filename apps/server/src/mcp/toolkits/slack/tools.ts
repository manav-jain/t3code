import {
  SlackThreadReadError,
  SlackThreadReadResult,
  ThreadSlackThreadKey,
  ThreadSlackThreadLink,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

export const SlackThreadUrlInput = Schema.Struct({
  url: TrimmedNonEmptyString.annotate({
    description:
      "A Slack message link, for example https://acme.slack.com/archives/C0123ABC/p1712345678123456. A reply's link names its parent thread.",
  }),
});

export class SlackThreadUrlInvalidError extends Schema.TaggedError<SlackThreadUrlInvalidError>()(
  "SlackThreadUrlInvalidError",
  {},
) {
  override get message(): string {
    return "This is not a Slack message link. Use Copy link on a message in the thread.";
  }
}

export class SlackThreadLinkFailedError extends Schema.TaggedError<SlackThreadLinkFailedError>()(
  "SlackThreadLinkFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not update this thread's Slack links.";
  }
}

const SlackThreadToolError = Schema.Union([
  SlackThreadUrlInvalidError,
  SlackThreadLinkFailedError,
  SlackThreadReadError,
]);

const LinkSlackThreadTool = Tool.make("link_slack_thread", {
  description:
    "When the user shares a Slack thread link for this work, link it to this thread so it appears beside the thread and stays readable with read_slack_thread. Linking an already-linked Slack thread succeeds with alreadyLinked=true.",
  parameters: SlackThreadUrlInput,
  success: Schema.Struct({ ...ThreadSlackThreadKey.fields, alreadyLinked: Schema.Boolean }),
  failure: SlackThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Link Slack thread to thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UnlinkSlackThreadTool = Tool.make("unlink_slack_thread", {
  description:
    "Remove a Slack thread link from this thread. Unlinking a Slack thread that is not linked succeeds with wasLinked=false.",
  parameters: SlackThreadUrlInput,
  success: Schema.Struct({ ...ThreadSlackThreadKey.fields, wasLinked: Schema.Boolean }),
  failure: SlackThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Unlink Slack thread from thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListThreadSlackThreadsTool = Tool.make("list_thread_slack_threads", {
  description:
    "List the Slack threads linked to this thread. Read one with read_slack_thread when its discussion matters to the task.",
  success: Schema.Struct({ slackThreads: Schema.Array(ThreadSlackThreadLink) }),
  failure: SlackThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "List thread Slack threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ReadSlackThreadTool = Tool.make("read_slack_thread", {
  description:
    "Read the messages of a Slack thread, oldest first, with the environment's Slack token. Works for any thread the token can see, linked or not.",
  parameters: SlackThreadUrlInput,
  success: SlackThreadReadResult,
  failure: SlackThreadToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read Slack thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const SlackToolkit = Toolkit.make(
  LinkSlackThreadTool,
  UnlinkSlackThreadTool,
  ListThreadSlackThreadsTool,
  ReadSlackThreadTool,
);

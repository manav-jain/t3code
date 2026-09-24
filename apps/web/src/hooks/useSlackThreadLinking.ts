import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { parseSlackThreadUrl, slackThreadKeysEqual } from "@t3tools/shared/slackThreadUrl";
import { useMemo } from "react";

import { readThreadShell, useServerConfigs } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

/** Link and unlink Slack URLs from a chat link's context menu. */
export function useSlackThreadLinking(threadRef: ScopedThreadRef | undefined) {
  const supported =
    useServerConfigs().get(threadRef?.environmentId ?? ("" as EnvironmentId))?.environment
      .capabilities.threadSlackThreads === true;
  const link = useAtomCommand(threadEnvironment.linkSlackThread, { reportFailure: false });
  const unlink = useAtomCommand(threadEnvironment.unlinkSlackThread, { reportFailure: false });
  return useMemo(() => {
    /** The menu action a Slack URL offers, or undefined when it is not a linkable Slack thread. */
    const actionFor = (href: string) => {
      const key = parseSlackThreadUrl(href);
      const thread = threadRef === undefined ? null : readThreadShell(threadRef);
      if (!supported || key === null || thread === null) return undefined;
      return (thread.slackThreads ?? []).some((entry) => slackThreadKeysEqual(entry, key))
        ? ("unlink-from-thread" as const)
        : ("link-to-thread" as const);
    };
    const update = async (href: string, linked: boolean) => {
      const key = parseSlackThreadUrl(href);
      if (threadRef === undefined || key === null) return;
      const { environmentId, threadId } = threadRef;
      const result = await (linked
        ? link({ environmentId, input: { threadId, ...key, url: href, source: "manual" } })
        : unlink({ environmentId, input: { threadId, ...key } }));
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        throw squashAtomCommandFailure(result);
      }
    };
    return { actionFor, update };
  }, [link, supported, threadRef, unlink]);
}

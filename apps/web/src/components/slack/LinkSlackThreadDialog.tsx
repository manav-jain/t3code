import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { parseSlackThreadUrl, slackThreadKeysEqual } from "@t3tools/shared/slackThreadUrl";
import { Atom } from "effect/unstable/reactivity";
import { useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

/** Which thread has the dialog open; set by the palette or the panel, rendered once by the chat view. */
const linkSlackThreadDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("slack-threads:link-dialog-thread"),
);

export function openLinkSlackThreadDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(linkSlackThreadDialogThreadAtom, threadRef);
}

export function LinkSlackThreadDialogHost() {
  const threadRef = useAtomValue(linkSlackThreadDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <LinkSlackThreadDialog
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(linkSlackThreadDialogThreadAtom, null)}
    />
  );
}

function LinkSlackThreadDialog({
  threadRef,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  onClose: () => void;
}) {
  const thread = useThreadShell(threadRef);
  const link = useAtomCommand(threadEnvironment.linkSlackThread, { reportFailure: false });
  const [url, setUrl] = useState("");
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const key = parseSlackThreadUrl(url);
  const alreadyLinked =
    key !== null && (thread?.slackThreads ?? []).some((entry) => slackThreadKeysEqual(entry, key));
  const validation = !dirty
    ? null
    : key === null
      ? "Paste a Slack message link: Copy link on any message in the thread."
      : alreadyLinked
        ? "This Slack thread is already linked."
        : null;

  const submit = async () => {
    setDirty(true);
    if (key === null || alreadyLinked) return;
    setSubmitError(null);
    setPending(true);
    const result = await link({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, ...key, url: url.trim(), source: "manual" },
    });
    setPending(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      setSubmitError(error instanceof Error ? error.message : "Could not link the Slack thread.");
      return;
    }
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open || pending ? undefined : onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Link Slack thread</DialogTitle>
          <DialogDescription>
            Attach a Slack thread to this thread. You and the agent can read it from the Slack
            threads panel.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            autoFocus
            placeholder="https://acme.slack.com/archives/C0123ABC/p1712345678123456"
            value={url}
            onChange={(event) => {
              setDirty(true);
              setUrl(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void submit();
            }}
          />
          {(validation ?? submitError) ? (
            <p className="text-destructive text-xs">{validation ?? submitError}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={pending || key === null || alreadyLinked}
          >
            {pending ? "Linking..." : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

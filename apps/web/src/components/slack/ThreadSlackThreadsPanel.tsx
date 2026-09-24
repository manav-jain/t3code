import type { ScopedThreadRef, ThreadSlackThreadLink } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  ChevronRightIcon,
  LinkIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
  PlusIcon,
  UnlinkIcon,
} from "lucide-react";
import { useState } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { useServerConfigs, useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button, InlineButton } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { openLinkSlackThreadDialog } from "./LinkSlackThreadDialog";

const SOURCE_LABELS: Record<ThreadSlackThreadLink["source"], string> = {
  manual: "Linked by you",
  agent: "Linked by the agent",
};

const slackTimeIso = (ts: string) => new Date(Number(ts) * 1000).toISOString();

function SlackThreadRow({
  link,
  threadRef,
  canRead,
}: {
  link: ThreadSlackThreadLink;
  threadRef: ScopedThreadRef;
  canRead: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // Read on first expand, then keep the result for the collapsed row's preview.
  const [requested, setRequested] = useState(false);
  const unlink = useAtomCommand(threadEnvironment.unlinkSlackThread, { reportFailure: true });
  const read = useEnvironmentQuery(
    requested && canRead
      ? threadEnvironment.slackThread({
          environmentId: threadRef.environmentId,
          input: { channelId: link.channelId, threadTs: link.threadTs },
        })
      : null,
  );
  const first = read.data?.messages[0];

  return (
    <div className="flex flex-col">
      <div className="group/slack-row flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-accent/60">
        <button
          type="button"
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm"
          onClick={() => {
            setExpanded(!expanded);
            setRequested(true);
          }}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-90")}
          />
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
              {first ? `${first.userName}: ${first.text}` : `#${link.channelId}`}
            </TooltipTrigger>
            <TooltipPopup>
              {SOURCE_LABELS[link.source]} · {formatRelativeTimeLabel(link.linkedAt)}
            </TooltipPopup>
          </Tooltip>
        </button>
        <Menu>
          <MenuTrigger
            render={
              <Button variant="ghost" size="icon-micro" aria-label="Slack thread actions">
                <MoreHorizontalIcon className="size-3.5" />
              </Button>
            }
          />
          <MenuPopup align="end" side="bottom">
            <MenuItem onClick={() => void readLocalApi()?.shell.openExternal(link.url)}>
              <ArrowUpRightIcon className="size-3.5" />
              Open in Slack
            </MenuItem>
            <MenuItem onClick={() => void writeTextToClipboard(link.url, "link")}>
              <LinkIcon className="size-3.5" />
              Copy link
            </MenuItem>
            <MenuItem
              onClick={() =>
                void unlink({
                  environmentId: threadRef.environmentId,
                  input: {
                    threadId: threadRef.threadId,
                    channelId: link.channelId,
                    threadTs: link.threadTs,
                  },
                })
              }
            >
              <UnlinkIcon className="size-3.5" />
              Unlink from thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {expanded ? (
        <div className="mb-2 ml-3.5 flex flex-col gap-2 border-l border-border/60 py-1 pl-3 text-xs">
          {!canRead ? (
            <p className="text-muted-foreground">Add a Slack token to read this thread.</p>
          ) : read.error ? (
            <p className="text-destructive">
              {read.error} <InlineButton onClick={read.refresh}>Retry</InlineButton>
            </p>
          ) : read.data === null ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : (
            <>
              {read.data.messages.map((message) => (
                <div key={message.ts} className="flex flex-col gap-0.5">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium">{message.userName}</span>
                    <span className="text-muted-foreground">
                      {formatRelativeTimeLabel(slackTimeIso(message.ts))}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>
                </div>
              ))}
              {read.data.truncated ? (
                <p className="text-muted-foreground">
                  Showing the first {read.data.messages.length} messages. Open in Slack for the
                  rest.
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ThreadSlackThreadsPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const thread = useThreadShell(threadRef);
  const links = thread?.slackThreads ?? [];
  // The server only sends a redacted marker, so a non-empty token means one is saved.
  const canRead =
    (useServerConfigs().get(threadRef.environmentId)?.settings.slack.token ?? "").length > 0;
  const openLinkDialog = () => openLinkSlackThreadDialog(threadRef);
  const tokenHint = canRead ? null : (
    <p className="text-xs text-muted-foreground">
      Reading threads needs a Slack token.{" "}
      <InlineButton onClick={() => void navigate({ to: "/settings/integrations", hash: "slack" })}>
        Add one in Settings
      </InlineButton>
    </p>
  );

  if (links.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <MessagesSquareIcon aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No linked Slack threads</p>
        <p className="max-w-60 text-xs text-muted-foreground">
          Link the Slack discussion behind this work to read it here and share it with the agent.
        </p>
        <Button size="sm" variant="outline" onClick={openLinkDialog}>
          <PlusIcon className="size-3.5" />
          Link Slack thread
        </Button>
        {tokenHint}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col p-1.5">
          {tokenHint ? <div className="px-1.5 pb-1.5">{tokenHint}</div> : null}
          {links.map((link) => (
            <SlackThreadRow
              key={`${link.channelId}/${link.threadTs}`}
              link={link}
              threadRef={threadRef}
              canRead={canRead}
            />
          ))}
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-2 py-1.5 text-[.7rem] text-muted-foreground">
        <span>{links.length} linked</span>
        <Button size="xs" variant="ghost" onClick={openLinkDialog}>
          <PlusIcon className="size-3.5" />
          Link
        </Button>
      </footer>
    </div>
  );
}

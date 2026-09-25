import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, StandupDayInput, StandupStatus } from "@t3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { isElectron } from "../../env";
import { isEditableFocused } from "../../lib/editableFocus";
import { useServerConfigs } from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { standupDay, standupGenerate, standupKey, useStandupStore } from "../../state/standup";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { dayLabel, dayWindow, localDay, shiftDay } from "./standup.logic";

const STATUSES: ReadonlyArray<{ readonly status: StandupStatus; readonly title: string }> = [
  { status: "done", title: "Done" },
  { status: "in-progress", title: "In progress" },
  { status: "blocked", title: "Blocked" },
];

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * One day's standup: each environment reports the threads it saw work on that
 * day and writes a task-level summary. ←/→ (or the arrows by the date) step
 * through days. A day's first summary is written when it is first opened; today's
 * lists keep moving after that, and Refresh reconciles the summary with them.
 */
export function StandupPage() {
  const search = useSearch({ from: "/standup" });
  const navigate = useNavigate();
  const serverConfigs = useServerConfigs();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const today = localDay(new Date());
  const day = search.day !== undefined && search.day < today ? search.day : today;
  const window = dayWindow(day);
  const refreshing = useStandupStore((state) =>
    Object.entries(state.byDay).some(
      ([key, standup]) => key.endsWith(`|${window.from}`) && standup.status === "generating",
    ),
  );

  const environmentIds = [...serverConfigs]
    .filter(([, config]) => config.environment.capabilities.standupSummary === true)
    .map(([environmentId]) => environmentId);
  const environmentLabel = (environmentId: EnvironmentId) =>
    presentations.get(environmentId)?.entry.target.label ?? environmentId;

  const goToDay = (next: string) => {
    if (next > today) return;
    void navigate({ to: "/standup", search: next === today ? {} : { day: next }, replace: true });
  };
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.shiftKey || isEditableFocused(event.target)) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    goToDay(shiftDay(day, event.key === "ArrowLeft" ? -1 : 1));
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    globalThis.addEventListener("keydown", listener);
    return () => globalThis.removeEventListener("keydown", listener);
  }, []);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="flex w-full min-w-0 items-center gap-3 py-2">
            <WorkspaceBreadcrumb ariaLabel="Standup breadcrumb" className="min-w-0">
              <WorkspaceBreadcrumbItem current>
                <h1>Standup</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <div className="flex min-w-0 items-center gap-1">
              <Button
                onClick={() => goToDay(shiftDay(day, -1))}
                aria-label="Previous day"
                size="icon-sm"
                variant="ghost"
              >
                <ChevronLeftIcon />
              </Button>
              <span className="min-w-24 truncate text-center text-xs text-muted-foreground">
                {dayLabel(day, today)}
              </span>
              <Button
                onClick={() => goToDay(shiftDay(day, 1))}
                aria-label="Next day"
                disabled={day === today}
                size="icon-sm"
                variant="ghost"
              >
                <ChevronRightIcon />
              </Button>
            </div>
            <div className="ms-auto">
              <Button
                onClick={() => setRefreshNonce((nonce) => nonce + 1)}
                aria-label="Refresh standup"
                aria-busy={refreshing}
                disabled={refreshing || environmentIds.length === 0}
                size="icon-sm"
                variant="ghost"
              >
                <RefreshIcon size="sm" refreshing={refreshing} />
              </Button>
            </div>
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="readable">
            {environmentIds.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Connect an environment running a server with Standup to see your days.
              </p>
            ) : (
              <div className="flex flex-col gap-10">
                {environmentIds.map((environmentId) => (
                  <StandupEnvironmentDay
                    key={`${environmentId}|${window.from}`}
                    environmentId={environmentId}
                    window={window}
                    label={environmentIds.length > 1 ? environmentLabel(environmentId) : null}
                    refreshNonce={refreshNonce}
                  />
                ))}
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function StandupEnvironmentDay({
  environmentId,
  window,
  label,
  refreshNonce,
}: {
  readonly environmentId: EnvironmentId;
  readonly window: StandupDayInput;
  readonly label: string | null;
  readonly refreshNonce: number;
}) {
  const dayQuery = useEnvironmentQuery(standupDay({ environmentId, input: window }));
  const key = standupKey(environmentId, window.from);
  const standup = useStandupStore((state) => state.byDay[key]);
  const updateStandup = useStandupStore((state) => state.update);
  const generateCommand = useAtomCommand(standupGenerate, { reportFailure: false });
  const day = dayQuery.data;

  const generate = async () => {
    const summary = useStandupStore.getState().byDay[key]?.summary ?? null;
    updateStandup(key, { status: "generating", summary, error: null });
    const result = await generateCommand({ environmentId, input: window });
    if (result._tag === "Success") {
      updateStandup(key, { status: "ready", summary: result.value, error: null });
      return;
    }
    const error = squashAtomCommandFailure(result);
    updateStandup(key, {
      status: "failed",
      summary,
      error: error instanceof Error ? error.message : "Could not write the standup.",
    });
  };

  // A day's first standup is written the first time it is opened with work in it.
  const writeFirstStandup = useEffectEvent(() => {
    if ((day?.threads.length ?? 0) > 0 && !useStandupStore.getState().byDay[key]) void generate();
  });
  useEffect(() => writeFirstStandup(), [day]);

  const handleRefresh = useEffectEvent(() => {
    dayQuery.refresh();
    if ((day?.threads.length ?? 0) > 0) void generate();
  });
  const seenNonce = useRef(refreshNonce);
  useEffect(() => {
    if (seenNonce.current === refreshNonce) return;
    seenNonce.current = refreshNonce;
    handleRefresh();
  }, [refreshNonce]);

  const summary = standup?.summary ?? null;
  return (
    <section className="flex flex-col gap-6">
      {label ? <h2 className="text-sm font-medium">{label}</h2> : null}
      {day === null ? (
        dayQuery.error ? (
          <p className="text-sm text-muted-foreground">Could not load this day: {dayQuery.error}</p>
        ) : (
          <StandupSkeleton />
        )
      ) : day.threads.length === 0 ? (
        <p className="text-sm text-muted-foreground">No thread work on this day.</p>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {summary === null && standup?.status !== "failed" ? (
              <StandupSkeleton />
            ) : summary ? (
              <ChatMarkdown text={summary.summary} cwd={undefined} environmentId={environmentId} />
            ) : null}
            <p className="text-xs text-muted-foreground">
              {[
                summary ? `Written at ${timeLabel(summary.generatedAt)}` : null,
                standup?.status === "generating" && summary ? "Updating…" : null,
                standup?.status === "ready" && summary && summary.key !== day.key
                  ? "Threads changed since. Refresh to update."
                  : null,
                standup?.status === "failed"
                  ? `Could not write the standup: ${standup.error}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          {STATUSES.map(({ status, title }) => {
            const rows = day.threads.filter((thread) => thread.status === status);
            if (rows.length === 0) return null;
            return (
              <section key={status} className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">
                  {title} <span className="text-muted-foreground">{rows.length}</span>
                </h3>
                <ul className="flex flex-col">
                  {rows.map((thread) => (
                    <li key={thread.threadId}>
                      <Link
                        to="/$environmentId/$threadId"
                        params={buildThreadRouteParams(
                          scopeThreadRef(environmentId, thread.threadId),
                        )}
                        className="flex min-w-0 items-baseline gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                      >
                        <span className="truncate">{thread.title}</span>
                        <span className="shrink-0 truncate text-xs text-muted-foreground">
                          {[thread.projectTitle, thread.note].filter(Boolean).join(" · ")}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </section>
  );
}

function StandupSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-label="Loading standup">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

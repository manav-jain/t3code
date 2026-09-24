import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, StandupBucket } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useMemo } from "react";

import { isElectron } from "../../env";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";
import { type EnvironmentStandup, standupGenerate, useStandupStore } from "../../state/standup";
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
import {
  deriveStandupEntries,
  type StandupEntry,
  standupEntriesKey,
  startOfLocalDay,
  toStandupThreads,
} from "./standup.logic";

const BUCKETS: ReadonlyArray<{ readonly bucket: StandupBucket; readonly title: string }> = [
  { bucket: "closed", title: "Closed" },
  { bucket: "halted", title: "Halted" },
  { bucket: "started", title: "Started" },
];

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * Today's threads, live from the sidebar shells, plus one written summary per
 * environment. Summaries are written once a day on open; after that the lists
 * keep moving and Refresh reconciles the summary with them.
 */
export function StandupPage() {
  const threads = useThreadShells();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const standups = useStandupStore((state) => state.byEnvironment);
  const updateStandup = useStandupStore((state) => state.update);
  const generateCommand = useAtomCommand(standupGenerate, { reportFailure: false });

  const dayStart = startOfLocalDay(new Date());
  const entries = useMemo(() => deriveStandupEntries(threads, dayStart), [threads, dayStart]);
  const entriesByEnvironment = useMemo(() => {
    const grouped = new Map<EnvironmentId, StandupEntry[]>();
    for (const entry of entries) {
      const group = grouped.get(entry.thread.environmentId) ?? [];
      group.push(entry);
      grouped.set(entry.thread.environmentId, group);
    }
    return grouped;
  }, [entries]);
  const projectTitles = useMemo(
    () =>
      new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project.title])),
    [projects],
  );
  const multipleEnvironments = entriesByEnvironment.size > 1;
  const environmentLabel = (environmentId: EnvironmentId) =>
    presentations.get(environmentId)?.entry.target.label ?? environmentId;
  const supportsSummary = (environmentId: EnvironmentId) =>
    serverConfigs.get(environmentId)?.environment.capabilities.standupSummary === true;

  const generate = async (environmentId: EnvironmentId, group: ReadonlyArray<StandupEntry>) => {
    const key = standupEntriesKey(group);
    const previous = useStandupStore.getState().byEnvironment[environmentId];
    const summary = previous?.dayStart === dayStart ? previous.summary : null;
    updateStandup(environmentId, { dayStart, key, status: "generating", summary, error: null });
    const result = await generateCommand({
      environmentId,
      input: { threads: toStandupThreads(group) },
    });
    // A newer request owns the entry now.
    const latest = useStandupStore.getState().byEnvironment[environmentId];
    if (latest?.key !== key || latest.dayStart !== dayStart) return;
    if (result._tag === "Success") {
      updateStandup(environmentId, {
        dayStart,
        key,
        status: "ready",
        summary: result.value,
        error: null,
      });
      return;
    }
    const error = squashAtomCommandFailure(result);
    updateStandup(environmentId, {
      ...latest,
      status: "failed",
      error: error instanceof Error ? error.message : "Failed to write the standup.",
    });
  };

  const refreshable = useMemo(
    () =>
      [...entriesByEnvironment].filter(
        ([environmentId]) =>
          serverConfigs.get(environmentId)?.environment.capabilities.standupSummary === true,
      ),
    [entriesByEnvironment, serverConfigs],
  );
  const refreshing = refreshable.some(
    ([environmentId]) => standups[environmentId]?.status === "generating",
  );
  const refresh = () => {
    for (const [environmentId, group] of refreshable) void generate(environmentId, group);
  };

  // Write each environment's first summary of the day on open; later changes wait for Refresh.
  const generateMissing = useEffectEvent((groups: typeof refreshable) => {
    for (const [environmentId, group] of groups) {
      const standup = useStandupStore.getState().byEnvironment[environmentId];
      if (standup?.dayStart !== dayStart) void generate(environmentId, group);
    }
  });
  useEffect(() => generateMissing(refreshable), [refreshable]);

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
            <span className="truncate text-xs text-muted-foreground">
              {new Date(dayStart).toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
            </span>
            <div className="ms-auto">
              <Button
                onClick={refresh}
                aria-label="Refresh standup"
                aria-busy={refreshing}
                disabled={refreshing || refreshable.length === 0}
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
            {entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing started, closed, or halted today.
              </p>
            ) : (
              <div className="flex flex-col gap-8">
                {[...entriesByEnvironment.keys()].map((environmentId) => (
                  <StandupSummarySection
                    key={environmentId}
                    environmentId={environmentId}
                    label={multipleEnvironments ? environmentLabel(environmentId) : null}
                    supported={supportsSummary(environmentId)}
                    standup={standups[environmentId]}
                    currentKey={standupEntriesKey(entriesByEnvironment.get(environmentId) ?? [])}
                    dayStart={dayStart}
                  />
                ))}
                {BUCKETS.map(({ bucket, title }) => {
                  const rows = entries.filter((entry) => entry.buckets.includes(bucket));
                  if (rows.length === 0) return null;
                  return (
                    <section key={bucket} className="flex flex-col gap-2">
                      <h2 className="text-sm font-medium">
                        {title} <span className="text-muted-foreground">{rows.length}</span>
                      </h2>
                      <ul className="flex flex-col">
                        {rows.map(({ thread, note }) => (
                          <li key={`${thread.environmentId}:${thread.id}`}>
                            <Link
                              to="/$environmentId/$threadId"
                              params={buildThreadRouteParams(
                                scopeThreadRef(thread.environmentId, thread.id),
                              )}
                              className="flex min-w-0 items-baseline gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                            >
                              <span className="truncate">{thread.title}</span>
                              <span className="shrink-0 truncate text-xs text-muted-foreground">
                                {[
                                  projectTitles.get(`${thread.environmentId}:${thread.projectId}`),
                                  multipleEnvironments
                                    ? environmentLabel(thread.environmentId)
                                    : null,
                                  bucket === "halted" ? note : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function StandupSummarySection({
  environmentId,
  label,
  supported,
  standup,
  currentKey,
  dayStart,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
  readonly supported: boolean;
  readonly standup: EnvironmentStandup | undefined;
  readonly currentKey: string;
  readonly dayStart: number;
}) {
  const today = standup?.dayStart === dayStart ? standup : undefined;
  const summary = today?.summary ?? null;
  return (
    <section className="flex flex-col gap-2">
      {label ? <h2 className="text-sm font-medium">{label}</h2> : null}
      {!supported ? (
        <p className="text-sm text-muted-foreground">
          Update this environment's server to get a written summary.
        </p>
      ) : summary === null && today?.status !== "failed" ? (
        <div className="flex flex-col gap-2" aria-label="Writing standup">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : (
        <>
          {summary ? (
            <ChatMarkdown text={summary.summary} cwd={undefined} environmentId={environmentId} />
          ) : null}
          <p className="text-xs text-muted-foreground">
            {[
              summary ? `Written at ${timeLabel(summary.generatedAt)}` : null,
              today?.status === "generating" ? "Updating…" : null,
              today?.status === "ready" && today.key !== currentKey
                ? "Threads changed since. Refresh to update."
                : null,
              today?.status === "failed" ? `Could not write the summary: ${today.error}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </>
      )}
    </section>
  );
}

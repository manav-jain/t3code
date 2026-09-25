import {
  type StandupDay,
  type StandupDayInput,
  type StandupDayThread,
  StandupError,
  type StandupStatus,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const NOTE_MAX = 300;

/** One thread with the facts its standup status is decided from. */
export interface StandupDayRow {
  readonly threadId: string;
  readonly title: string;
  readonly projectTitle: string | null;
  readonly branch: string | null;
  readonly createdAt: string;
  readonly settledOverride: string | null;
  readonly settledAt: string | null;
  readonly pendingApprovals: number;
  readonly pendingUserInput: number;
  readonly sessionStatus: string | null;
  readonly sessionError: string | null;
  /** State and request time of the thread's last turn requested inside the window. */
  readonly dayTurnState: string | null;
  readonly dayTurnAt: string | null;
}

export interface StandupPullRequest {
  readonly repository: string;
  readonly number: number;
  readonly title: string | null;
  readonly state: string | null;
  readonly mergedAt: string | null;
}

export interface StandupDayEntry extends StandupDayThread {
  readonly branch: string | null;
  readonly pullRequests: ReadonlyArray<StandupPullRequest>;
  /** Latest activity inside the window, for ordering. */
  readonly at: string;
}

const inWindow = (iso: string | null, input: StandupDayInput) =>
  iso !== null && iso >= input.from && iso < input.to;

/**
 * Decides whether a thread belongs to the window and where it stood: done when
 * settled or a linked PR merged in the window; blocked when its turn failed, or,
 * for the current day, when it waits on the user; in progress otherwise. Threads
 * still waiting on the user count today whenever they started waiting.
 */
export function classifyStandupThread(
  row: StandupDayRow,
  pullRequests: ReadonlyArray<StandupPullRequest>,
  input: StandupDayInput,
  now: string,
): { readonly status: StandupStatus; readonly note: string | null; readonly at: string } | null {
  const isCurrentDay = inWindow(now, input);
  const settled = row.settledOverride === "settled";
  const settledAt = settled && inWindow(row.settledAt, input) ? row.settledAt : null;
  const mergedAt =
    pullRequests
      .filter(
        (pullRequest) => pullRequest.state === "merged" && inWindow(pullRequest.mergedAt, input),
      )
      .map((pullRequest) => pullRequest.mergedAt!)
      .toSorted()
      .at(-1) ?? null;
  const waitingOnUser =
    isCurrentDay && !settled && (row.pendingApprovals > 0 || row.pendingUserInput > 0);
  const activity = [
    inWindow(row.createdAt, input) ? row.createdAt : null,
    settledAt,
    mergedAt,
    inWindow(row.dayTurnAt, input) ? row.dayTurnAt : null,
  ]
    .filter((at) => at !== null)
    .toSorted();
  const at = activity.at(-1) ?? (waitingOnUser ? input.from : null);
  if (at === null) return null;

  const blocked = settled
    ? null
    : isCurrentDay && row.pendingApprovals > 0
      ? "waiting for approval"
      : isCurrentDay && row.pendingUserInput > 0
        ? "waiting for an answer"
        : row.dayTurnState === "error"
          ? "turn failed"
          : isCurrentDay && row.sessionStatus === "error"
            ? row.sessionError?.trim()
              ? `session error: ${row.sessionError.trim().slice(0, NOTE_MAX)}`
              : "session error"
            : null;
  const status: StandupStatus =
    settledAt !== null || mergedAt !== null ? "done" : blocked !== null ? "blocked" : "in-progress";
  const signals = [
    inWindow(row.createdAt, input) ? "new" : null,
    mergedAt !== null ? "pull request merged" : null,
    settledAt !== null ? "settled" : null,
    status === "blocked" ? blocked : null,
    status === "in-progress" && isCurrentDay && row.dayTurnState === "running"
      ? "running now"
      : null,
    status === "in-progress" && row.dayTurnState === "interrupted"
      ? "stopped before finishing"
      : null,
  ].filter((signal) => signal !== null);
  return { status, note: signals.length > 0 ? signals.join(" · ") : null, at };
}

export function standupDayKey(
  threads: ReadonlyArray<Pick<StandupDayThread, "threadId" | "status">>,
) {
  return threads
    .map((thread) => `${thread.threadId}:${thread.status}`)
    .toSorted()
    .join("|");
}

const failure = (detail: string) => (cause: unknown) => new StandupError({ detail, cause });

function parseSnapshot(json: string | null) {
  if (!json) return null;
  try {
    return JSON.parse(json) as { title?: string; state?: string; mergedAt?: string | null };
  } catch {
    return null;
  }
}

/** The window's threads, most recently active first. */
export const selectStandupDay = Effect.fn("selectStandupDay")(
  function* (input: StandupDayInput, now: string) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<StandupDayRow>`
      SELECT t.thread_id AS "threadId", t.title, p.title AS "projectTitle", t.branch,
        t.created_at AS "createdAt", t.settled_override AS "settledOverride",
        t.settled_at AS "settledAt", t.pending_approval_count AS "pendingApprovals",
        t.pending_user_input_count AS "pendingUserInput", s.status AS "sessionStatus",
        s.last_error AS "sessionError", turn.state AS "dayTurnState",
        turn.requested_at AS "dayTurnAt"
      FROM projection_threads AS t
      LEFT JOIN projection_projects AS p ON p.project_id = t.project_id
      LEFT JOIN projection_thread_sessions AS s ON s.thread_id = t.thread_id
      LEFT JOIN projection_turns AS turn ON turn.row_id = (
        SELECT u.row_id FROM projection_turns AS u
        WHERE u.thread_id = t.thread_id
          AND u.requested_at >= ${input.from} AND u.requested_at < ${input.to}
        ORDER BY u.requested_at DESC LIMIT 1
      )
      WHERE t.deleted_at IS NULL
    `;
    const pullRequestRows = yield* sql<{
      threadId: string;
      repository: string;
      number: number;
      snapshotJson: string | null;
    }>`
      SELECT thread_id AS "threadId", repository, number, snapshot_json AS "snapshotJson"
      FROM projection_thread_pull_requests
      WHERE source != 'stack-dismissed'
    `;
    const pullRequestsByThread = new Map<string, StandupPullRequest[]>();
    for (const row of pullRequestRows) {
      const snapshot = parseSnapshot(row.snapshotJson);
      const list = pullRequestsByThread.get(row.threadId) ?? [];
      list.push({
        repository: row.repository,
        number: row.number,
        title: snapshot?.title ?? null,
        state: snapshot?.state ?? null,
        mergedAt: snapshot?.mergedAt ?? null,
      });
      pullRequestsByThread.set(row.threadId, list);
    }

    const entries: StandupDayEntry[] = [];
    for (const row of rows) {
      const pullRequests = pullRequestsByThread.get(row.threadId) ?? [];
      const classified = classifyStandupThread(row, pullRequests, input, now);
      if (classified === null) continue;
      entries.push({
        threadId: ThreadId.make(row.threadId),
        title: row.title,
        projectTitle: row.projectTitle,
        branch: row.branch,
        pullRequests,
        ...classified,
      });
    }
    return entries.toSorted((left, right) => right.at.localeCompare(left.at));
  },
  Effect.mapError(failure("Could not read this day's threads.")),
);

export const getStandupDay = (input: StandupDayInput, now: string) =>
  selectStandupDay(input, now).pipe(
    Effect.map((entries): StandupDay => {
      const threads = entries.map(({ threadId, title, projectTitle, status, note }) => ({
        threadId,
        title,
        projectTitle,
        status,
        note,
      }));
      return { threads, key: standupDayKey(threads) };
    }),
  );

/**
 * What the summary reads of one thread: its opening request for orientation,
 * everything said inside the window, and the latest reply before the window
 * ended, so a thread only settled that day still says what it achieved.
 */
export const readStandupThreadMessages = Effect.fn("readStandupThreadMessages")(
  function* (threadId: string, input: StandupDayInput) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ role: "user" | "assistant" | "system" | "reasoning"; text: string }>`
      SELECT role, text FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND (
        (created_at >= ${input.from} AND created_at < ${input.to})
        OR message_id = (
          SELECT message_id FROM projection_thread_messages
          WHERE thread_id = ${threadId} AND role = 'user'
          ORDER BY created_at LIMIT 1
        )
        OR message_id = (
          SELECT message_id FROM projection_thread_messages
          WHERE thread_id = ${threadId} AND role = 'assistant' AND created_at < ${input.to}
          ORDER BY created_at DESC LIMIT 1
        )
      )
      ORDER BY created_at
    `;
  },
  Effect.mapError(failure("Could not read thread history.")),
);

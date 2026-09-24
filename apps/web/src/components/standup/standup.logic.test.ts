import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarThreadSummary } from "../../types";
import { deriveStandupEntries, standupEntriesKey } from "./standup.logic";

const dayStart = Date.parse("2026-09-24T00:00:00.000Z");
const yesterday = "2026-09-23T15:00:00.000Z";
const morning = "2026-09-24T09:00:00.000Z";
const noon = "2026-09-24T12:00:00.000Z";

const thread = (id: string, overrides: Record<string, unknown> = {}) =>
  ({
    id: ThreadId.make(id),
    environmentId: "local",
    title: id,
    createdAt: yesterday,
    updatedAt: yesterday,
    latestTurn: null,
    session: null,
    settledOverride: null,
    settledAt: null,
    pullRequests: [],
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  }) as unknown as SidebarThreadSummary;

const turn = (state: string, completedAt: string | null) => ({
  turnId: "turn",
  state,
  requestedAt: completedAt ?? morning,
  startedAt: completedAt ?? morning,
  completedAt,
  assistantMessageId: null,
});

const bucketsById = (threads: SidebarThreadSummary[]) =>
  Object.fromEntries(
    deriveStandupEntries(threads, dayStart).map((entry) => [
      entry.thread.id,
      { buckets: entry.buckets, note: entry.note },
    ]),
  );

describe("deriveStandupEntries", () => {
  it("sorts threads into today's started, closed, and halted buckets", () => {
    expect(
      bucketsById([
        thread("new-and-running", { createdAt: morning, latestTurn: turn("running", null) }),
        thread("settled-today", { settledOverride: "settled", settledAt: noon }),
        thread("merged-today", {
          pullRequests: [{ snapshot: { state: "merged", mergedAt: morning } }],
        }),
        thread("stopped-today", { latestTurn: turn("interrupted", noon) }),
        thread("needs-approval", {
          hasPendingApprovals: true,
          latestTurn: turn("running", null),
        }),
        thread("new-and-failed", { createdAt: morning, latestTurn: turn("error", noon) }),
      ]),
    ).toEqual({
      "new-and-running": { buckets: ["started"], note: undefined },
      "settled-today": { buckets: ["closed"], note: undefined },
      "merged-today": { buckets: ["closed"], note: undefined },
      "stopped-today": { buckets: ["halted"], note: "stopped before finishing" },
      "needs-approval": { buckets: ["halted"], note: "waiting for approval" },
      "new-and-failed": { buckets: ["started", "halted"], note: "turn failed" },
    });
  });

  it("leaves out yesterday's work and settled threads that stopped", () => {
    expect(
      bucketsById([
        thread("settled-yesterday", { settledOverride: "settled", settledAt: yesterday }),
        thread("stopped-yesterday", { latestTurn: turn("interrupted", yesterday) }),
        thread("merged-yesterday", {
          pullRequests: [{ snapshot: { state: "merged", mergedAt: yesterday } }],
        }),
        thread("stopped-then-settled", {
          settledOverride: "settled",
          settledAt: yesterday,
          latestTurn: turn("interrupted", noon),
        }),
      ]),
    ).toEqual({});
  });

  it("orders by latest activity and keys summaries independent of order", () => {
    const threads = [
      thread("earlier", { createdAt: morning }),
      thread("later", { createdAt: noon }),
    ];
    const entries = deriveStandupEntries(threads, dayStart);
    expect(entries.map((entry) => entry.thread.id)).toEqual(["later", "earlier"]);
    expect(standupEntriesKey(entries)).toBe(standupEntriesKey(entries.toReversed()));
    expect(standupEntriesKey(entries)).not.toBe(standupEntriesKey(entries.slice(1)));
  });
});

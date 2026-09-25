import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId } from "@t3tools/contracts";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  classifyStandupThread,
  getStandupDay,
  type StandupDayRow,
  type StandupPullRequest,
} from "./StandupDay.ts";
import { generateStandupSummary } from "./StandupSummary.ts";

const yesterday = { from: "2026-09-23T18:30:00.000Z", to: "2026-09-24T18:30:00.000Z" };
const noonYesterday = "2026-09-24T06:30:00.000Z";
const nowToday = "2026-09-25T05:00:00.000Z";
const today = { from: "2026-09-24T18:30:00.000Z", to: "2026-09-25T18:30:00.000Z" };

const row = (overrides: Partial<StandupDayRow> = {}): StandupDayRow => ({
  threadId: "thread",
  title: "Thread",
  projectTitle: null,
  branch: null,
  createdAt: "2026-09-10T10:00:00.000Z",
  settledOverride: null,
  settledAt: null,
  pendingApprovals: 0,
  pendingUserInput: 0,
  sessionStatus: null,
  sessionError: null,
  dayTurnState: null,
  dayTurnAt: null,
  ...overrides,
});

const classify = (
  overrides: Partial<StandupDayRow>,
  window = yesterday,
  pullRequests: ReadonlyArray<StandupPullRequest> = [],
) => {
  const result = classifyStandupThread(row(overrides), pullRequests, window, nowToday);
  return result && { status: result.status, note: result.note };
};

describe("classifyStandupThread", () => {
  it("statuses a day's threads from what happened in that day", () => {
    assert.deepStrictEqual(classify({ dayTurnState: "completed", dayTurnAt: noonYesterday }), {
      status: "in-progress",
      note: null,
    });
    assert.deepStrictEqual(
      classify({ createdAt: noonYesterday, dayTurnState: "interrupted", dayTurnAt: noonYesterday }),
      { status: "in-progress", note: "new · stopped before finishing" },
    );
    assert.deepStrictEqual(classify({ settledOverride: "settled", settledAt: noonYesterday }), {
      status: "done",
      note: "settled",
    });
    assert.deepStrictEqual(
      classify({}, yesterday, [
        {
          repository: "acme/web",
          number: 1,
          title: "Fix",
          state: "merged",
          mergedAt: noonYesterday,
        },
      ]),
      { status: "done", note: "pull request merged" },
    );
    assert.deepStrictEqual(classify({ dayTurnState: "error", dayTurnAt: noonYesterday }), {
      status: "blocked",
      note: "turn failed",
    });
  });

  it("leaves out other days' work and only blocks on the user for the current day", () => {
    assert.strictEqual(
      classify({ settledOverride: "settled", settledAt: "2026-09-20T10:00:00.000Z" }),
      null,
    );
    // Waiting on approval is a blocker today whenever it began, but says nothing about yesterday.
    assert.strictEqual(classify({ pendingApprovals: 1 }), null);
    assert.deepStrictEqual(classify({ pendingApprovals: 1 }, today), {
      status: "blocked",
      note: "waiting for approval",
    });
  });
});

const layer = (textGeneration: Partial<TextGeneration.TextGeneration["Service"]>) =>
  Layer.mergeAll(
    Layer.mock(TextGeneration.TextGeneration)(textGeneration),
    ServerSettings.layerTest(),
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.effect("reads a past day's threads and history from the projections", () => {
  const requests: TextGeneration.StandupSummaryGenerationInput[] = [];
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project-web', 'Web', '/repo', '[]', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`;
    for (const [id, title] of [
      ["thread-login", "Fix login redirect"],
      ["thread-idle", "Old idea"],
    ] as const) {
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, branch, created_at, updated_at)
        VALUES (${id}, 'project-web', ${title}, 'fix/login', '2026-09-20T10:00:00.000Z', ${nowToday})`;
    }
    // The login thread started days ago and was continued yesterday; the idle one was not.
    yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_files_json)
      VALUES ('thread-login', 'turn-old', 'completed', '2026-09-20T10:00:00.000Z', '[]'),
             ('thread-login', 'turn-day', 'interrupted', ${noonYesterday}, '[]'),
             ('thread-idle', 'turn-idle', 'completed', '2026-09-20T11:00:00.000Z', '[]')`;
    const message = (id: string, role: string, text: string, at: string) =>
      sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${id}, 'thread-login', ${role}, ${text}, 0, ${at}, ${at})`;
    yield* message("m1", "user", "Login loops after SSO.", "2026-09-20T10:00:00.000Z");
    yield* message("m2", "assistant", "Old detour through cookies.", "2026-09-20T10:05:00.000Z");
    yield* message("m3", "user", "Try the callback instead.", noonYesterday);
    yield* message("m4", "assistant", "The callback drops the return path.", noonYesterday);
    yield* message("m5", "user", "Something for today.", nowToday);

    const day = yield* getStandupDay(yesterday, nowToday);
    assert.deepStrictEqual(day.threads, [
      {
        threadId: ThreadId.make("thread-login"),
        title: "Fix login redirect",
        projectTitle: "Web",
        status: "in-progress",
        note: "stopped before finishing",
      },
    ]);

    const summary = yield* generateStandupSummary(yesterday);
    assert.strictEqual(summary.summary, "## In progress\n- **Login**");
    assert.strictEqual(summary.key, day.key);
    assert.strictEqual(requests[0]!.threads.length, 1);
    const [thread] = requests[0]!.threads;
    assert.strictEqual(thread!.branch, "fix/login");
    // The opening request orients the model; the rest is only what happened that day.
    assert.include(thread!.context, "Login loops after SSO.");
    assert.include(thread!.context, "The callback drops the return path.");
    assert.notInclude(thread!.context, "Old detour through cookies.");
    assert.notInclude(thread!.context, "Something for today.");
  }).pipe(
    Effect.provide(
      layer({
        generateStandupSummary: (input) => {
          requests.push(input);
          return Effect.succeed({ summary: " ## In progress\n- **Login** " });
        },
      }),
    ),
  );
});

it.effect("fails instead of summarizing a day without thread work", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(generateStandupSummary(yesterday));
    assert.include(error.message, "No thread work on this day.");
  }).pipe(Effect.provide(layer({}))),
);

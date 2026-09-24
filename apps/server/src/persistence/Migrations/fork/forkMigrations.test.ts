import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "../../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("fork migrations", (it) => {
  it.effect("apply in their own ledger and leave upstream's ledger at its last id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* runMigrations();

      const [upstream] = yield* sql<{ readonly id: number }>`
        SELECT MAX(migration_id) AS id FROM effect_sql_migrations
      `;
      assert.strictEqual(upstream?.id, migrationManifest.at(-1)?.[0]);
      const fork = yield* sql<{ readonly id: number }>`
        SELECT migration_id AS id FROM fork_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        fork.map((row) => row.id),
        [1, 2],
      );
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "slack_threads_json"));
      assert.ok(columns.some((column) => column.name === "group_name"));
    }),
  );
});

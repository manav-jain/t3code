import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A handful of links per thread, always read with the thread row, so a JSON column
  // instead of a table like projection_thread_pull_requests.
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN slack_threads_json TEXT NOT NULL DEFAULT '[]'
  `;
});

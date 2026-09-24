import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerSettingsService } from "../serverSettings.ts";
import { make } from "./SlackThreads.ts";

const KEY = { channelId: "C0123ABC", threadTs: "1712345678.123456" };

function fixture(token: string, replies: unknown) {
  const calls: string[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      calls.push(url.pathname);
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      const body = url.pathname.endsWith("/users.info")
        ? { ok: true, user: { name: "ada", profile: { display_name: "Ada" } } }
        : replies;
      return HttpClientResponse.fromWeb(request, Response.json(body));
    }),
  );
  const slack = make.pipe(
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provide(ServerSettingsService.layerTest({ slack: { token } })),
  );
  return { calls, slack };
}

describe("SlackThreads", () => {
  it.effect("maps replies and caches user names across reads", () =>
    Effect.gen(function* () {
      const { calls, slack } = fixture("xoxp-test", {
        ok: true,
        has_more: false,
        messages: [
          { ts: "1712345678.123456", user: "U1", text: "Deploy &lt;today&gt; &amp; tomorrow?" },
          { ts: "1712345679.000001", username: "deploy-bot", text: "Done" },
          { ts: "1712345680.000001", user: "U1" },
        ],
      });
      const service = yield* slack;
      const result = yield* service.read(KEY);
      expect(result).toEqual({
        truncated: false,
        messages: [
          {
            ts: "1712345678.123456",
            userId: "U1",
            userName: "Ada",
            text: "Deploy <today> & tomorrow?",
          },
          { ts: "1712345679.000001", userId: null, userName: "deploy-bot", text: "Done" },
          { ts: "1712345680.000001", userId: "U1", userName: "Ada", text: "" },
        ],
      });
      yield* service.read(KEY);
      expect(calls.filter((path) => path.endsWith("/users.info"))).toHaveLength(1);
    }),
  );

  it.effect("surfaces Slack's error code", () =>
    Effect.gen(function* () {
      const service = yield* fixture("xoxp-test", { ok: false, error: "not_in_channel" }).slack;
      const error = yield* service.read(KEY).pipe(Effect.flip);
      expect(error.code).toBe("not_in_channel");
      expect(error.message).toBe("The Slack token cannot see this channel.");
    }),
  );

  it.effect("fails without calling Slack when no token is configured", () =>
    Effect.gen(function* () {
      const { calls, slack } = fixture("", { ok: true, messages: [] });
      const error = yield* (yield* slack).read(KEY).pipe(Effect.flip);
      expect(error.code).toBe("not_configured");
      expect(calls).toEqual([]);
    }),
  );
});

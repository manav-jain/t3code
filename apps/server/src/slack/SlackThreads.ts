import {
  type SlackThreadReadResult,
  SlackThreadReadError,
  type ThreadSlackThreadKey,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { ServerSettingsService } from "../serverSettings.ts";

/** Reads a linked Slack thread with the environment's Slack token. Nothing is persisted. */
export class SlackThreads extends Context.Service<
  SlackThreads,
  {
    readonly read: (
      key: ThreadSlackThreadKey,
    ) => Effect.Effect<SlackThreadReadResult, SlackThreadReadError>;
  }
>()("t3/slack/SlackThreads") {}

// ponytail: one page of conversations.replies; paginate if 200-message threads turn out common.
const MESSAGE_LIMIT = 200;

const SlackFailure = Schema.Struct({ ok: Schema.Literal(false), error: Schema.String });
const Replies = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      ts: Schema.String,
      user: Schema.optional(Schema.String),
      username: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
    }),
  ),
  has_more: Schema.optional(Schema.Boolean),
});
const UserInfo = Schema.Struct({
  user: Schema.Struct({
    name: Schema.String,
    real_name: Schema.optional(Schema.String),
    profile: Schema.optional(Schema.Struct({ display_name: Schema.optional(Schema.String) })),
  }),
});
const decodeFailure = Schema.decodeUnknownOption(SlackFailure);
const decodeReplies = Schema.decodeUnknownEffect(Replies);
const decodeUserInfo = Schema.decodeUnknownEffect(UserInfo);

const requestFailed = () => new SlackThreadReadError({ code: "request_failed" });

/** Slack escapes these three in message text. */
const unescape = (text: string) =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const settings = yield* ServerSettingsService;
  // ponytail: per-process and never evicted; a workspace's user list is small and names rarely change.
  const userNames = new Map<string, string>();

  /** Slack answers errors with `ok: false` and a code, on 200 as well as 429. */
  const call = Effect.fnUntraced(function* (
    token: string,
    method: string,
    urlParams: Record<string, string>,
  ) {
    const body = yield* client
      .execute(
        HttpClientRequest.get(`https://slack.com/api/${method}`, { urlParams }).pipe(
          HttpClientRequest.bearerToken(token),
        ),
      )
      .pipe(
        Effect.flatMap((response) => response.json),
        Effect.timeout("15 seconds"),
        Effect.mapError(requestFailed),
      );
    const failure = decodeFailure(body);
    if (Option.isSome(failure)) {
      return yield* new SlackThreadReadError({ code: failure.value.error });
    }
    return body;
  });

  const userName = Effect.fnUntraced(function* (token: string, userId: string) {
    const cached = userNames.get(userId);
    if (cached !== undefined) return cached;
    const info = yield* call(token, "users.info", { user: userId }).pipe(
      Effect.flatMap((body) => decodeUserInfo(body).pipe(Effect.mapError(requestFailed))),
      Effect.option,
    );
    // Without users:read the thread still reads, with ids for names.
    if (Option.isNone(info)) return userId;
    const { user } = info.value;
    const name = user.profile?.display_name || user.real_name || user.name;
    userNames.set(userId, name);
    return name;
  });

  const read = Effect.fn("SlackThreads.read")(function* (key: ThreadSlackThreadKey) {
    const token = yield* settings.getSettings.pipe(
      Effect.map((current) => current.slack.token),
      Effect.orElseSucceed(() => ""),
    );
    if (token.length === 0) {
      return yield* new SlackThreadReadError({ code: "not_configured" });
    }
    const replies = yield* call(token, "conversations.replies", {
      channel: key.channelId,
      ts: key.threadTs,
      limit: String(MESSAGE_LIMIT),
    }).pipe(Effect.flatMap((body) => decodeReplies(body).pipe(Effect.mapError(requestFailed))));
    const messages = replies.messages.slice(0, MESSAGE_LIMIT);
    const names = new Map(
      yield* Effect.forEach(
        new Set(messages.flatMap((message) => message.user ?? [])),
        (userId) => userName(token, userId).pipe(Effect.map((name) => [userId, name] as const)),
        { concurrency: 4 },
      ),
    );
    return {
      messages: messages.map((message) => ({
        ts: message.ts,
        userId: message.user ?? null,
        userName: names.get(message.user ?? "") ?? message.username ?? "Slack",
        text: unescape(message.text ?? ""),
      })),
      truncated: replies.has_more === true || replies.messages.length > MESSAGE_LIMIT,
    } satisfies SlackThreadReadResult;
  });

  return SlackThreads.of({ read });
});

export const layer = Layer.effect(SlackThreads, make);

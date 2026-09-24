import * as Schema from "effect/Schema";

export const SlackThreadMessage = Schema.Struct({
  ts: Schema.String,
  /** Null for bot and integration posts, which have no Slack user. */
  userId: Schema.NullOr(Schema.String),
  userName: Schema.String,
  text: Schema.String,
});
export type SlackThreadMessage = typeof SlackThreadMessage.Type;

export const SlackThreadReadResult = Schema.Struct({
  messages: Schema.Array(SlackThreadMessage),
  /** The thread has more messages than one read returns. */
  truncated: Schema.Boolean,
});
export type SlackThreadReadResult = typeof SlackThreadReadResult.Type;

const SLACK_ERROR_MESSAGES: Record<string, string> = {
  not_configured: "Add a Slack token in Settings → Integrations to read Slack threads.",
  request_failed: "Slack could not be reached.",
  not_in_channel: "The Slack token cannot see this channel.",
  channel_not_found: "The Slack token cannot see this channel.",
  thread_not_found: "This Slack thread no longer exists.",
  not_authed: "The Slack token is invalid or revoked.",
  invalid_auth: "The Slack token is invalid or revoked.",
  token_revoked: "The Slack token is invalid or revoked.",
  account_inactive: "The Slack token is invalid or revoked.",
  missing_scope: "The Slack token is missing a history scope for this conversation.",
  ratelimited: "Slack is rate limiting requests. Try again shortly.",
};

/** `code` is Slack's own error code, or `not_configured` / `request_failed`. */
export class SlackThreadReadError extends Schema.TaggedError<SlackThreadReadError>()(
  "SlackThreadReadError",
  { code: Schema.String },
) {
  override get message(): string {
    return SLACK_ERROR_MESSAGES[this.code] ?? `Slack returned ${this.code}.`;
  }
}

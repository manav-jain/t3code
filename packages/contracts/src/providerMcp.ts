/**
 * MCP servers a provider instance connects to on its own, as configured in
 * that instance's home (user scope). The environment runs the provider's CLI
 * with the instance's environment, so config and tokens stay where the provider
 * keeps them. T3 Code's own per-session `t3-code` server never appears here.
 *
 * @module providerMcp
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * `configured` means the provider reports no live health for the server
 * (Codex lists config and sign-in state without connecting).
 */
export const ProviderMcpServerStatus = Schema.Literals([
  "connected",
  "needs-auth",
  "failed",
  "pending",
  "disabled",
  "configured",
]);
export type ProviderMcpServerStatus = typeof ProviderMcpServerStatus.Type;

export const ProviderMcpServer = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** Where the definition lives, for example "user" or "claudeai". */
  scope: Schema.NullOr(Schema.String),
  transport: Schema.Literals(["stdio", "http", "sse", "connector", "other"]),
  /** Command line or URL. */
  target: Schema.String,
  status: ProviderMcpServerStatus,
  /** Error or disabled reason. */
  detail: Schema.NullOr(Schema.String),
  /** Supports OAuth sign-in (remote servers and connectors). */
  canSignIn: Schema.Boolean,
  /** Holds OAuth credentials that sign-out would clear. */
  signedIn: Schema.Boolean,
  canRemove: Schema.Boolean,
});
export type ProviderMcpServer = typeof ProviderMcpServer.Type;

export const ProviderMcpListInput = Schema.Struct({ instanceId: ProviderInstanceId });
export type ProviderMcpListInput = typeof ProviderMcpListInput.Type;

export const ProviderMcpListResult = Schema.Struct({
  servers: Schema.Array(ProviderMcpServer),
});
export type ProviderMcpListResult = typeof ProviderMcpListResult.Type;

/** Names new servers may take; they are passed to provider CLIs as arguments. */
export const ProviderMcpServerName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u),
);

export const ProviderMcpServerDefinition = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("stdio"),
    command: TrimmedNonEmptyString,
    args: Schema.Array(Schema.String),
    env: Schema.Record(Schema.String, Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("http"),
    url: TrimmedNonEmptyString.check(Schema.isPattern(/^https?:\/\/\S+$/u)),
  }),
]);
export type ProviderMcpServerDefinition = typeof ProviderMcpServerDefinition.Type;

export const ProviderMcpUpdateInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("add"),
    instanceId: ProviderInstanceId,
    name: ProviderMcpServerName,
    server: ProviderMcpServerDefinition,
  }),
  Schema.Struct({
    type: Schema.Literals(["remove", "sign-out"]),
    instanceId: ProviderInstanceId,
    name: TrimmedNonEmptyString,
  }),
]);
export type ProviderMcpUpdateInput = typeof ProviderMcpUpdateInput.Type;

export const ProviderMcpSignInInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  name: TrimmedNonEmptyString,
});
export type ProviderMcpSignInInput = typeof ProviderMcpSignInInput.Type;

export const ProviderMcpSignInStarted = Schema.Struct({
  /** Opened in the user's browser, wherever the client runs. */
  authorizationUrl: TrimmedNonEmptyString,
});
export type ProviderMcpSignInStarted = typeof ProviderMcpSignInStarted.Type;

/**
 * Waits for a started sign-in to finish. When the browser cannot reach the
 * environment's localhost callback (a remote environment), the client passes
 * the redirect URL the user copied from the failed page.
 */
export const ProviderMcpFinishSignInInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  name: TrimmedNonEmptyString,
  callbackUrl: Schema.NullOr(TrimmedNonEmptyString),
  cancel: Schema.Boolean,
});
export type ProviderMcpFinishSignInInput = typeof ProviderMcpFinishSignInInput.Type;

export class ProviderMcpError extends Schema.TaggedError<ProviderMcpError>()("ProviderMcpError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

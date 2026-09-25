import type {
  ProviderMcpServer,
  ProviderMcpServerDefinition,
  ProviderMcpServerStatus,
} from "@t3tools/contracts";

/** Drivers whose CLIs manage MCP servers: list, add, remove, login, logout. */
export type McpDriver = "claudeAgent" | "codex";

export const isMcpDriver = (driver: string): driver is McpDriver =>
  driver === "claudeAgent" || driver === "codex";

/** T3 Code injects its own server into every session; it is not the user's to manage. */
const T3_CODE_SERVER = "t3-code";

/** The subset of the Claude Agent SDK's `McpServerStatus` this module reads. */
export interface ClaudeMcpStatus {
  readonly name: string;
  readonly status: string;
  readonly error?: string | undefined;
  readonly scope?: string | undefined;
  readonly source?: string | undefined;
  readonly config?:
    | {
        readonly type?: string | undefined;
        readonly url?: string | undefined;
        readonly command?: string | undefined;
        readonly args?: ReadonlyArray<string> | undefined;
      }
    | undefined;
}

const CLAUDE_STATUSES: Record<string, ProviderMcpServerStatus> = {
  connected: "connected",
  "needs-auth": "needs-auth",
  failed: "failed",
  pending: "pending",
  disabled: "disabled",
};

const commandLine = (command: string | undefined, args: ReadonlyArray<string> | undefined) =>
  [command, ...(args ?? [])].filter(Boolean).join(" ");

/**
 * Claude reports servers from every source; only user-scope ones are the
 * instance's own to remove, since project and local scopes belong to a checkout
 * and claude.ai connectors to the account.
 */
export function claudeMcpServers(statuses: ReadonlyArray<ClaudeMcpStatus>): ProviderMcpServer[] {
  return statuses
    .filter((entry) => entry.name !== T3_CODE_SERVER && entry.source !== "sdk")
    .map((entry) => {
      const scope = entry.scope ?? entry.source ?? null;
      const type = entry.config?.type;
      const transport =
        scope === "claudeai" || type === "claudeai-proxy"
          ? ("connector" as const)
          : type === "http" || type === "sse"
            ? type
            : type === "stdio" || entry.config?.command
              ? ("stdio" as const)
              : ("other" as const);
      const status = CLAUDE_STATUSES[entry.status] ?? "failed";
      const remote = transport === "http" || transport === "sse" || transport === "connector";
      return {
        name: entry.name,
        scope,
        transport,
        target: entry.config?.url ?? commandLine(entry.config?.command, entry.config?.args),
        status,
        detail: entry.error?.trim() || null,
        canSignIn: remote,
        signedIn: remote && status === "connected",
        canRemove: scope === "user",
      };
    });
}

/** `auth_status` spellings differ across Codex surfaces: `not_logged_in`, `notLoggedIn`. */
const normalizeAuth = (value: unknown) =>
  typeof value === "string" ? value.replaceAll("_", "").toLowerCase() : "unsupported";

/** Parses `codex mcp list --json`. Codex reports config and sign-in state, not live health. */
export function codexMcpServers(json: string): ProviderMcpServer[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((raw): ProviderMcpServer[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name || name === T3_CODE_SERVER) return [];
    const transportRaw = (entry.transport ?? {}) as Record<string, unknown>;
    const type = typeof transportRaw.type === "string" ? transportRaw.type : "";
    const transport =
      type === "stdio"
        ? ("stdio" as const)
        : type === "streamable_http" || type === "http"
          ? ("http" as const)
          : type === "sse"
            ? ("sse" as const)
            : ("other" as const);
    const auth = normalizeAuth(entry.auth_status ?? entry.authStatus);
    const enabled = entry.enabled !== false;
    const disabledReason =
      typeof entry.disabled_reason === "string" ? entry.disabled_reason.trim() : "";
    return [
      {
        name,
        scope: "user",
        transport,
        target:
          typeof transportRaw.url === "string"
            ? transportRaw.url
            : commandLine(
                typeof transportRaw.command === "string" ? transportRaw.command : undefined,
                Array.isArray(transportRaw.args)
                  ? transportRaw.args.filter((arg): arg is string => typeof arg === "string")
                  : undefined,
              ),
        status: !enabled ? "disabled" : auth === "notloggedin" ? "needs-auth" : "configured",
        detail: disabledReason || null,
        canSignIn: auth === "notloggedin" || auth === "oauth",
        signedIn: auth === "oauth",
        canRemove: true,
      },
    ];
  });
}

/** CLI arguments for each change, run with the instance's environment. */
export const mcpCliArgs = {
  add: (driver: McpDriver, name: string, server: ProviderMcpServerDefinition): string[] => {
    if (driver === "claudeAgent") {
      const json =
        server.type === "stdio"
          ? { type: "stdio", command: server.command, args: server.args, env: server.env }
          : { type: "http", url: server.url };
      return ["mcp", "add-json", name, JSON.stringify(json), "--scope", "user"];
    }
    return server.type === "stdio"
      ? [
          "mcp",
          "add",
          name,
          ...Object.entries(server.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
          "--",
          server.command,
          ...server.args,
        ]
      : ["mcp", "add", name, "--url", server.url];
  },
  remove: (driver: McpDriver, name: string) =>
    driver === "claudeAgent" ? ["mcp", "remove", name, "--scope", "user"] : ["mcp", "remove", name],
  signOut: (_driver: McpDriver, name: string) => ["mcp", "logout", name],
  /** Both CLIs print the URL and accept the pasted redirect URL on stdin. */
  signIn: (_driver: McpDriver, name: string) => ["mcp", "login", name, "--no-browser"],
};

/**
 * The authorization link a `login --no-browser` run prints: the first URL that
 * carries OAuth request parameters, or, once the CLI asks for the pasted
 * redirect, the last URL it printed.
 */
export function findAuthorizationUrl(output: string): string | null {
  const urls = output.match(/https?:\/\/[^\s"'<>]+/gu) ?? [];
  return (
    urls.find((url) => /[?&](response_type|redirect_uri|client_id)=/u.test(url)) ??
    (/paste|redirect url/iu.test(output) ? (urls.at(-1) ?? null) : null)
  );
}

/** The last few lines of CLI output, for an error the user can act on. */
export function outputTail(output: string, lines = 4): string {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(" · ");
}

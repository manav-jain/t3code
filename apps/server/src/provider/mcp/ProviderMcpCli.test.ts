import { describe, expect, it } from "vite-plus/test";

import {
  claudeMcpServers,
  codexMcpServers,
  findAuthorizationUrl,
  mcpCliArgs,
} from "./ProviderMcpCli.ts";

describe("claudeMcpServers", () => {
  it("maps Claude's live status and hides servers the user does not own", () => {
    const servers = claudeMcpServers([
      {
        name: "sentry",
        status: "needs-auth",
        scope: "user",
        config: { type: "http", url: "https://mcp.sentry.dev/mcp" },
      },
      {
        name: "claude.ai Slack",
        status: "connected",
        scope: "claudeai",
        config: { type: "claudeai-proxy", url: "https://mcp.slack.com/mcp" },
      },
      {
        name: "docs",
        status: "failed",
        error: " spawn npx ENOENT ",
        scope: "project",
        config: { type: "stdio", command: "npx", args: ["docs-mcp"] },
      },
      { name: "t3-code", status: "connected", scope: "dynamic" },
      { name: "in-process", status: "connected", source: "sdk" },
    ]);

    expect(servers).toEqual([
      {
        name: "sentry",
        scope: "user",
        transport: "http",
        target: "https://mcp.sentry.dev/mcp",
        status: "needs-auth",
        detail: null,
        canSignIn: true,
        signedIn: false,
        canRemove: true,
      },
      {
        name: "claude.ai Slack",
        scope: "claudeai",
        transport: "connector",
        target: "https://mcp.slack.com/mcp",
        status: "connected",
        detail: null,
        canSignIn: true,
        signedIn: true,
        canRemove: false,
      },
      {
        name: "docs",
        scope: "project",
        transport: "stdio",
        target: "npx docs-mcp",
        status: "failed",
        detail: "spawn npx ENOENT",
        canSignIn: false,
        signedIn: false,
        canRemove: false,
      },
    ]);
  });
});

describe("codexMcpServers", () => {
  it("reads sign-in state from `codex mcp list --json`", () => {
    const servers = codexMcpServers(
      JSON.stringify([
        {
          name: "docker",
          enabled: true,
          transport: { type: "stdio", command: "docker", args: ["mcp", "gateway", "run"] },
          auth_status: "unsupported",
        },
        {
          name: "linear",
          enabled: true,
          transport: { type: "streamable_http", url: "https://mcp.linear.app/mcp" },
          auth_status: "not_logged_in",
        },
        {
          name: "notion",
          enabled: false,
          disabled_reason: "turned off in config",
          transport: { type: "streamable_http", url: "https://mcp.notion.com/mcp" },
          authStatus: "oAuth",
        },
        { name: "t3-code", enabled: true, transport: { type: "streamable_http", url: "x" } },
        "garbage",
      ]),
    );

    expect(
      servers.map(({ name, transport, status, canSignIn, signedIn, detail }) => ({
        name,
        transport,
        status,
        canSignIn,
        signedIn,
        detail,
      })),
    ).toEqual([
      {
        name: "docker",
        transport: "stdio",
        status: "configured",
        canSignIn: false,
        signedIn: false,
        detail: null,
      },
      {
        name: "linear",
        transport: "http",
        status: "needs-auth",
        canSignIn: true,
        signedIn: false,
        detail: null,
      },
      {
        name: "notion",
        transport: "http",
        status: "disabled",
        canSignIn: true,
        signedIn: true,
        detail: "turned off in config",
      },
    ]);
    expect(servers[0]?.target).toBe("docker mcp gateway run");
  });
});

describe("mcpCliArgs.add", () => {
  const stdio = {
    type: "stdio" as const,
    command: "npx",
    args: ["-y", "docs-mcp"],
    env: { API_KEY: "secret" },
  };

  it("writes Claude servers to user scope as JSON", () => {
    expect(mcpCliArgs.add("claudeAgent", "docs", stdio)).toEqual([
      "mcp",
      "add-json",
      "docs",
      JSON.stringify({
        type: "stdio",
        command: "npx",
        args: ["-y", "docs-mcp"],
        env: { API_KEY: "secret" },
      }),
      "--scope",
      "user",
    ]);
  });

  it("keeps the server's own flags after `--` for Codex", () => {
    expect(mcpCliArgs.add("codex", "docs", stdio)).toEqual([
      "mcp",
      "add",
      "docs",
      "--env",
      "API_KEY=secret",
      "--",
      "npx",
      "-y",
      "docs-mcp",
    ]);
    expect(
      mcpCliArgs.add("codex", "linear", { type: "http", url: "https://mcp.linear.app/mcp" }),
    ).toEqual(["mcp", "add", "linear", "--url", "https://mcp.linear.app/mcp"]);
  });
});

describe("findAuthorizationUrl", () => {
  it("picks the OAuth request over other links the CLI prints", () => {
    const output = [
      "Authenticating with https://mcp.linear.app/mcp …",
      "Open this URL to sign in:",
      "https://linear.app/oauth/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2Fcallback",
    ].join("\n");
    expect(findAuthorizationUrl(output)).toBe(
      "https://linear.app/oauth/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2Fcallback",
    );
  });

  it("falls back to the last link once the CLI asks for the redirect", () => {
    expect(
      findAuthorizationUrl("Visit https://claude.ai/connect/slack\nPaste the redirect URL:"),
    ).toBe("https://claude.ai/connect/slack");
    expect(findAuthorizationUrl("Authenticating with https://mcp.linear.app/mcp …")).toBeNull();
  });
});

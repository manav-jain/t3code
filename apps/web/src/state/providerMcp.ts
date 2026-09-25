import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * A provider instance's own MCP servers. Listing starts the provider and
 * health-checks every server, so results are kept for a minute.
 */
export const providerMcpList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:provider-mcp:list",
  tag: WS_METHODS.providerMcpList,
  staleTimeMs: 60_000,
  idleTtlMs: 5 * 60_000,
});

export const providerMcpUpdate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:provider-mcp:update",
  tag: WS_METHODS.providerMcpUpdate,
});

export const providerMcpSignIn = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:provider-mcp:sign-in",
  tag: WS_METHODS.providerMcpSignIn,
});

export const providerMcpFinishSignIn = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:provider-mcp:finish-sign-in",
  tag: WS_METHODS.providerMcpFinishSignIn,
});

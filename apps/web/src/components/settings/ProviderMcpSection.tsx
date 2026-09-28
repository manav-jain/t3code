import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderMcpServer,
  ProviderMcpServerDefinition,
} from "@t3tools/contracts";
import { EllipsisIcon } from "lucide-react";
import { useId, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import {
  providerMcpFinishSignIn,
  providerMcpList,
  providerMcpSignIn,
  providerMcpUpdate,
} from "../../state/providerMcp";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingsSection } from "./settingsLayout";

const STATUS_BADGE: Record<
  ProviderMcpServer["status"],
  { label: string; variant: "success" | "warning" | "error" | "secondary" | "outline" }
> = {
  connected: { label: "Connected", variant: "success" },
  "needs-auth": { label: "Needs sign-in", variant: "warning" },
  failed: { label: "Failed", variant: "error" },
  pending: { label: "Connecting", variant: "secondary" },
  disabled: { label: "Disabled", variant: "outline" },
  configured: { label: "Configured", variant: "outline" },
};

const SCOPE_LABELS: Record<string, string> = { claudeai: "claude.ai", user: "" };

const failureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Something went wrong.";
};

interface SignIn {
  readonly key: string;
  readonly name: string;
  readonly projectId: ProjectId | null;
  readonly url: string;
  readonly callbackUrl: string;
  readonly submitting: boolean;
  readonly error: string | null;
}

const serverKey = (server: Pick<ProviderMcpServer, "name" | "project">) =>
  `${server.project?.id ?? ""}:${server.name}`;

/** Where a server comes from: nothing for the instance's own, else claude.ai or its project. */
const sourceLabel = (server: ProviderMcpServer) =>
  server.project
    ? `${server.project.title} · ${server.scope ?? "project"}`
    : server.scope === null
      ? ""
      : (SCOPE_LABELS[server.scope] ?? server.scope);

const matchesSearch = (server: ProviderMcpServer, query: string) =>
  [server.name, server.target, sourceLabel(server)].some((field) =>
    field.toLowerCase().includes(query),
  );

/**
 * The MCP servers a provider instance connects to on its own, from the user
 * config in that instance's home and from projects on this environment, with
 * sign-in for remote servers. Sign-in finishes on its own when the browser can
 * reach the environment's localhost callback; otherwise the user pastes the
 * address of the page that failed.
 */
export function ProviderMcpSection({
  environmentId,
  instanceId,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly readOnly: boolean;
}) {
  const listQuery = useEnvironmentQuery(providerMcpList({ environmentId, input: { instanceId } }));
  const update = useAtomCommand(providerMcpUpdate, { reportFailure: false });
  const startSignIn = useAtomCommand(providerMcpSignIn, { reportFailure: false });
  const finishSignIn = useAtomCommand(providerMcpFinishSignIn, { reportFailure: false });
  const [signIn, setSignIn] = useState<SignIn | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProviderMcpServer | null>(null);
  const [search, setSearch] = useState("");

  const servers = listQuery.data?.servers ?? null;
  const query = search.trim().toLowerCase();
  const visible = servers?.filter((server) => !query || matchesSearch(server, query)) ?? [];

  const runUpdate = async (
    server: ProviderMcpServer,
    type: "remove" | "sign-out",
    success: string,
  ): Promise<void> => {
    setBusyKey(serverKey(server));
    const result = await update({
      environmentId,
      input: { type, instanceId, name: server.name, projectId: server.project?.id ?? null },
    });
    setBusyKey(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Could not update ${server.name}`,
        description: failureMessage(result),
      });
      return;
    }
    toastManager.add({ type: "success", title: success });
    listQuery.refresh();
  };

  /** Resolves once the provider CLI finishes the sign-in, with or without a pasted address. */
  const awaitSignIn = async (target: SignIn, callbackUrl: string | null) => {
    const result = await finishSignIn({
      environmentId,
      input: {
        instanceId,
        name: target.name,
        projectId: target.projectId,
        callbackUrl,
        cancel: false,
      },
    });
    setSignIn((current) => {
      if (current?.key !== target.key) return current;
      return result._tag === "Success"
        ? null
        : { ...current, submitting: false, error: failureMessage(result) };
    });
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: `Signed in to ${target.name}` });
      listQuery.refresh();
    }
  };

  const cancelSignIn = async () => {
    if (!signIn) return;
    const { name, projectId } = signIn;
    setSignIn(null);
    await finishSignIn({
      environmentId,
      input: { instanceId, name, projectId, callbackUrl: null, cancel: true },
    });
  };

  const beginSignIn = async (server: ProviderMcpServer) => {
    if (signIn) await cancelSignIn();
    const key = serverKey(server);
    const projectId = server.project?.id ?? null;
    setBusyKey(key);
    const result = await startSignIn({
      environmentId,
      input: { instanceId, name: server.name, projectId },
    });
    setBusyKey(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Could not sign in to ${server.name}`,
        description: failureMessage(result),
      });
      return;
    }
    const next: SignIn = {
      key,
      name: server.name,
      projectId,
      url: result.value.authorizationUrl,
      callbackUrl: "",
      submitting: false,
      error: null,
    };
    setSignIn(next);
    void ensureLocalApi()
      .shell.openExternal(next.url)
      .catch(() => {});
    void awaitSignIn(next, null);
  };

  return (
    <SettingsSection
      title="MCP servers"
      headerAction={
        <div className="flex items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh MCP servers"
            aria-busy={listQuery.isPending}
            disabled={listQuery.isPending}
            onClick={() => listQuery.refresh()}
          >
            <RefreshIcon size="sm" refreshing={listQuery.isPending} />
          </Button>
          <Button size="xs" variant="outline" disabled={readOnly} onClick={() => setAdding(true)}>
            Add server
          </Button>
        </div>
      }
    >
      {servers === null ? (
        <div className="px-3 py-3 sm:px-4">
          {listQuery.error ? (
            <p className="text-sm text-muted-foreground">
              Could not read MCP servers: {listQuery.error}
            </p>
          ) : (
            <div className="flex flex-col gap-2" aria-label="Loading MCP servers">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          )}
        </div>
      ) : servers.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
          No MCP servers configured.
        </p>
      ) : (
        <>
          <div className="px-3 py-2 sm:px-4">
            <Input
              size="sm"
              type="search"
              aria-label="Search MCP servers"
              placeholder="Search by name, URL, or project"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {visible.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
              No servers match “{search.trim()}”.
            </p>
          ) : null}
          {visible.map((server) => {
            const key = serverKey(server);
            const badge =
              server.status === "configured" && server.signedIn
                ? { label: "Signed in", variant: "success" as const }
                : STATUS_BADGE[server.status];
            const source = sourceLabel(server);
            const busy = busyKey === key;
            const hasMenuActions = server.canSignIn || server.signedIn || server.canRemove;
            return (
              <div key={key} className="flex flex-col gap-2 px-3 py-2.5 sm:px-4">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-baseline gap-1.5 text-sm">
                      <span className="truncate">{server.name}</span>
                      {source ? (
                        <span className="shrink-0 truncate text-xs text-muted-foreground">
                          {source}
                        </span>
                      ) : null}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {server.detail ?? server.target}
                    </span>
                  </div>
                  <Badge variant={badge.variant} size="sm">
                    {badge.label}
                  </Badge>
                  {server.status === "needs-auth" && server.canSignIn ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={readOnly || busy}
                      onClick={() => void beginSignIn(server)}
                    >
                      Sign in
                    </Button>
                  ) : null}
                  {hasMenuActions ? (
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Actions for ${server.name}`}
                            disabled={readOnly || busy}
                          />
                        }
                      >
                        <EllipsisIcon />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        {server.canSignIn ? (
                          <MenuItem onClick={() => void beginSignIn(server)}>
                            {server.status === "needs-auth" ? "Sign in" : "Sign in again"}
                          </MenuItem>
                        ) : null}
                        {server.signedIn ? (
                          <MenuItem
                            onClick={() =>
                              void runUpdate(server, "sign-out", `Signed out of ${server.name}`)
                            }
                          >
                            Sign out
                          </MenuItem>
                        ) : null}
                        {server.canRemove ? (
                          <MenuItem onClick={() => setRemoving(server)}>Remove</MenuItem>
                        ) : null}
                      </MenuPopup>
                    </Menu>
                  ) : null}
                </div>
                {signIn?.key === key ? (
                  <SignInPanel
                    signIn={signIn}
                    onChange={(callbackUrl) => setSignIn({ ...signIn, callbackUrl })}
                    onSubmit={() => {
                      const submitted = { ...signIn, submitting: true, error: null };
                      setSignIn(submitted);
                      void awaitSignIn(submitted, signIn.callbackUrl.trim());
                    }}
                    onCancel={() => void cancelSignIn()}
                  />
                ) : null}
              </div>
            );
          })}
        </>
      )}

      <AddMcpServerDialog
        open={adding}
        onOpenChange={setAdding}
        onAdd={async (name, server) => {
          const result = await update({
            environmentId,
            input: { type: "add", instanceId, name, server },
          });
          if (result._tag === "Failure") return failureMessage(result);
          toastManager.add({ type: "success", title: `Added ${name}` });
          listQuery.refresh();
          return null;
        }}
      />

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.project
                ? `Claude stops connecting to it in ${removing.project.title}. Add it again from that project to restore it.`
                : "The provider stops connecting to it. Its definition leaves the user config; add it again to restore it."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const target = removing;
                setRemoving(null);
                if (target) void runUpdate(target, "remove", `Removed ${target.name}`);
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

function SignInPanel({
  signIn,
  onChange,
  onSubmit,
  onCancel,
}: {
  readonly signIn: SignIn;
  readonly onChange: (callbackUrl: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}) {
  const callbackId = useId();
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/50 p-3 text-xs">
      <p>
        Finish signing in to {signIn.name} in your browser. This updates on its own once you approve
        access.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void ensureLocalApi()
              .shell.openExternal(signIn.url)
              .catch(() => {})
          }
        >
          Open sign-in page
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void writeTextToClipboard(signIn.url, `${signIn.name} sign-in link`)}
        >
          Copy link
        </Button>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label htmlFor={callbackId} className="text-muted-foreground">
          If the last page does not load, paste its full address here.
        </label>
        <div className="flex gap-2">
          <Input
            id={callbackId}
            size="sm"
            type="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="http://127.0.0.1:..."
            value={signIn.callbackUrl}
            maxLength={16_384}
            disabled={signIn.submitting}
            onChange={(event) => onChange(event.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            type="submit"
            disabled={signIn.submitting || !signIn.callbackUrl.trim()}
          >
            Continue
          </Button>
        </div>
      </form>
      {signIn.error ? <p className="text-destructive-foreground">{signIn.error}</p> : null}
    </div>
  );
}

/** `KEY=value` per line; blank lines are ignored. */
function parseEnvLines(text: string): Record<string, string> | string {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) return `"${trimmed}" is not KEY=value.`;
    env[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1);
  }
  return env;
}

function AddMcpServerDialog({
  open,
  onOpenChange,
  onAdd,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Resolves to an error message, or null once added. */
  readonly onAdd: (name: string, server: ProviderMcpServerDefinition) => Promise<string | null>;
}) {
  const [type, setType] = useState<"http" | "stdio">("http");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [commandLine, setCommandLine] = useState("");
  const [envText, setEnvText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setType("http");
    setName("");
    setUrl("");
    setCommandLine("");
    setEnvText("");
    setError(null);
  };
  const close = () => {
    reset();
    onOpenChange(false);
  };

  const save = async () => {
    const trimmedName = name.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(trimmedName)) {
      setError("Use letters, numbers, dashes, and underscores for the name.");
      return;
    }
    let server: ProviderMcpServerDefinition;
    if (type === "http") {
      if (!/^https?:\/\/\S+$/u.test(url.trim())) {
        setError("Enter the server's full http(s) URL.");
        return;
      }
      server = { type: "http", url: url.trim() };
    } else {
      const [command, ...args] = commandLine.trim().split(/\s+/u);
      if (!command) {
        setError("Enter the command that starts the server.");
        return;
      }
      const env = parseEnvLines(envText);
      if (typeof env === "string") {
        setError(env);
        return;
      }
      server = { type: "stdio", command, args, env };
    }
    setSaving(true);
    const failure = await onAdd(trimmedName, server);
    setSaving(false);
    if (failure) setError(failure);
    else close();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add an MCP server</DialogTitle>
          <DialogDescription>
            Saved to this provider's user config, so every session it runs can use it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-server-name">Name</Label>
              <Input
                id="mcp-server-name"
                placeholder="linear"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </div>
            <ToggleGroup
              aria-label="Server type"
              value={[type]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "http" || value === "stdio") setType(value);
              }}
            >
              <Toggle value="http">Remote URL</Toggle>
              <Toggle value="stdio">Local command</Toggle>
            </ToggleGroup>
            {type === "http" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="mcp-server-url">URL</Label>
                <Input
                  id="mcp-server-url"
                  placeholder="https://mcp.linear.app/mcp"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </div>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="mcp-server-command">Command</Label>
                  <Input
                    id="mcp-server-command"
                    placeholder="npx -y @modelcontextprotocol/server-memory"
                    value={commandLine}
                    onChange={(event) => setCommandLine(event.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="mcp-server-env">Environment (optional)</Label>
                  <Textarea
                    id="mcp-server-env"
                    placeholder="API_KEY=..."
                    value={envText}
                    onChange={(event) => setEnvText(event.target.value)}
                  />
                </div>
              </>
            )}
            {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            Add server
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

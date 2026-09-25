import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderMcpServer,
  ProviderMcpServerDefinition,
} from "@t3tools/contracts";
import { EllipsisIcon } from "lucide-react";
import { useState } from "react";

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
  readonly name: string;
  readonly url: string;
  readonly callbackUrl: string;
  readonly submitting: boolean;
  readonly error: string | null;
}

/**
 * The MCP servers a provider instance connects to on its own, from the user
 * config in that instance's home, with sign-in for remote servers. Sign-in
 * finishes on its own when the browser can reach the environment's localhost
 * callback; otherwise the user pastes the address of the page that failed.
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
  const [busyName, setBusyName] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProviderMcpServer | null>(null);

  const servers = listQuery.data?.servers ?? null;

  const runUpdate = async (
    name: string,
    type: "remove" | "sign-out",
    success: string,
  ): Promise<void> => {
    setBusyName(name);
    const result = await update({ environmentId, input: { type, instanceId, name } });
    setBusyName(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Could not update ${name}`,
        description: failureMessage(result),
      });
      return;
    }
    toastManager.add({ type: "success", title: success });
    listQuery.refresh();
  };

  /** Resolves once the provider CLI finishes the sign-in, with or without a pasted address. */
  const awaitSignIn = async (name: string, callbackUrl: string | null) => {
    const result = await finishSignIn({
      environmentId,
      input: { instanceId, name, callbackUrl, cancel: false },
    });
    setSignIn((current) => {
      if (current?.name !== name) return current;
      return result._tag === "Success"
        ? null
        : { ...current, submitting: false, error: failureMessage(result) };
    });
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: `Signed in to ${name}` });
      listQuery.refresh();
    }
  };

  const beginSignIn = async (name: string) => {
    if (signIn) await cancelSignIn();
    setBusyName(name);
    const result = await startSignIn({ environmentId, input: { instanceId, name } });
    setBusyName(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Could not sign in to ${name}`,
        description: failureMessage(result),
      });
      return;
    }
    const url = result.value.authorizationUrl;
    setSignIn({ name, url, callbackUrl: "", submitting: false, error: null });
    void ensureLocalApi()
      .shell.openExternal(url)
      .catch(() => {});
    void awaitSignIn(name, null);
  };

  const cancelSignIn = async () => {
    if (!signIn) return;
    const { name } = signIn;
    setSignIn(null);
    await finishSignIn({
      environmentId,
      input: { instanceId, name, callbackUrl: null, cancel: true },
    });
  };

  return (
    <div className="flex flex-col gap-3 px-3 py-3 sm:px-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Servers this provider connects to on its own, from its user config. Project servers stay
          in each project's config.
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh MCP servers"
            aria-busy={listQuery.isPending}
            disabled={listQuery.isPending}
            onClick={() => listQuery.refresh()}
          >
            <RefreshIcon size="sm" refreshing={listQuery.isPending} />
          </Button>
          <Button size="sm" variant="outline" disabled={readOnly} onClick={() => setAdding(true)}>
            Add server
          </Button>
        </div>
      </div>

      {servers === null ? (
        listQuery.error ? (
          <p className="text-sm text-muted-foreground">
            Could not read MCP servers: {listQuery.error}
          </p>
        ) : (
          <div className="flex flex-col gap-2" aria-label="Loading MCP servers">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        )
      ) : servers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No MCP servers configured.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border">
          {servers.map((server) => {
            const badge =
              server.status === "configured" && server.signedIn
                ? { label: "Signed in", variant: "success" as const }
                : STATUS_BADGE[server.status];
            const scope =
              server.scope === null ? null : (SCOPE_LABELS[server.scope] ?? server.scope);
            const busy = busyName === server.name;
            const hasMenuActions = server.canSignIn || server.signedIn || server.canRemove;
            return (
              <li key={server.name} className="flex flex-col gap-2 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5 text-sm">
                      <span className="truncate">{server.name}</span>
                      {scope ? (
                        <span className="shrink-0 text-xs text-muted-foreground">{scope}</span>
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
                      onClick={() => void beginSignIn(server.name)}
                    >
                      Sign in
                    </Button>
                  ) : null}
                  {hasMenuActions ? (
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-sm"
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
                          <MenuItem onClick={() => void beginSignIn(server.name)}>
                            {server.status === "needs-auth" ? "Sign in" : "Sign in again"}
                          </MenuItem>
                        ) : null}
                        {server.signedIn ? (
                          <MenuItem
                            onClick={() =>
                              void runUpdate(
                                server.name,
                                "sign-out",
                                `Signed out of ${server.name}`,
                              )
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
                {signIn?.name === server.name ? (
                  <SignInPanel
                    signIn={signIn}
                    onChange={(callbackUrl) => setSignIn({ ...signIn, callbackUrl })}
                    onSubmit={() => {
                      setSignIn({ ...signIn, submitting: true, error: null });
                      void awaitSignIn(server.name, signIn.callbackUrl.trim());
                    }}
                    onCancel={() => void cancelSignIn()}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
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
              The provider stops connecting to it. Its definition leaves the user config; add it
              again to restore it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const target = removing;
                setRemoving(null);
                if (target) void runUpdate(target.name, "remove", `Removed ${target.name}`);
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
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
        <label htmlFor={`mcp-callback-${signIn.name}`} className="text-muted-foreground">
          If the last page does not load, paste its full address here.
        </label>
        <div className="flex gap-2">
          <Input
            id={`mcp-callback-${signIn.name}`}
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

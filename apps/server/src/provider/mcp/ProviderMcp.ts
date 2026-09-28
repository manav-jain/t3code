import * as NodeOS from "node:os";

import { query as claudeQuery, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSettings,
  CodexSettings,
  type ProjectId,
  ProviderMcpError,
  type ProviderMcpServer,
  type ProviderMcpFinishSignInInput,
  type ProviderMcpListInput,
  type ProviderMcpListResult,
  type ProviderMcpSignInInput,
  type ProviderMcpSignInStarted,
  type ProviderMcpUpdateInput,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { resolveClaudeSdkExecutablePath } from "../Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";
import {
  claudeLocalServerRoots,
  claudeMcpServers,
  codexMcpServers,
  findAuthorizationUrl,
  isMcpDriver,
  type McpDriver,
  mcpCliArgs,
  outputTail,
} from "./ProviderMcpCli.ts";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const isProviderMcpError = Schema.is(ProviderMcpError);

const CLI_TIMEOUT = Duration.seconds(60);
/** Claude connects every server to report status; slow stdio servers need a moment. */
const CLAUDE_STATUS_TIMEOUT = Duration.seconds(45);
const CLAUDE_PENDING_WAIT_MS = 20_000;
const SIGN_IN_URL_TIMEOUT = Duration.seconds(30);
/** How long a started sign-in waits for the user before it is abandoned. */
const SIGN_IN_TIMEOUT = Duration.minutes(10);

const failure = (detail: string) => (cause?: unknown) =>
  new ProviderMcpError({ detail, ...(cause === undefined ? {} : { cause }) });

interface McpTarget {
  readonly driver: McpDriver;
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
}

interface SignInSession {
  readonly scope: Scope.Closeable;
  readonly writeCallback: (callbackUrl: string) => Effect.Effect<void, ProviderMcpError>;
  readonly exit: Deferred.Deferred<number>;
  readonly output: () => string;
}

export class ProviderMcp extends Context.Service<
  ProviderMcp,
  {
    readonly list: (
      input: ProviderMcpListInput,
    ) => Effect.Effect<ProviderMcpListResult, ProviderMcpError>;
    readonly update: (input: ProviderMcpUpdateInput) => Effect.Effect<void, ProviderMcpError>;
    readonly signIn: (
      input: ProviderMcpSignInInput,
    ) => Effect.Effect<ProviderMcpSignInStarted, ProviderMcpError>;
    readonly finishSignIn: (
      input: ProviderMcpFinishSignInInput,
    ) => Effect.Effect<void, ProviderMcpError>;
  }
>()("t3/provider/mcp/ProviderMcp") {}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const context = yield* Effect.context<never>();
  const signIns = new Map<string, SignInSession>();

  /** The instance's CLI and environment, pointed at the home its MCP config lives in. */
  const resolveTarget = Effect.fn("ProviderMcp.resolveTarget")(function* (instanceId: string) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(failure("Could not read provider settings.")),
    );
    const instance = deriveProviderInstanceConfigMap(current)[instanceId as never];
    if (instance === undefined) {
      return yield* failure("This provider instance no longer exists.")();
    }
    if (!isMcpDriver(instance.driver)) {
      return yield* failure("T3 Code can't manage MCP servers for this provider.")();
    }
    const base = mergeProviderInstanceEnvironment(instance.environment, process.env);
    if (instance.driver === "claudeAgent") {
      const config = decodeClaudeSettings(instance.config ?? {});
      if (Option.isNone(config)) return yield* failure("Claude settings are invalid.")();
      const env = yield* makeClaudeEnvironment(config.value, base).pipe(
        Effect.provideService(Path.Path, path),
      );
      return { driver: instance.driver, binaryPath: config.value.binaryPath, env } as McpTarget;
    }
    const config = decodeCodexSettings(instance.config ?? {});
    if (Option.isNone(config)) return yield* failure("Codex settings are invalid.")();
    const layout = yield* resolveCodexHomeLayout(config.value).pipe(
      Effect.provideService(Path.Path, path),
    );
    // A shadow home only holds private auth; MCP config and tokens live in the shared home,
    // and a CLI rewriting config there must not replace the shadow's link to it.
    const home = layout.mode === "authOverlay" ? layout.sharedHomePath : layout.effectiveHomePath;
    return {
      driver: instance.driver,
      binaryPath: config.value.binaryPath,
      env: home === undefined ? base : { ...base, CODEX_HOME: home },
    } as McpTarget;
  });

  /** `cwd` is a project root for a project's servers; the CLI resolves them from there. */
  const command = (target: McpTarget, args: ReadonlyArray<string>, cwd: string | undefined) =>
    resolveSpawnCommand(target.binaryPath, args, { env: target.env }).pipe(
      Effect.map((spawn) =>
        ChildProcess.make(spawn.command, spawn.args, {
          env: target.env,
          shell: spawn.shell,
          ...(cwd === undefined ? {} : { cwd }),
        }),
      ),
    );

  const runCli = (target: McpTarget, args: ReadonlyArray<string>, cwd?: string) =>
    command(target, args, cwd).pipe(
      Effect.flatMap((cmd) => spawnAndCollect(target.binaryPath, cmd)),
      Effect.provide(context),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.timeoutOrElse({
        duration: CLI_TIMEOUT,
        orElse: () => Effect.fail(failure("The provider CLI did not answer in time.")()),
      }),
      Effect.mapError((cause) =>
        isProviderMcpError(cause) ? cause : failure("Could not run the provider CLI.")(cause),
      ),
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(
              failure(
                outputTail(result.stderr) ||
                  outputTail(result.stdout) ||
                  `The provider CLI exited with code ${result.code}.`,
              )(),
            ),
      ),
    );

  /**
   * Claude reports live status only from a session, so start one that never
   * prompts. Inside a project it also loads the project's `.mcp.json` and local
   * servers; only those are kept there, with claude.ai connectors off, since the
   * user-level run already reports the rest.
   */
  const listClaude = (
    target: McpTarget,
    project: { readonly id: ProjectId; readonly title: string; readonly root: string } | null,
  ) =>
    Effect.gen(function* () {
      const executablePath = yield* resolveClaudeSdkExecutablePath(target.binaryPath, target.env);
      const abort = new AbortController();
      return yield* Effect.gen(function* () {
        const session = yield* Effect.tryPromise({
          try: async () => {
            const session = claudeQuery({
              // oxlint-disable-next-line require-yield
              prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
                await waitForAbort(abort.signal);
              })(),
              options: {
                persistSession: false,
                pathToClaudeCodeExecutable: executablePath,
                abortController: abort,
                settingSources: project ? ["user", "project", "local"] : ["user"],
                settings: { disableAllHooks: true },
                allowedTools: [],
                cwd: project?.root ?? NodeOS.homedir(),
                env: {
                  ...target.env,
                  ...(project ? { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } : {}),
                  CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
                  CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
                },
                stderr: () => {},
              },
            });
            await session.initializationResult();
            return session;
          },
          catch: failure("Could not start Claude Code to read its MCP servers."),
        });
        const read = Effect.tryPromise({
          try: () => session.mcpServerStatus(),
          catch: failure("Could not ask Claude Code for its MCP servers."),
        });
        // Servers finish connecting after initialization.
        const deadline = (yield* Clock.currentTimeMillis) + CLAUDE_PENDING_WAIT_MS;
        let statuses = yield* read;
        while (
          statuses.some((entry) => entry.status === "pending") &&
          (yield* Clock.currentTimeMillis) < deadline
        ) {
          yield* Effect.sleep(Duration.millis(500));
          statuses = yield* read;
        }
        return project
          ? claudeMcpServers(
              statuses.filter((entry) => entry.scope === "local" || entry.scope === "project"),
              { id: project.id, title: project.title },
            )
          : claudeMcpServers(statuses);
      }).pipe(
        Effect.timeoutOrElse({
          duration: CLAUDE_STATUS_TIMEOUT,
          orElse: () =>
            Effect.fail(failure("Claude Code did not report its MCP servers in time.")()),
        }),
        Effect.ensuring(Effect.sync(() => abort.abort())),
      );
    }).pipe(Effect.provide(context));

  /** Projects on this environment that add Claude servers of their own. */
  const claudeServerProjects = Effect.fn("ProviderMcp.claudeServerProjects")(function* (
    target: McpTarget,
  ) {
    const projects = yield* projections.getProjectShells().pipe(Effect.orElseSucceed(() => []));
    const localRoots = yield* fileSystem
      .readFileString(path.join(target.env.CLAUDE_CONFIG_DIR ?? NodeOS.homedir(), ".claude.json"))
      .pipe(
        Effect.flatMap((json) => Effect.try(() => claudeLocalServerRoots(json))),
        Effect.orElseSucceed((): ReadonlySet<string> => new Set()),
      );
    const withServers = yield* Effect.forEach(projects, (project) =>
      (localRoots.has(project.workspaceRoot)
        ? Effect.succeed(true)
        : fileSystem.exists(path.join(project.workspaceRoot, ".mcp.json"))
      ).pipe(
        Effect.orElseSucceed(() => false),
        Effect.map((has) =>
          has ? [{ id: project.id, title: project.title, root: project.workspaceRoot }] : [],
        ),
      ),
    );
    return withServers.flat();
  });

  const list: ProviderMcp["Service"]["list"] = Effect.fn("ProviderMcp.list")(function* (input) {
    const target = yield* resolveTarget(input.instanceId);
    if (target.driver === "claudeAgent") {
      const projects = yield* claudeServerProjects(target);
      const [own, perProject] = yield* Effect.all(
        [
          listClaude(target, null),
          // A project whose servers cannot be read is left out rather than failing the list.
          Effect.forEach(
            projects,
            (project) =>
              listClaude(target, project).pipe(
                Effect.orElseSucceed((): ReadonlyArray<ProviderMcpServer> => []),
              ),
            { concurrency: 3 },
          ),
        ],
        { concurrency: 2 },
      );
      return { servers: [...own, ...perProject.flat()] };
    }
    const stdout = yield* runCli(target, ["mcp", "list", "--json"]);
    return yield* Effect.try({
      try: () => ({ servers: codexMcpServers(stdout) }),
      catch: failure("Codex listed its MCP servers in a shape T3 Code does not understand."),
    });
  });

  const projectRoot = (projectId: ProjectId | null) =>
    projectId === null
      ? Effect.succeed(undefined)
      : projections.getProjectShellById(projectId).pipe(
          Effect.mapError(failure("Could not read the project.")),
          Effect.flatMap((project) =>
            Option.isSome(project)
              ? Effect.succeed(project.value.workspaceRoot)
              : Effect.fail(failure("This project no longer exists.")()),
          ),
        );

  /** Names from a listing reach the CLI as arguments; never let one read as an option. */
  const guardName = (name: string) =>
    name.startsWith("-") ? Effect.fail(failure("That server name is not valid.")()) : Effect.void;

  const update: ProviderMcp["Service"]["update"] = Effect.fn("ProviderMcp.update")(
    function* (input) {
      yield* guardName(input.name);
      const target = yield* resolveTarget(input.instanceId);
      if (input.type === "add") {
        return yield* runCli(target, mcpCliArgs.add(target.driver, input.name, input.server)).pipe(
          Effect.asVoid,
        );
      }
      const cwd = yield* projectRoot(input.projectId);
      const args =
        input.type === "remove"
          ? mcpCliArgs.remove(target.driver, input.name, cwd === undefined ? "user" : "local")
          : mcpCliArgs.signOut(target.driver, input.name);
      yield* runCli(target, args, cwd);
    },
  );

  const signInKey = (input: { instanceId: string; name: string; projectId: string | null }) =>
    `${input.instanceId}\u0000${input.projectId ?? ""}\u0000${input.name}`;

  const endSignIn = (key: string, session: SignInSession) =>
    Effect.suspend(() => {
      if (signIns.get(key) === session) signIns.delete(key);
      return Scope.close(session.scope, Exit.void);
    });

  const signIn: ProviderMcp["Service"]["signIn"] = Effect.fn("ProviderMcp.signIn")(
    function* (input) {
      yield* guardName(input.name);
      const target = yield* resolveTarget(input.instanceId);
      const cwd = yield* projectRoot(input.projectId);
      const key = signInKey(input);
      const previous = signIns.get(key);
      if (previous) yield* endSignIn(key, previous);

      const scope = yield* Scope.make();
      const url = yield* Deferred.make<string, ProviderMcpError>();
      const exit = yield* Deferred.make<number>();
      let output = "";
      const started = yield* Effect.gen(function* () {
        const cmd = yield* command(target, mcpCliArgs.signIn(target.driver, input.name), cwd);
        const child = yield* spawner.spawn(cmd);
        yield* Stream.merge(child.stdout, child.stderr).pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Effect.suspend(() => {
              output += chunk;
              const found = findAuthorizationUrl(output);
              return found === null
                ? Effect.void
                : Deferred.succeed(url, found).pipe(Effect.asVoid);
            }),
          ),
          Effect.ignore,
          Effect.forkIn(scope),
        );
        yield* child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => -1),
          Effect.tap((code) => Deferred.succeed(exit, code)),
          Effect.tap(() =>
            Deferred.fail(
              url,
              failure(
                outputTail(output) || "The provider CLI ended before offering a sign-in link.",
              )(),
            ),
          ),
          Effect.forkIn(scope),
        );
        yield* Effect.sleep(SIGN_IN_TIMEOUT).pipe(
          Effect.andThen(Scope.close(scope, Exit.void)),
          Effect.forkIn(scope),
        );
        return child;
      }).pipe(
        Scope.provide(scope),
        Effect.provide(context),
        Effect.mapError(failure("Could not start the provider CLI.")),
      );

      const session: SignInSession = {
        scope,
        exit,
        output: () => output,
        writeCallback: (callbackUrl) =>
          Stream.run(Stream.encodeText(Stream.make(`${callbackUrl}\n`)), started.stdin).pipe(
            Effect.mapError(failure("Could not hand the redirect address to the provider CLI.")),
          ),
      };
      signIns.set(key, session);
      return yield* Deferred.await(url).pipe(
        Effect.timeoutOrElse({
          duration: SIGN_IN_URL_TIMEOUT,
          orElse: () => Effect.fail(failure("The provider CLI did not offer a sign-in link.")()),
        }),
        Effect.map((authorizationUrl) => ({ authorizationUrl })),
        Effect.tapError(() => endSignIn(key, session)),
      );
    },
  );

  const finishSignIn: ProviderMcp["Service"]["finishSignIn"] = Effect.fn(
    "ProviderMcp.finishSignIn",
  )(function* (input) {
    const key = signInKey(input);
    const session = signIns.get(key);
    if (session === undefined) {
      if (input.cancel) return;
      return yield* failure("This sign-in is no longer running. Start it again.")();
    }
    if (input.cancel) return yield* endSignIn(key, session);
    if (input.callbackUrl !== null) {
      if (!/^https?:\/\//u.test(input.callbackUrl)) {
        return yield* failure("Paste the full address from the page that failed to load.")();
      }
      yield* session.writeCallback(input.callbackUrl);
    }
    const code = yield* Deferred.await(session.exit).pipe(
      Effect.timeoutOrElse({
        duration: SIGN_IN_TIMEOUT,
        orElse: () => Effect.fail(failure("The sign-in timed out.")()),
      }),
      Effect.ensuring(endSignIn(key, session)),
    );
    if (code !== 0) {
      return yield* failure(outputTail(session.output()) || "The sign-in did not complete.")();
    }
  });

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...signIns.values()], (session) => Scope.close(session.scope, Exit.void), {
      discard: true,
    }),
  );

  return ProviderMcp.of({ list, update, signIn, finishSignIn });
});

export const layer = Layer.effect(ProviderMcp, make);

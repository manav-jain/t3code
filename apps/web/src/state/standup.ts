import { type EnvironmentId, type StandupSummary, WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/unstable/reactivity";
import { create } from "zustand";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentThreadShells } from "./threads";

/** Changes only when a thread's standup facts do, so an open day refetches as work moves. */
const standupActivityAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    get(environmentThreadShells.threadShellsAtom)
      .filter((thread) => thread.environmentId === environmentId)
      .map((thread) =>
        [
          thread.id,
          thread.latestTurn?.turnId,
          thread.latestTurn?.state,
          thread.settledOverride,
          thread.hasPendingApprovals,
          thread.hasPendingUserInput,
          thread.session?.status,
          thread.pullRequests.map((pullRequest) => pullRequest.snapshot?.state).join(","),
        ].join(":"),
      )
      .join("|"),
  ).pipe(Atom.withLabel(`web-standup-activity:${environmentId}`)),
);

/** A day's threads. Past days are history and never refetch on their own. */
export const standupDay = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:standup:day",
  tag: WS_METHODS.standupGetDay,
  idleTtlMs: 5 * 60_000,
  refreshTrigger: ({ environmentId, input }) =>
    Date.parse(input.to) > Date.now() ? standupActivityAtom(environmentId) : undefined,
});

export const standupGenerate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:standup:generate",
  tag: WS_METHODS.standupGenerate,
});

export interface DayStandup {
  readonly status: "generating" | "ready" | "failed";
  readonly summary: StandupSummary | null;
  readonly error: string | null;
}

export const standupKey = (environmentId: EnvironmentId, from: string) =>
  `${environmentId}|${from}`;

/**
 * Written standups for the app session, by environment and day: revisiting a
 * day shows its standup again, and the page compares the summary's key with the
 * live day to tell when it is out of date.
 */
export const useStandupStore = create<{
  readonly byDay: Readonly<Record<string, DayStandup>>;
  readonly update: (key: string, next: DayStandup) => void;
}>()((set) => ({
  byDay: {},
  update: (key, next) => set((state) => ({ byDay: { ...state.byDay, [key]: next } })),
}));

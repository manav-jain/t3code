import { type EnvironmentId, type StandupSummary, WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { create } from "zustand";

import { connectionAtomRuntime } from "../connection/runtime";

export const standupGenerate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:standup:generate",
  tag: WS_METHODS.standupGenerate,
});

export interface EnvironmentStandup {
  /** Local day and thread buckets the latest request was made from. */
  readonly dayStart: number;
  readonly key: string;
  readonly status: "generating" | "ready" | "failed";
  readonly summary: StandupSummary | null;
  readonly error: string | null;
}

/**
 * Summaries live for the app session: reopening the page keeps them, and the
 * page compares `key` with the live buckets to tell when one is out of date.
 */
export const useStandupStore = create<{
  readonly byEnvironment: Readonly<Record<EnvironmentId, EnvironmentStandup>>;
  readonly update: (environmentId: EnvironmentId, next: EnvironmentStandup) => void;
}>()((set) => ({
  byEnvironment: {},
  update: (environmentId, next) =>
    set((state) => ({ byEnvironment: { ...state.byEnvironment, [environmentId]: next } })),
}));

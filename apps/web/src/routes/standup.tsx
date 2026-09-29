import { createFileRoute } from "@tanstack/react-router";

import { StandupPage } from "../components/standup/StandupPage";
import { isStandupDay } from "../components/standup/standup.logic";

export const Route = createFileRoute("/standup")({
  /** `day` picks a past day; without it the page shows today. */
  validateSearch: (raw: Record<string, unknown>): { day?: string } =>
    isStandupDay(raw.day) ? { day: raw.day } : {},
  component: StandupPage,
});

import { createFileRoute } from "@tanstack/react-router";

import { StandupPage } from "../components/standup/StandupPage";

export const Route = createFileRoute("/standup")({
  component: StandupPage,
});

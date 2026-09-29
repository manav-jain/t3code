import { describe, expect, it } from "vite-plus/test";

import { dayLabel, dayWindow, isStandupDay, localDay, shiftDay } from "./standup.logic";

describe("standup days", () => {
  it("steps across month and year ends", () => {
    expect(shiftDay("2026-09-30", 1)).toBe("2026-10-01");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDay("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("spans local midnight to the next local midnight", () => {
    const window = dayWindow("2026-09-24");
    expect(localDay(new Date(window.from))).toBe("2026-09-24");
    expect(localDay(new Date(window.to))).toBe("2026-09-25");
    expect(new Date(window.from).getHours()).toBe(0);
    expect(new Date(window.to).getHours()).toBe(0);
  });

  it("accepts only real calendar days from the URL", () => {
    expect(isStandupDay("2026-09-24")).toBe(true);
    expect(isStandupDay("2026-02-30")).toBe(false);
    expect(isStandupDay("2026-9-24")).toBe(false);
    expect(isStandupDay(20260924)).toBe(false);
  });

  it("names nearby days", () => {
    expect(dayLabel("2026-09-25", "2026-09-25")).toBe("Today");
    expect(dayLabel("2026-09-24", "2026-09-25")).toBe("Yesterday");
    expect(dayLabel("2026-09-20", "2026-09-25")).not.toMatch(/Today|Yesterday|2026/u);
    expect(dayLabel("2025-12-31", "2026-09-25")).toMatch(/2025/u);
  });
});

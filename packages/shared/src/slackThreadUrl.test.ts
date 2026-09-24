import { describe, expect, it } from "vite-plus/test";

import { parseSlackThreadUrl } from "./slackThreadUrl.ts";

describe("parseSlackThreadUrl", () => {
  it("reads a message permalink as the thread it starts", () => {
    expect(
      parseSlackThreadUrl("https://acme.slack.com/archives/C0123ABC/p1712345678123456"),
    ).toEqual({ channelId: "C0123ABC", threadTs: "1712345678.123456" });
  });

  it("reads a reply permalink as its parent thread", () => {
    expect(
      parseSlackThreadUrl(
        "https://acme.enterprise.slack.com/archives/C0123ABC/p1712345999000001?thread_ts=1712345678.123456&cid=C0123ABC",
      ),
    ).toEqual({ channelId: "C0123ABC", threadTs: "1712345678.123456" });
  });

  it.each([
    "not a url",
    "http://acme.slack.com/archives/C0123ABC/p1712345678123456",
    "https://slack.com.evil.test/archives/C0123ABC/p1712345678123456",
    "https://acme.slack.com/archives/C0123ABC",
    "https://acme.slack.com/archives/c0123abc/p1712345678123456",
    "https://acme.slack.com/archives/C0123ABC/1712345678123456",
    "https://acme.slack.com/client/T1/C0123ABC",
  ])("rejects %s", (input) => {
    expect(parseSlackThreadUrl(input)).toBeNull();
  });
});

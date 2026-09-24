/** A Slack thread as a thread link names it: the channel and the parent message's timestamp. */
export interface SlackThreadKey {
  readonly channelId: string;
  readonly threadTs: string;
}

const CHANNEL_ID = /^[A-Z0-9]+$/;
const PERMALINK_TS = /^p(\d+)(\d{6})$/;
const MESSAGE_TS = /^\d+\.\d{6}$/;

/**
 * The thread behind a Slack message permalink (`https://<team>.slack.com/archives/<channel>/p<ts>`),
 * or null for anything else. A reply's permalink carries its parent as `thread_ts`, so it names
 * the same thread as the parent's own permalink.
 */
export function parseSlackThreadUrl(input: string): SlackThreadKey | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".slack.com")) return null;
  const [archives, channelId, message] = url.pathname.split("/").filter(Boolean);
  const ts = message === undefined ? null : PERMALINK_TS.exec(message);
  if (archives !== "archives" || channelId === undefined || !CHANNEL_ID.test(channelId) || !ts) {
    return null;
  }
  const parent = url.searchParams.get("thread_ts");
  return {
    channelId,
    threadTs: parent !== null && MESSAGE_TS.test(parent) ? parent : `${ts[1]}.${ts[2]}`,
  };
}

export function slackThreadKeysEqual(left: SlackThreadKey, right: SlackThreadKey): boolean {
  return left.channelId === right.channelId && left.threadTs === right.threadTs;
}

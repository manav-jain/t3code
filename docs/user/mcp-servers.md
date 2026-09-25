# MCP servers

On web and desktop, open **Settings → Providers**, pick an environment, and select a Claude or
Codex instance. **MCP servers** lists the servers that instance connects to on its own, from the
user config in its home, with each one's status. Claude reports live health; Codex reports whether
a server is configured, disabled, or signed in. Servers defined in a project's own config are not
listed. Cursor, Grok, Antigravity, and OpenCode do not show this section.

- **Add server** saves a remote URL or a local command to the instance's user config, so every
  session it runs can use it. Remove takes it out again.
- **Sign in** appears when a server needs it; **Sign in again** and **Sign out** are in the row's
  menu. Sign-in opens the server's page in your browser and finishes on its own once you approve
  access. When the environment runs on another machine, the last page can fail to load because it
  points at that machine's `127.0.0.1`. Copy that page's full address and paste it into the field
  under the server to finish.

claude.ai connectors belong to your Claude account. You can sign in to them here, but you add and
remove them on claude.ai.

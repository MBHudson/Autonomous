<!--
  Copyright M. Bryce Hudson 2026-2029 All Rights Reserved

  Unauthorized reproduction, distribution, or transmission of the work is prohibited without prior written permission, with exceptions for brief quotations and specific noncommercial uses under copyright law.

  BryceFromIndiana@gmail.com
-->

# Connecting to my Loop Studio (MCP)

This lets your own agent / local model use tools that run on **my** server —
reading files, searching the web, and (if I gave you the scope) writing files
and running commands. It speaks **MCP** (Model Context Protocol), so most
clients "just work".

## What I'll send you

- **URL:** `https://YOUR-HOST/path/to/router/api/mcp-server`
- **Your token:** `paste-the-token-your-friend-gave-you`

That token is **yours alone** — I can revoke only you, any time. It never
expires. Do not share it.

## What tools you get

It depends on the scope I put on your token:

- **read** — `read_file`, `list_dir`, `glob_files`, `grep_code`, `stat`,
  `fetch_url`, `web_search`, `git_read` (status/diff/log/…).
- **write** — `write_file`, `edit_file`, `insert`, `apply_patch`, `multi_edit`.
- **exec** — `exec` (run a command), `run_code` (Python/Node/bash),
  `git_commit`.

Everything you touch is jailed to a **scratch folder** on my side, and I can
require my approval before commands run.

## Option A — your client supports remote MCP (HTTP)

Add a "remote MCP server" pointing at the URL, with one header:

```
Authorization: Bearer <your token>
```

## Option B — your client is stdio-only (e.g. Claude Desktop)

Bridge it with `mcp-remote`:

```bash
npx -y mcp-remote https://YOUR-HOST/path/to/router/api/mcp-server \
  --header "Authorization: Bearer <your token>"
```

Then point the client at that local command as a normal stdio MCP server.

## Option C — you also run a copy of Loop Studio

In your copy: **Config → MCP Client → + ADD SERVER**

- **name:** `friend-host`
- **transport:** `http`
- **url:** `https://YOUR-HOST/path/to/router/api/mcp-server`
- **headers:** `Authorization: Bearer <your token>`

Then your agents can reach my tools with `mcp_list` / `mcp_call`.

## A couple of ground rules

- Keep the token private; tell me if you think it leaked and I'll rotate it —
  the moment I do, the old one stops working and you get the new one from me.
  I can't look yours up and re-send it: it is stored on my side and never shown
  again, so a lost token is always replaced, not re-read.
- Files you create land in your own scratch folder, not my app.
- If a command comes back saying it is "waiting for the operator", that's me —
  I'll approve it and you can retry.

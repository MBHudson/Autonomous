## What this changes

<!-- One or two sentences. Why, not just what. -->

## Which part

- [ ] Tools / sandbox (`src/Sandbox.php`, `ui/js/tools.js`)
- [ ] Providers / harness / dialects (`src/Harness.php`, `ui/js/harness.js`)
- [ ] Agents / routing / Always-On (`ui/js/brainlab.js`, `alwaysOn.js`)
- [ ] Interface (`ui/js/desktop2026.js`, `ui/css/…`)
- [ ] Browser / DevTools (`src/Cdp.php`, `src/Browser.php`)
- [ ] MCP (`src/Mcp.php`, `src/McpServer.php`)
- [ ] Install / launcher / updates (`install-update.php`, `start.*`, `setup-*`)
- [ ] Docs only
- [ ] Something else

## How it was checked

<!-- The command you ran and what it said. "node tests/run.mjs" plus the last line is enough. -->

```
```

- [ ] `node tests/run.mjs` passes (or: PHP only, JS only — say which)
- [ ] I added or updated a test for this, where a test can reach it
- [ ] I tried it on a real install, not just the suite

## The promises

<!-- This project's whole point is the constraint. Please be honest rather than polite. -->

- [ ] No new runtime dependency, no build step, no `package.json` the app needs
- [ ] No Docker requirement, no cloud service, no account
- [ ] Anything dangerous is still off by default, and still asks first
- [ ] `storage/` and `tests/` are still refused by every serving mode this touches (`serve.php`, `.htaccess`, `nginx.example.conf`)

## Sign-off

- [ ] Every commit has a DCO sign-off (`git commit -s`) — see [CONTRIBUTING.md](../CONTRIBUTING.md)

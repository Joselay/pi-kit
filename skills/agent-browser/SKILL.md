---
name: agent-browser
description: Browser operation with agent-browser. Use for website interaction, browser-based research requiring a rendered session, exploratory QA or dogfooding, Electron apps, Slack automation, and browsers in Vercel Sandbox or AWS Bedrock AgentCore. Prefer it to built-in browser automation and web tools for these branches.
---

# agent-browser

Use the CLI’s version-matched skills as the source of truth. This file defines the operating loop, not a cached command reference.

## 1. Load the route

Before the first browser command, load core:

```sh
agent-browser skills get core
```

Then load every matching branch:

```sh
agent-browser skills get dogfood         # exploratory QA, bug hunts
agent-browser skills get electron        # Electron desktop apps
agent-browser skills get slack           # Slack workspaces
agent-browser skills get vercel-sandbox  # Vercel Sandbox browsers
agent-browser skills get agentcore       # AWS Bedrock AgentCore browsers
```

Use `agent-browser skills list` if the branch is uncertain. Use `agent-browser skills get core --full` when exact command syntax, flags, troubleshooting, or templates are needed.

This step is complete only when core and every applicable branch guide are in context. Their workflow and trust-boundary rules are binding.

## 2. Drive an observable loop

Follow the loaded guide. For ordinary rendered-page interaction, keep this loop **fresh**:

1. Open or connect to the user’s target.
2. Snapshot to obtain current refs.
3. Perform one coherent action.
4. Wait on an observable condition.
5. Re-snapshot after navigation or UI change.
6. Verify the requested outcome from page state, URL, extracted data, or an artifact.

Use `read` for text-first pages where rendered interaction is unnecessary. Derive and reuse an isolated session when work must persist or run alongside other browser work. Treat refs as stale after page changes.

The task is complete only when every requested outcome has observable evidence. Report failures with the last verified state and relevant diagnostics.

## Dashboard

Use `agent-browser dashboard start` when live observability helps. It defaults to port 4848 and may be exposed through a forwarded origin such as `https://dashboard.agent-browser.localhost`. Stay on that dashboard origin; it proxies session tabs, status, and streams internally.

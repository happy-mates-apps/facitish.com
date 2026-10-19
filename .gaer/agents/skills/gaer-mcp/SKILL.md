---
name: gaer-mcp
description: The two MCP servers in Gær — /mcp for the app (acts as the user, own data) and /mcp/admin for admin (admin role, every change is a draft). Use when adding or changing an MCP tool, the OAuth flow, drafts or deep links.
---

# MCP servers (gaer-mcp)

Contract: `specs/mcp/SPEC.md`. Tools: `specs/mcp/catalog.json` — add a tool there first; a test fails if
the registered tools and the catalog differ. Code: `server/app/mcp/`.

| | `/mcp` | `/mcp/admin` |
|---|---|---|
| Who | full session | `role = 'admin'`, not a test account, not impersonating |
| Data | caller's own rows only | whole instance |
| Writes | own data directly; delete/export → draft | always draft → `confirm_draft` |

## Files
| File | What |
| --- | --- |
| `oauth.py` | well-known metadata, `/mcp/register`, `/mcp/authorize` → `/forbind` (consent), `/mcp/token`; a client is a `sessions` row (`mcp_client_id`, `mcp_scope`), so /konto, block and revoke end it |
| `transport.py` | Streamable HTTP with the `mcp` SDK (pinned); bearer → `Caller` on the ASGI scope; role re-checked per request |
| `registry.py` | loads `catalog.json` (copy of the spec's), `@tool` / `@draft`, `invoke()` — the one entry point, logs to `mcp_log` |
| `drafts.py` | `mcp_drafts`, `confirm_draft` / `cancel_draft` / `list_drafts`; confirm re-plans and compares `state_hash` |
| `app_server.py`, `admin_server.py`, `db_tools.py` | the tools; `db_query` runs as `<db>_mcp_ro` (`MCP_DB_QUERY_URL`) |
| `links.py`, `app_map.json` | deep links `/go?path=…&focus=…` / `/admin/go`, only if path + anchor are in the map |
| `hub.py` | `/api/admin/mcp/*` for the hub at `/admin/mcp` (overview, tools, invoke, drafts, events, SSE stream) |

## Adding a tool
- Add it to `specs/mcp/catalog.json` and copy the file to `server/app/mcp/catalog.json`.
- Read or write tool: `@tool("app", "name") async def run(args, caller) -> ToolOutput(data, links, text)`.
  App tools filter on `caller.user_id`; writes call `audit()` in the same transaction.
- Draft tool: `@draft("admin", "name") async def plan(args, caller, conn) -> DraftPlan(summary, impact, state, execute)`.
  `plan` must not change anything; `execute(conn)` runs in the confirm transaction next to the audit row.
- Raise `ToolError("…")` for a Danish message to the user. Names and descriptions are English.
- Give it a `link` in the catalog when a screen exists, add the `data-deeplink` anchor on that screen and run
  `npm run app-map --prefix web` (the build fails with `--check` when a catalog link has no anchor).

## Never
- A new login path — MCP authorizes through the normal phone + code + passkey login.
- App tools that read or write another user's rows.
- Tools that grant admin to yourself, write SQL, touch log tables or return a session token.

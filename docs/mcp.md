# MCP service

Nuntia can expose its mail, contacts and triage actions to an AI agent over the
[Model Context Protocol](https://modelcontextprotocol.io). The MCP endpoint is a
**separate process** from the web app — not a route inside it. It reads the same
SQLite database and uses the same service layer, so ownership checks, state
overrides and reply composition behave exactly as they do in the browser.

## Why a separate service

- The app is a browser client for one person. An MCP endpoint is a long-running
  HTTP service for an agent, with its own lifecycle and its own attack surface.
  Not starting it leaves the app completely unchanged.
- It uses the app's own session table for authentication rather than inventing a
  second token store.
- It can be stopped, restarted or firewalled off without touching the inbox.

## Start it

```bash
# from the repository, with the same .env/DATABASE_URL as the app
bun run mcp
```

| Variable               | Default                | Meaning                                                     |
| ---------------------- | ---------------------- | ----------------------------------------------------------- |
| `MCP_HOST`             | `127.0.0.1`            | Bind address. Loopback by default on purpose.               |
| `MCP_PORT`             | `3333`                 | Port. The endpoint is `/mcp`.                               |
| `DATABASE_URL`         | `file:./data/lumen.db` | Same database as the app.                                   |
| `TOKEN_ENCRYPTION_KEY` | —                      | Same key as the app; needed to decrypt stored OAuth tokens. |

`GET /healthz` answers `{"ok":true}` without authentication, for a supervisor.
Everything else requires a bearer credential.

> The MCP service does not run a sync. It reads and writes the mail the app has
> already synced, so start the app and let it sync a mailbox first.

## Authentication

No cookie copying and no separate login. In the app, open **Settings → AI
agents**, pick a label for the agent and press **Create token**. The page shows
the token once, together with the exact Claude Code command and JSON config
already filled in — copy whichever your client needs.

Send the token as:

```
Authorization: Bearer mcp_<id>.<secret>
```

The service looks the token up on **every request**, so pressing **Revoke** in
the same section cuts that agent off immediately. Tokens do not expire and are
not tied to a browser session; each one can be revoked on its own. Only a
SHA-256 of the secret is stored, which is why the value is shown once.

A `lumen_session` cookie value still works as a bearer credential, for an
existing setup that already uses one. It is checked against the `sessions` table
and expires on the browser's schedule; the MCP service does not extend it.

Do not bind the service to a public interface. A token is a credential for the
whole mailbox, and this endpoint has no separate rate limiting.

## Connect a client

Claude Code (the Settings page generates this with the real token filled in):

```bash
claude mcp add --transport http nuntia http://127.0.0.1:3333/mcp \
  --header "Authorization: Bearer mcp_<id>.<secret>"
```

Cursor, VS Code, Vibe and other clients that take a JSON config:

```json
{
  "mcpServers": {
    "nuntia": {
      "url": "http://127.0.0.1:3333/mcp",
      "headers": {
        "Authorization": "Bearer mcp_<id>.<secret>"
      }
    }
  }
}
```

Claude Desktop speaks stdio to local servers. Bridge it with
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "nuntia": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://127.0.0.1:3333/mcp",
        "--header",
        "Authorization: Bearer mcp_<id>.<secret>"
      ]
    }
  }
}
```

Restart the client after changing the configuration; the tool list is read at
startup.

## Tools

Read-only (`readOnlyHint: true`):

| Tool                 | What it does                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `list_threads`       | Threads filtered by state, folder, correspondent, tag or free text; defaults to the inbox, 25 rows |
| `get_thread`         | One thread: messages, participants, attachments, topic, goal, state, contact context               |
| `search_mail`        | The inbox search across every folder                                                               |
| `get_person`         | A correspondent's context notes, tags and recent threads                                           |
| `list_tags`          | The tag vocabulary, with how many people carry each tag                                            |
| `list_states`        | The four states, with the user's own wording                                                       |
| `list_organizations` | Organisation labels and their matching rules                                                       |

Writes:

| Tool                  | What it does                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `move_thread`         | Sets the user's state override and/or moves the thread between inbox, archive, trash and spam |
| `update_person_tags`  | Adds/removes tags on a person (tags belong to a correspondent, not a thread)                  |
| `update_person_notes` | Updates the user's notes about a person; only the fields supplied change                      |
| `draft_reply`         | Generates reply text and returns it; nothing is stored or sent                                |
| `send_reply`          | Sends through the mailbox that owns the thread; requires `confirm: true`                      |

`draft_reply` cannot insert text into the browser composer — the agent runs in a
different process from the open tab — so it returns the draft for the agent to
show you. `send_reply` will not act on a single call: the user has to approve the
exact body, and the tool refuses unless it is called again with `confirm: true`.
That is a second lock on top of the MCP client's own tool-approval prompt.

## Privacy

- The service is loopback-only by default and talks to nothing but the local
  database. There is no analytics, no telemetry, and no provider traffic except
  the reply you explicitly send.
- An agent sees exactly what the tools return. Narrow the context by asking for
  one thread or one person rather than dumping the inbox.
- Write actions are recorded in the same tables the UI writes: a state override,
  a tag row, a contact note. They appear in the app and can be undone there.
- Nothing about the app's privacy guarantees changes. If you would not paste the
  mail into the agent's chat window, do not ask the agent to fetch it.

## Docker

The Compose stack includes `mcp` by default:

```bash
docker compose up -d
```

Every deploy builds the `mcp` stage of the Dockerfile, recreates the container
and waits for its `/healthz` before reporting success. It mounts the same
`lumen-data` volume and publishes port 3333 on loopback only. MCP starts after
the app is healthy, so it never races the app's migration runner.

Both the app and MCP process open the same SQLite file, which is safe for the
light read/write this service does but is exactly the multi-process limitation
tracked in the Postgres migration. Do not run this stack across several hosts
until that work lands.

## Limitations

- Stored mail only: the MCP service does not sync, backfill or search the
  provider directly. Run the app's **Re-sync** if something is missing.
- No attachment contents. `get_thread` returns attachment metadata, not bytes.
- No full-text index. `search_mail` uses the inbox matcher over what is stored.
- No resources or prompts; tools only.

# Splitting Nuntia into services

Today Nuntia ships two containers: the web app and the MCP endpoint, with a
static landing page on its own hostname. That is already the shape this
document argues for — one process per responsibility, each in its own container,
sharing a Docker network and nothing else.

The goal is not microservices. It is: **every part can be started, stopped,
upgraded and firewalled on its own, without the others knowing how it is
implemented.** The rules below are what makes that true as more parts are
extracted.

## The rule everything else follows

Containers share exactly three things:

1. **The network**, through service names resolved by Docker DNS
   (`http://app:3000`, `http://mcp:3333`), never `localhost`.
2. **Named volumes**, one owner per volume. A volume is shared only when the
   data is genuinely shared, and SQLite is the case where "genuinely shared"
   has a catch (see [One database, one writer](#one-database-one-writer)).
3. **The environment contract** — the variables in `.env`, listed per service in
   the table below.

They do **not** share source, `node_modules`, a working directory, or a
migration runner. A service that needs the database gets a connection string;
a service that needs another service gets a URL. Everything else is a
dependency the container should not have.

## What can be a service

| Service   | What it is now                                     | Entry point               | Port |
| --------- | -------------------------------------------------- | ------------------------- | ---- |
| `app`     | TanStack Start SSR + static assets + all sync      | `src/server.ts`           | 3000 |
| `mcp`     | Stateless Streamable HTTP MCP endpoint             | `src/mcp/server.ts`       | 3333 |
| `landing` | Static page, separate project under `landing/`     | nginx                     | 80   |
| `worker`  | Sync, polling and background work (**to extract**) | _does not exist yet_      | —    |
| `jobs`    | Backup, prune, reports, password reset             | `scripts/*.ts` (one-shot) | —    |

Anything that is request/response and stateless ("render this page", "answer
this MCP call", "serve this file") splits cleanly. Anything that owns time
("sync every mailbox every N minutes", "back up at 03:00") needs a single owner,
which is why sync is the first real extraction and not a second app replica.

## Target topology

```
              ┌─────────────┐
   :443 ─────▶│   proxy     │  (bring your own: nginx, Caddy, Traefik)
              └──┬───────┬──┘
                 │       │
      mail.example.com   example.com
                 │       │
            ┌────▼───┐ ┌─▼────────┐
            │  app   │ │ landing  │
            └─┬──┬───┘ └──────────┘
              │  │
     internal │  │ internal
              │  └────────────▶ ┌───────┐
              │                 │  mcp  │  (loopback / internal only)
              ▼                 └───┬───┘
        ┌──────────┐                │
        │  worker  │────────────────┤
        └────┬─────┘                │
             │                      │
             ▼                      ▼
        ┌──────────────────────────────┐
        │  DATABASE_URL (shared)       │
        │  file: volume  or  libSQL    │
        └──────────────────────────────┘
```

Only the proxy is public. `app`, `mcp`, `worker` and the database are reachable
only from the compose network; the ports in `docker-compose.yml` exist so you
can curl them from the host during development, not as the production design.

## Conventions for every service

These are the rules that keep N containers from turning into N one-off setups.

- **One image, many targets.** Extend the existing multi-stage `Dockerfile`
  (`app` is the default, `mcp` is a target). A new service is a new stage, not a
  new Dockerfile, so all services resolve the same dependency graph and the
  same Bun version — the reason `mcp` already shares the builder's lockfile.
- **The image carries no configuration.** Secrets and URLs arrive as
  environment at run time, exactly as `app` does today with `env_file: .env`.
  Anything baked in at build time (`landing`'s `PUBLIC_APP_URL`) is documented
  as needing a rebuild, not a restart.
- **Container port is fixed; host port is not.** Each service binds a constant
  internal port (`3000`, `3333`, `80`) and publishes a host port only when a
  human or the proxy needs it.
- **Declare what you need, nothing more.** `mcp` gets no Google or Microsoft
  credentials. A worker gets mail credentials but no session cookie secret.
  Least privilege here is just a short `environment:` block.
- **Health checks are part of the contract.** `mcp` already answers
  `GET /healthz` without auth. Give every service one, and have dependants use
  `depends_on: { condition: service_healthy }` rather than a fixed sleep.
- **Logs to stdout, state to the volume.** The app additionally writes
  `data/logs/app.log`; new services should log JSON lines to stdout and let
  Docker collect them, so `docker compose logs worker` works without a mount.
- **Name the stack.** Use `name:` in the compose file and a shared `networks:`
  entry so two checkouts on one machine do not collide on network names.
- **Profiles for genuinely optional parts.** Nothing is optional in today's
  deployment: `mcp` starts with the stack and is health-gated on the app. If a
  future service should not run by default, put it behind `profiles: [...]`;
  then `docker compose up -d` stays the product and the profile adds the extras.

## Environment contract

Every variable a service reads, and who owns it:

| Variable                                                                                   | app | worker | mcp | landing | Notes                                         |
| ------------------------------------------------------------------------------------------ | :-: | :----: | :-: | :-----: | --------------------------------------------- |
| `DATABASE_URL`                                                                             |  ✓  |   ✓    |  ✓  |         | Same value in every service                   |
| `DATABASE_AUTH_TOKEN`                                                                      |  ✓  |   ✓    |  ✓  |         | Only for remote libSQL                        |
| `TOKEN_ENCRYPTION_KEY`                                                                     |  ✓  |   ✓    |  ✓  |         | Must match, or stored tokens are unreadable   |
| `LUMEN_APP_URL`                                                                            |  ✓  |        |     |         | Public origin for invites and OAuth callbacks |
| `GOOGLE_*`, `MICROSOFT_*`, `GOOGLE_PUBSUB_TOPIC`, `GMAIL_PUSH_TOKEN`                       |  ✓  |   ✓    |     |         | OAuth and push                                |
| `LUMEN_ACCESS_MODE`, `LUMEN_ADMIN_EMAILS`, `LUMEN_BOOTSTRAP_INVITE`, `LUMEN_INVITE_SENDER` |  ✓  |        |     |         | Access and beta                               |
| `LUMEN_DEFAULT_USER_*`                                                                     |  ✓  |        |     |         | First boot only                               |
| `MCP_HOST`, `MCP_PORT`                                                                     |     |        |  ✓  |         | `0.0.0.0` inside the container                |
| `APP_LOG_DIR`, `BACKUP_DIR`, `BACKUP_KEEP`                                                 |  ✓  |   ✓    |     |         | Paths inside the volume                       |
| `PUBLIC_APP_URL`                                                                           |     |        |     |  build  | Build arg, not runtime                        |

Two entries do the real work of holding the system together:
`TOKEN_ENCRYPTION_KEY` decrypts every stored OAuth refresh token and AI key, and
`DATABASE_URL` points at the same rows. A service with one but not the other is
either unable to read mail or unable to find it.

## One database, one writer

`data/lumen.db` is a file, and a file cannot be mounted into two hosts. Even on
one host, SQLite tolerates exactly the concurrency the code asks for
(`journal_mode=WAL`, `busy_timeout=5000` in `src/db/index.ts`), not a second
writer running a full sync.

So, in order of preference:

1. **Move to a remote libSQL endpoint** and set `DATABASE_URL` +
   `DATABASE_AUTH_TOKEN` in every service. This is the change that unlocks
   multiple containers on multiple machines and the Postgres migration noted in
   the MCP docs is the same direction. Nothing else in this document works at
   scale until it lands.
2. **Stay on the file, but with one writer.** `app` and `worker` on the same
   volume is the limit; two app replicas or two workers is not. Keep `mcp`
   read-mostly, as it is today.
3. **Never** point two containers at the same file over NFS or a bind mount
   from different hosts. SQLite's locking is not reliable there and the failure
   mode is a corrupted database, not an error.

### Migration ownership

`initDatabase()` currently runs `migrate()` and the repair/backfill steps on
every boot, because a single process was the only thing booting. With three
services starting together that is three migration runners racing on the same
file.

Give migrations exactly one owner:

- a one-shot `migrate` service that runs before the others, or
- the `app` alone, with a `LUMEN_SKIP_MIGRATIONS=1` flag that the other
  services set and `initDatabase()` honours (this flag does not exist yet — it
  is the small code change this split needs).

Apply the same rule to the one-off repairs (`rebuildUserCascades`,
`backfillMatchColumns`): one run, one process, and the others wait for the
schema to be ready rather than repairing it.

## Extracting the sync worker

Sync is the one genuinely new service. It is also the least separable today:
`runSync` lives in `src/lib/gmail/service.ts` and is started fire-and-forget
from request handlers. Nothing polls on a timer, so the app _is_ the worker.

The extraction is mechanical once the seam exists:

1. **Add an entry point**, `src/worker.ts`, that owns the loop: find accounts due
   for a poll or with queued push notifications, run `runSync` for each, repeat.
   It imports the same `src/lib/mailbox`, `src/lib/gmail` and
   `src/lib/microsoft` modules the app imports — the provider adapters are
   already the seam, which is why this is a move and not a rewrite.
2. **Add a `worker` stage** to the `Dockerfile`, copying `src` and `drizzle` the
   way the `mcp` stage does, with no client build and no HTTP port.
3. **Make it the only sync owner.** Request handlers should enqueue a hint
   ("sync this account soon") instead of calling `runSync` directly, otherwise
   the app and the worker both sync the same mailbox.
4. **Add a lease.** Two workers must never claim the same account. A
   `sync_leases` table (account id, owner, expires_at) taken with a conditional
   `UPDATE ... WHERE expires_at < now` is enough, and it is what makes the
   service restart-safe: a crashed worker's lease expires instead of blocking
   the account forever.
5. **Do not give it a port.** It talks to the database and the providers, and
   writes `data/logs` if it wants the app's format. If it needs an internal
   health endpoint for the supervisor, expose one on an unpublished port.

Until step 3 is done, run exactly one worker and no others. The container is not
what makes a service; the single ownership is.

## Adding a new service: checklist

1. Can it be described in one sentence, with one entry point? If not, it is two
   services or none.
2. Which state does it own? If the answer is "a table the app also writes",
   define the ownership boundary first, not the container.
3. Add the stage to the `Dockerfile` (same builder, same lockfile).
4. Add the compose service: `profiles`, `env_file`, a minimal `environment`,
   `depends_on` with health, and `restart: unless-stopped`.
5. Add a health endpoint and a `healthcheck` (use `curl -fsS` or a small
   `bun -e` probe; the slim image has no curl by default — `mcp`'s `/healthz`
   is the model).
6. Add its variables to `.env.example` and to the contract table above.
7. Add the failure notes: what breaks when it is down, and whether the product
   degrades or stops. A service whose absence breaks the inbox is not optional
   and should not be behind a profile.

## Anti-patterns

- **A second app replica sharing the SQLite file.** Two writers, no coordination,
  and a corrupt database is the likely outcome. Replicas need the remote
  database first.
- **`depends_on` without a health check.** It orders `create`, not readiness;
  the dependent will still hit a socket that is not listening yet.
- **Baking URLs or keys into images.** Ports and hostnames change between
  environments; the `landing` build arg is the one deliberate exception and it
  is documented as requiring a rebuild.
- **One `.env` per service with slightly different values.** The shared keys
  must be identical across services; keep one file and let each service read
  the subset it needs.
- **Using `localhost` between containers.** Inside a container, `localhost` is
  that container. Service name, always.
- **Publishing `mcp` on a public interface.** It is authenticated by a session
  cookie, i.e. a credential for the whole mailbox. If the proxy must route to
  it, restrict the path and put auth in front; do not change `MCP_HOST` to
  `0.0.0.0` on the host network and call it done.

## Phases

| Phase | Change                                                 | Result                                     |
| ----- | ------------------------------------------------------ | ------------------------------------------ |
| 0     | Today: `app` + `mcp` + `landing`                       | One host, one writer                       |
| 1     | Remote `DATABASE_URL`; migrations owned by one service | Services can be on different hosts         |
| 2     | Extract `worker` with a lease and an enqueue seam      | App restarts no longer interrupt sync      |
| 3     | Split the proxy out, stop publishing internal ports    | Only the edge is reachable                 |
| 4     | One-shot `jobs` service (backup, prune) on a schedule  | Operator scripts stop needing shell access |

Each phase is useful on its own, and phase 1 is the prerequisite for almost
everything after it.

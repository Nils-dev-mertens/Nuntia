# Setting up Google integration

Lumen reads your Gmail through Google's OAuth 2.0 flow. This walks through creating the
credentials in Google Cloud and wiring them into the app.

It takes about ten minutes. The step order below is deliberate — the console buries the
setting you need, and doing them out of order produces errors that look unrelated to the
step that actually failed.

---

## What you need first

- A Google account
- [Node 22.12+](https://nodejs.org/en/download) (Bun also works and is what this repo uses)
- The project checked out, with dependencies installed

---

## 1. Create or pick a project

Open the [Google Cloud console](https://console.cloud.google.com/). If you have no project,
the console creates one for you and drops you into it. If you have several, use the
project picker at the top — **the credentials live inside a project**, so this choice
matters later.

---

## 2. Enable the Gmail API — do this before anything else

Left nav → **APIs & Services** → **Library** → search *Gmail API* → **Enable**.

This has to come first. The OAuth consent screen validates the scopes you request, and if
the Gmail API is not enabled yet it rejects them with `Invalid scopes`. That error does not
mention scopes being disabled, and it sends people looking in the wrong place.

---

## 3. Configure the OAuth consent screen

Left nav → **APIs & Services** → **OAuth consent screen**.

| Field | Value |
| --- | --- |
| User type | **External** |
| App name | `Lumen` (anything you like) |
| User support email | your own address |
| Developer contact email | your own address |

Then under **Test users** → **Add users** → add your own Google address.

**The test user step is not optional.** An app in *Testing* publishing status only lets the
listed accounts sign in. Anyone else gets an `access_denied` error that looks like a
credentials problem but is not.

On the Data Access page, add these three scopes:

```
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/userinfo.email
```

That set is deliberately minimal. There is no modify or delete scope, so a bug in Lumen
cannot destroy mail — the token physically cannot delete anything.

---

## 4. Create the OAuth client

Left nav → **APIs & Services** → **Credentials** → **Create credentials** → **OAuth client
ID**.

| Field | Value |
| --- | --- |
| Application type | **Web application** |
| Name | `Lumen local` |
| Authorized JavaScript origins | `http://localhost:3000` |
| Authorized redirect URIs | `http://localhost:3000/auth/google/callback` |

The redirect URI must match **exactly** — scheme, host, port and path, with no trailing
slash. A mismatch produces `redirect_uri_mismatch`, and Google does not say which part
differed.

When you're done, copy the **Client ID** and **Client secret**.

---

## 5. Configure the app

```bash
cp .env.example .env.local
```

Fill in `.env.local`:

```bash
DATABASE_URL="file:./data/lumen.db"

GOOGLE_CLIENT_ID="xxxxx.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="xxxxx"

TOKEN_ENCRYPTION_KEY="<see below>"
```

Generate the encryption key:

```bash
openssl rand -hex 32
```

`TOKEN_ENCRYPTION_KEY` is required and there is no default. Lumen encrypts your Gmail
refresh token with AES-256-GCM before it touches the database, and `encrypt()` throws
rather than falling back to a shared default key — a default would mean every install
encrypts with the same key.

`SESSION_SECRET` is optional: it falls back to `TOKEN_ENCRYPTION_KEY` so one generated key
is enough to run locally. Set it separately if you want session cookies to survive a change
of the encryption key.

---

## 6. Create the database and run

```bash
bun run db:migrate    # creates data/lumen.db from drizzle/
bun run dev
```

Open <http://localhost:3000> and click **Connect Gmail**.

---

## Verifying it worked

After signing in you should land on the inbox with conversations grouped by state. The
first run backfills the last 30 days (`newer_than:30d`), so a mailbox with recent mail
fills up within a few seconds; older mail arrives as the sync cursor moves forward.

Quick checks from the command line:

```bash
# Is the account row there, with a cursor?
sqlite3 data/lumen.db "select id, history_id from accounts;"

# How much landed?
sqlite3 data/lumen.db "select count(*), state from conversations group by state;"
```

---

## When things go wrong

| Symptom | Cause |
| --- | --- |
| `redirect_uri_mismatch` | Redirect URI differs from the registered one by a character, a slash, or the port |
| `Invalid scopes` on the consent screen | The Gmail API was not enabled first — go back to step 2 |
| `access_denied` | The app is in *Testing* status and you are not listed as a test user |
| Sign-in returns to a blank page | Session signing key changed mid-session; clear cookies and retry |
| `TOKEN_ENCRYPTION_KEY is not set` | Key missing or not 32 bytes — regenerate with `openssl rand -hex 32` |
| `Stored refresh token could not be decrypted` | The key changed after the token was stored. Sign out, delete `data/lumen.db`, sign back in |
| Sync stops after a week | Expected — see below |

### Refresh tokens expire after 7 days

An app in *Testing* publishing status issues refresh tokens that expire in **seven days**.
After that, sync fails with an `invalid_grant` error and Lumen will tell you the grant was
revoked.

Sign out and back in to get a fresh token. To avoid this entirely, publish the app to
*Production* on the consent screen — that requires a verification process for apps using
sensitive scopes, which is not worth it for a local tool.

### Gmail expires the sync cursor too

Independently of OAuth, Gmail discards history ids after about a week. `sync()` catches the
404 and re-backfills automatically, so this needs no action — it just means a long-dormant
account does a full 30-day backfill on its next load.

---

## Security notes

- The refresh token is encrypted **inside** `upsertAccount`, so the plaintext never crosses
  the persistence boundary.
- The session cookie holds only your account id, HMAC-signed. A stolen cookie grants nothing
  without the server's signing key.
- `data/lumen.db` contains your mailbox index. It is not encrypted as a whole — only the
  OAuth token inside it is — so treat the file as sensitive.
# Outlook setup

Lumen reads Outlook.com and Microsoft 365 mailboxes through **Microsoft Graph**.
This is the second provider behind the mailbox seam; Gmail keeps working exactly
as before, and one install can hold both.

The app only ever reads and sends. There is no delete, move or flag scope, so a
bug cannot destroy mail.

## 1. Register the app

1. Open [Entra admin centre → App registrations](https://entra.microsoft.com)
   and choose **New registration**.
2. Name it anything (`Lumen`). Under **Supported account types**, pick
   _Accounts in any organizational directory and personal Microsoft accounts_ —
   the `common` tenant in the next step expects that. If you only want one work
   tenant, pick that tenant instead and set `MICROSOFT_TENANT` to its id.
3. **Redirect URI**: platform _Web_, value
   `http://localhost:3000/auth/microsoft/callback`.
   Use your real origin in a deployment; it must match
   `MICROSOFT_REDIRECT_URI` exactly.
4. **Certificates & secrets → New client secret**. Copy the _value_ immediately —
   Entra never shows it again.
5. **API permissions → Add a permission → Microsoft Graph → Delegated**:
   `Mail.Read`, `Mail.Send`, `User.Read`, and `offline_access`.
   `offline_access` is what makes the refresh token exist; without it every sync
   would need a browser.

## 2. Configure

```bash
MICROSOFT_CLIENT_ID="..."
MICROSOFT_CLIENT_SECRET="..."
MICROSOFT_TENANT="common"
```

Restart the dev server, then use **Connect Outlook** on the inbox or in
Settings. The redirect lands on `/auth/microsoft/callback`, which stores the
refresh token encrypted with `TOKEN_ENCRYPTION_KEY` — the same envelope Gmail
accounts use.

## What the integration does

| Step        | Graph call                                                                       |
| ----------- | -------------------------------------------------------------------------------- |
| Backfill    | `GET /me/messages` filtered to the last 30 days, grouped by `conversationId`     |
| Thread      | `GET /me/messages?$filter=conversationId eq …` with attachment metadata expanded |
| Incremental | `GET /me/messages?$filter=receivedDateTime ge <cursor>`                          |
| Attachment  | `GET /me/messages/{id}/attachments/{id}`                                         |
| Reply       | `POST …/createReply`, `PATCH` the draft body, upload attachments, `POST …/send`  |
| Profile     | `GET /me?$select=mail,userPrincipalName,displayName`                             |

The incremental cursor is an **ISO timestamp**, not Gmail's history id. Graph's
delta endpoints would also work, but establishing a `deltaLink` means enumerating
the mailbox once; a `receivedDateTime` filter catches new mail — including a new
message in an old conversation — in one page, which is the case the app cares
about. A stored cursor that is not an ISO timestamp is refused and the next sync
falls back to a backfill rather than guessing.

## Known limits

- **Attachments are capped at 3 MB per file.** That is Graph's simple-attachment
  ceiling; larger files need an upload session, which is not implemented. The
  composer still allows 25 MB for Gmail, so an Outlook send with a bigger file
  fails with a sentence naming the limit.
- **Drafts and deleted items** are excluded the same way Gmail's are: drafts via
  `isDraft`, deleted items because Graph's message listing does not include them.
- **Editing an existing message** is not picked up: only `receivedDateTime`
  changes trigger a re-read. Lumen's model is "new mail arrives", and the same
  limitation applies to the Gmail path's reliance on `history.list`.
- **Threading is Microsoft's `conversationId`.** A conversation Graph splits (or
  merges) differently from Gmail is stored the same way the provider reports it;
  the inbox's Message-ID merge still folds copies across the user's own accounts.

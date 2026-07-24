# Gmail

Triage the inbox — read-only summary with message IDs (defaults: 20 messages, `is:unread`, table output):

```bash
gws gmail +triage
gws gmail +triage --max 5 --query 'from:boss' --labels
```

`--query` takes full Gmail search syntax (`from:`, `subject:`, `has:attachment`, `newer_than:7d`).

Read a message — HTML-only messages convert to plain text automatically:

```bash
gws gmail +read --id MSG_ID
gws gmail +read --id MSG_ID --headers
gws gmail +read --id MSG_ID --html
```

Send (write) — `--draft` saves instead of sending; `-a/--attach` repeats, 25 MB total; `--html` bodies use fragment tags (`<p>`, `<b>`, `<a>`) with no `<html>`/`<body>` wrapper:

```bash
gws gmail +send --to alice@example.com --subject 'Hello' --body 'Hi Alice!'
gws gmail +send --to alice@example.com --subject 'Report' --body 'See attached' -a report.pdf --cc bob@example.com
```

Reply and reply-all (write) — threading headers and quoting of the original are handled automatically; both take the same `--body`/`--attach`/`--html`/`--draft` flags as `+send`:

```bash
gws gmail +reply --message-id MSG_ID --body 'Thanks, got it!'
gws gmail +reply-all --message-id MSG_ID --body 'Sounds good' --remove bob@example.com
```

`+reply-all` answers the sender plus all To/CC recipients; `--remove` excludes specific ones and the command fails if no To recipient remains.

Forward (write) — original attachments are included by default (`--no-original-attachments` to omit); `--body` adds a note above the forwarded message:

```bash
gws gmail +forward --message-id MSG_ID --to dave@example.com --body 'FYI see below'
```

Stream new mail as NDJSON (write — creates Pub/Sub resources in a GCP project; the Gmail watch expires after 7 days):

```bash
gws gmail +watch --project GCP_PROJECT --label-ids INBOX --once
```

Beyond the helpers, the API exposes `users.messages`, `threads`, `labels`, `drafts`, `history`, and `settings` (filters, vacation responder, send-as aliases) — go schema-first, e.g. `gmail.users.messages.list` for raw search or `gmail.users.settings.filters.create` for filters.

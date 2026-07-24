---
name: google-workspace
description: "Google Docs, Sheets, Drive, and Gmail via the gws CLI. Use when the user wants to read or edit a Doc or spreadsheet, manage Drive files or sharing, read or send email, or shares a Docs/Sheets/Drive link or ID."
metadata:
  version: 0.22.5
  upstream: "https://github.com/googleworkspace/cli"
  requires:
    bins:
      - gws
---

# Google Workspace

Shared `gws` conventions live here; before running any command for a service, read that service's file.

## Services

| Service | Commands |
|---|---|
| Google Docs | [docs.md](docs.md) |
| Google Sheets | [sheets.md](sheets.md) |
| Google Drive | [drive.md](drive.md) |
| Gmail | [gmail.md](gmail.md) |

## Setup

```bash
gws --version    # verify install; if missing, see https://github.com/googleworkspace/cli
gws auth status  # check credentials
gws auth login   # browser-based OAuth
```

A service account authenticates instead via:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
```

## Safety

- Confirm with the user immediately before every command marked "(write)" in the service files. Reads and schema/help inspection need no confirmation.
- Validate a risky write with `--dry-run` before the real run.
- Redact API keys, OAuth tokens, and other secrets that surface in output (`gws auth export` prints decrypted credentials).
- For PII or content-safety screening, run with `--sanitize <Model Armor template>`.

## Command conventions

```bash
gws <service> <resource> [sub-resource] <method> [flags]
```

| Flag | Purpose |
|---|---|
| `--params '{"key":"value"}'` | URL/query parameters |
| `--json '{"key":"value"}'` | JSON request body |
| `--format json\|table\|yaml\|csv` | Output format (default: json) |
| `--dry-run` | Validate without calling the API |
| `--page-all` | Fetch all pages as NDJSON (`--page-limit N`, max pages, default 10; `--page-delay MS`, default 100) |
| `-o, --output PATH` | Save binary output |
| `--upload PATH` | Multipart file upload |

**Schema-first**: for any raw API method, browse with `gws <service> --help`, inspect with `gws schema <service>.<resource>.<method>`, build `--params`/`--json` from that output, confirm if it writes, then run.

`batchUpdate` (any service) is atomic: one invalid request fails the entire batch. When one fails, run `gws schema` on the method and rebuild the request from the schema.

**Quoting**: wrap `--params`/`--json` values in single quotes so the inner double quotes survive the shell. Quote A1 ranges — `"Sheet1!A1:D10"` — because an unquoted `!` triggers history expansion in interactive zsh.

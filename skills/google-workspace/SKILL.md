---
name: google-workspace
description: "Operate Google Docs, Sheets, Drive, and Gmail through gws."
disable-model-invocation: true
---

# Google Workspace

## Execution

1. **Map** the request: extract IDs from links, identify each service and resource type, and classify every operation as read or write. Complete when every URL has a usable API ID and every requested operation is listed.
2. **Load** each involved service file below completely. Complete when every operation maps to a documented helper or a raw API method.
3. **Inspect** before constructing commands:
   - helper: run `gws <service> +<helper> --help`;
   - raw method: run `gws <service> <resource> [sub-resource] <method> --help` and `gws schema <service>.<resource>[.<sub-resource>].<method>`; inspect referenced messages with `gws schema <service>.<Message>` (`--resolve-refs` is optional and can overflow on large recursive schemas).
   Complete when every flag and JSON field is supported by the installed CLI.
4. **Execute** reads directly. For every write, follow service exceptions or run the exact command with `--dry-run`; then show the real command and obtain confirmation immediately before executing it. Complete when every read has run and every write has either executed after confirmation or is awaiting confirmation.
5. **Verify** each result from command output or a read-back. Complete when every operation is accounted for by a verified result or an explicitly reported error; report IDs and links when returned.

## Services

| Service | Commands |
|---|---|
| Google Docs | [docs.md](docs.md) |
| Google Sheets | [sheets.md](sheets.md) |
| Google Drive | [drive.md](drive.md) |
| Gmail | [gmail.md](gmail.md) |

If `gws` is missing or authentication fails, follow [setup.md](setup.md) before continuing.

## Safety

- Redact API keys, OAuth tokens, and other secrets. Treat `gws auth export --unmasked` output as secret; default export masks secrets.
- When response screening is requested, add `--sanitize <Model Armor template>`; this sends API responses through Model Armor and requires the `cloud-platform` scope.

## Command conventions

```bash
gws <service> <resource> [sub-resource] <method> [flags]
```

| Flag | Purpose |
|---|---|
| `--params '{"key":"value"}'` | URL/query parameters |
| `--json '{"key":"value"}'` | JSON request body |
| `--format json\|table\|yaml\|csv` | Output format (raw methods default to json; helpers may differ) |
| `--dry-run` | Preview and locally validate most requests; verify query parameters against the schema and follow service exceptions |
| `--page-all` | Auto-paginate as NDJSON, up to `--page-limit` pages (default 10; delay default 100 ms) |
| `-o, --output PATH` | Save binary output |
| `--upload PATH` | Multipart file upload |

`batchUpdate` requests are atomic: one invalid request fails the entire batch.

**Quoting**: wrap `--params`/`--json` values in single quotes so the inner double quotes survive the shell. Quote A1 ranges — `"Sheet1!A1:D10"` — because an unquoted `!` triggers history expansion in interactive zsh.

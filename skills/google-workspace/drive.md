# Google Drive

Search files — Drive query strings use single quotes, so inside a single-quoted shell argument write `'\''`:

```bash
gws drive files list --params '{"q":"name contains '\''report'\'' and trashed=false","fields":"files(id,name,mimeType,parents)"}'
```

`list` returns trashed files too, so keep `trashed=false` in the query unless the user wants them. For the full query syntax (`fullText`, `mimeType`, `parents`, `sharedWithMe`, `modifiedTime`), go schema-first with `drive.files.list`.

Get file metadata:

```bash
gws drive files get --params '{"fileId":"FILE_ID","fields":"id,name,mimeType,size,parents,webViewLink"}'
```

Download a stored file, or export a Google-native file (Docs/Sheets/Slides) to another format — export is capped at 10 MB:

```bash
gws drive files get --params '{"fileId":"FILE_ID","alt":"media"}' -o ./file.pdf
gws drive files export --params '{"fileId":"FILE_ID","mimeType":"application/pdf"}' -o ./doc.pdf
```

Upload a file (write) — MIME type is auto-detected, name defaults to the local filename:

```bash
gws drive +upload ./report.pdf
gws drive +upload ./data.csv --parent FOLDER_ID --name 'Sales Data.csv'
```

Create a folder (write):

```bash
gws drive files create --json '{"name":"Folder name","mimeType":"application/vnd.google-apps.folder","parents":["PARENT_ID"]}'
```

Rename or move (write) — moves go through the `addParents`/`removeParents` params, not the body:

```bash
gws drive files update --params '{"fileId":"FILE_ID"}' --json '{"name":"New name"}'
gws drive files update --params '{"fileId":"FILE_ID","addParents":"NEW_FOLDER_ID","removeParents":"OLD_FOLDER_ID"}'
```

Share (write) — concurrent permission changes on one file aren't supported; apply them one at a time:

```bash
gws drive permissions create --params '{"fileId":"FILE_ID"}' --json '{"type":"user","role":"writer","emailAddress":"alice@example.com"}'
```

Beyond `files` and `permissions`, the API also exposes `drives` (shared drives), `comments`, `replies`, `revisions`, and `changes` — go schema-first when a task needs them.

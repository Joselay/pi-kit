# Google Docs

Read a document:

```bash
gws docs documents get --params '{"documentId":"DOC_ID"}'
```

Create a blank document (write) — the API uses only `title`; any content fields in the request are ignored, so add content afterwards with `+write` or `batchUpdate`:

```bash
gws docs documents create --json '{"title":"Document title"}'
```

Append plain text to the end of the document body (write):

```bash
gws docs +write --document DOC_ID --text 'Hello, world!'
```

Rich formatting and structural edits (write) — schema-first `docs.documents.batchUpdate`:

```bash
gws docs documents batchUpdate \
  --params '{"documentId":"DOC_ID"}' \
  --json '{"requests":[{"insertText":{"location":{"index":1},"text":"Heading\n"}}]}'
```

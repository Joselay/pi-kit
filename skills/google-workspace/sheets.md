# Google Sheets

Read values:

```bash
gws sheets +read --spreadsheet SHEET_ID --range "Sheet1!A1:D10"
gws sheets +read --spreadsheet SHEET_ID --range Sheet1 --format csv
```

For advanced value options (render/date-time options, majorDimension), go schema-first with `sheets.spreadsheets.values.get`.

Append rows (write) — `--values` for one simple row; `--json-values` for typed or multiple rows. The helper appends to the first sheet; use schema-first `sheets.spreadsheets.values.append` to target a range:

```bash
gws sheets +append --spreadsheet SHEET_ID --values 'Alice,100,true'
gws sheets +append --spreadsheet SHEET_ID --json-values '[["a","b"],["c","d"]]'
```

Create a spreadsheet (write):

```bash
gws sheets spreadsheets create --json '{"properties":{"title":"Spreadsheet title"}}'
```

Inspect spreadsheet metadata — grid data is omitted by default; add `includeGridData` or a fields mask via the schema. Use the `ranges` parameter for A1-selected subsets; use `getByDataFilter` when selection requires a `DataFilter`, such as developer metadata:

```bash
gws sheets spreadsheets get --params '{"spreadsheetId":"SHEET_ID"}'
```

Formatting, tabs, and cell updates (write) — schema-first `sheets.spreadsheets.batchUpdate`:

```bash
gws sheets spreadsheets batchUpdate \
  --params '{"spreadsheetId":"SHEET_ID"}' \
  --json '{"requests":[{"addSheet":{"properties":{"title":"New tab"}}}]}'
```

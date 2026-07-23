# Google Sheets

Read values:

```bash
gws sheets +read --spreadsheet SHEET_ID --range "Sheet1!A1:D10"
gws sheets +read --spreadsheet SHEET_ID --range Sheet1 --format csv
```

For advanced value options (render/date-time options, majorDimension), go schema-first with `sheets.spreadsheets.values.get`.

Append rows (write) — `--values` for one simple row, `--json-values` for typed or multiple rows, `--range` to target a tab (default: `A1` on the first sheet):

```bash
gws sheets +append --spreadsheet SHEET_ID --values 'Alice,100,true'
gws sheets +append --spreadsheet SHEET_ID --json-values '[["a","b"],["c","d"]]'
gws sheets +append --spreadsheet SHEET_ID --range "Sheet2!A1" --values 'Alice,100'
```

Create a spreadsheet (write):

```bash
gws sheets spreadsheets create --json '{"properties":{"title":"Spreadsheet title"}}'
```

Inspect spreadsheet metadata — grid data is omitted by default; add `includeGridData` or a fields mask via the schema. To return only selected subsets of data, use `getByDataFilter` with a `dataFilters` body instead of `get`:

```bash
gws sheets spreadsheets get --params '{"spreadsheetId":"SHEET_ID"}'
```

Formatting, tabs, and cell updates (write) — schema-first `sheets.spreadsheets.batchUpdate`:

```bash
gws sheets spreadsheets batchUpdate \
  --params '{"spreadsheetId":"SHEET_ID"}' \
  --json '{"requests":[{"addSheet":{"properties":{"title":"New tab"}}}]}'
```

Beyond `spreadsheets` and `values`, the API also exposes `developerMetadata` and `sheets` resources — go schema-first when a task needs them.

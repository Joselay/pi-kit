# Standalone scripts

Use this branch for a single Python file that owns its dependencies. Inline metadata isolates the script from a surrounding project's dependencies.

## Run

```bash
uv run script.py
uv run script.py arg1 arg2
uv run --python 3.10 script.py
printf 'print("hi")\n' | uv run -
```

For an undeclared script inside a project, `uv run` includes the project environment. Select independence explicitly:

```bash
uv run --no-project script.py
```

For a disposable run, request dependencies per invocation:

```bash
uv run --no-project --with requests script.py
uv run --with 'requests>2,<3' script.py
uv run --with requests --with rich script.py
```

## Declare dependencies

Initialize metadata, then let `uv add` edit it:

```bash
uv init --script example.py --python 3.12
uv add --script example.py 'requests<3' rich
```

The resulting PEP 723 block is the script's source of truth:

```python
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "requests<3",
#   "rich",
# ]
# ///

import requests
from rich import print
```

The `dependencies` field is required, including when empty. Run the declared script with `uv run example.py`; its environment is isolated even when the file is inside a project.

### Alternative index

```bash
uv add --index "https://example.com/simple" --script example.py requests
```

Adds to metadata:

```python
# [[tool.uv.index]]
# url = "https://example.com/simple"
```

## Reproducibility

```bash
uv lock --script example.py  # Creates example.py.lock beside the script
```

For a stable resolution horizon, add an RFC 3339 timestamp:

```python
# /// script
# dependencies = ["requests"]
# [tool.uv]
# exclude-newer = "2023-10-16T00:00:00Z"
# ///
```

Subsequent script operations reuse and update the adjacent lockfile. Use `--locked` when an out-of-date lockfile must fail.

## Executable script

```python
#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["httpx"]
# ///

import httpx
print(httpx.get("https://example.com"))
```

```bash
chmod +x myscript
./myscript
```

## Completion

Run the script through `uv`, and account for every imported third-party package in inline metadata. Commit the adjacent lockfile when reproducible resolution is required.

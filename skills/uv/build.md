# `uv_build`

Use `uv_build` for a new pure-Python package. Preserve another backend when the project already selected one.

Initialize new libraries through uv so the generated `uv_build` constraint matches the installed uv release:

```bash
uv init --lib --build-backend uv my-package
```

The generated `[build-system]` uses `uv_build` with a lower and upper bound. Keep that bounded form; consult the [official backend documentation](https://docs.astral.sh/uv/concepts/build-backend/) before changing its version range.

## Layout

The default module is `src/<normalized_name>/__init__.py`:

```
pyproject.toml
src/
└── my_package/
    └── __init__.py
```

Package name is normalized: `Foo-Bar` → `foo_bar`.

### Custom module location

```toml
[tool.uv.build-backend]
module-name = "mymodule"
module-root = ""  # Use project root instead of src/
```

### Namespace Packages

For `foo.bar` namespace:

```
src/foo/bar/__init__.py  # No __init__.py in foo/
```

```toml
[tool.uv.build-backend]
module-name = "foo.bar"
```

## Extensions

`uv_build` supports pure Python only. Choose `maturin` for Rust or `scikit-build-core` for C, C++, Fortran, or Cython:

```bash
uv init --lib --build-backend maturin my-extension
uv init --lib --build-backend scikit my-extension
```

Use Hatchling when a pure-Python package needs build hooks or a layout beyond `uv_build`'s model.

## File inclusion and exclusion

Excludes `__pycache__`, `*.pyc`, `*.pyo` by default.

```toml
[tool.uv.build-backend]
source-include = ["assets/**"]
source-exclude = ["/dist", "tests/**"]
```

- Includes are anchored (`pyproject.toml` = only root)
- Excludes are not anchored (`__pycache__` = all dirs named that)
- Use `/prefix` to anchor excludes

## Completion

Run `uv build`, inspect both the sdist and wheel contents, and test installation/import from the built wheel. Every required package and data file must be present; generated and excluded files must be absent.

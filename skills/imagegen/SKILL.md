---
name: imagegen
description: Generate and edit raster images with AI.
disable-model-invocation: true
---

# Image generation

Use a **render loop**: prompt → render → inspect → refine → deliver. Run generative raster operations through [the helper](scripts/imagegen.mjs). Resolve relative paths against this skill directory.

This skill produces bitmaps, including mockups and logo concepts. Build editable SVGs, existing-system icons, and HTML/CSS/canvas visuals in native code instead.

## 1. Prompt

Write a self-contained prompt for each requested image or variant: subject, style, composition, intended use, exact text, and constraints that matter. The prompt is the brief. Preserve detailed requests; fill gaps in generic requests with useful visual detail grounded in the user or project.

For reference-guided work or edits, open every input with `read`. Ask for missing required inputs. Name each attachment's role in order (`Image 1: edit target; Image 2: style reference`). For edits, separate **change** from **preserve**.

Load references only as needed:

- [Prompting](references/prompting.md) for photography, exact text, layouts, game assets, or input-guided work.
- [Transparency](references/transparency.md) for transparent backgrounds, including alpha validation.

Proceed when every requested image has a clear prompt and all required inputs are readable.

## 2. Render

Read the CLI contract before the first call:

```bash
node <skill-directory>/scripts/imagegen.mjs --help
```

Honor an explicit model request. Otherwise select by the task's priorities:

- **Flare** (`gpt-image-2.5-flare`) for everyday image generation and speed-first work: concepts, variants, routine assets, and quick edits.
- **Sunburst** (`gpt-image-2.5-sunburst`) when capability and editing precision take priority: tightly constrained generation or edits where specific features must survive unchanged, such as a person's identity, product details, or an existing layout.

Both models generate and edit; select by the brief, not merely whether inputs are attached. Pass the selected `--model` on every call; there is no default model. Express output requirements in the prompt and leave output settings to the image model.

```bash
node <skill-directory>/scripts/imagegen.mjs \
  --model <selected-model> \
  --prompt "<complete brief>"
```

Run one call per image with at least 180 seconds allowed. For long prompts, use `--prompt-file <absolute-path>` instead. Attach inputs with repeated `--input <absolute-image-path>` flags in prompt order; mentioning a filename does not attach it.

Use the existing OAuth session. On authentication failure, ask the user to run `/login`; leave credentials untouched and undisclosed. Report helper errors without substituting providers, models, API keys, or ad hoc runners.

## 3. Inspect and refine

Open every output with `read` and check it against the full prompt, including exact text, preserved features, and any reference-specific checks.

For a visible miss, rerun with a targeted correction, the complete brief, and all preserved features. When refining an output, attach it as the edit target and identify any retained references; compare against original inputs for drift.

Stop when the image passes or the same requirement fails in two consecutive inspected outputs. Report persistent defects as limitations. A helper error is not an inspected attempt; report it directly.

## 4. Deliver

Use the helper's returned path as the source. Copy selected images to the requested destination; for project use, keep them inside the workspace and update their consumers. Preview-only images may stay at the helper path.

Preserve originals. If a destination exists, use a versioned filename unless replacement is authorized. Verify copied files and updated project references resolve.

Return final image paths and any limitations or failures. Include prompts or model details when requested. Finish only when every requested image is delivered and inspected, or explicitly reported as unsuccessful.

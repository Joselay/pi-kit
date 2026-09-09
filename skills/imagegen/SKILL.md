---
name: imagegen
description: Generate and edit raster images with AI.
disable-model-invocation: true
---

# Image generation

Use a **render loop**: prompt → render → inspect → refine → deliver. Run generative raster work through [the helper](scripts/imagegen.mjs). Resolve relative paths against this skill directory.

This skill produces bitmaps, including mockups and logo concepts. Use native code for editable SVGs, existing-system icons, and HTML/CSS/canvas visuals.

## 1. Prompt

Write a self-contained brief for each image or variant: subject, style, composition, intended use, exact text, and constraints. Preserve the user's details; fill gaps from the user or project context.

For input-guided work, open every input with `read` and identify its role in attachment order (`Image 1: edit target; Image 2: style reference`). Separate **change** from **preserve**. Ask for required inputs that are missing.

Load the matching reference:

- [Prompting](references/prompting.md): photography, exact text, layouts, game assets, or input-guided work.
- [Transparency](references/transparency.md): transparent backgrounds and alpha validation.

Proceed when every requested image has a complete brief and its required inputs are readable.

## 2. Render

Read the CLI contract before the first call:

```bash
node <skill-directory>/scripts/imagegen.mjs --help
```

Honor an explicit model request. Otherwise choose:

- **Flare** (`gpt-image-2.5-flare`): everyday generation, concepts, variants, and quick edits.
- **Sunburst** (`gpt-image-2.5-sunburst`): tightly constrained generation or precision edits preserving identity, product details, or layout.

Both models generate and edit; choose by the brief, not attachment presence. Express output requirements in the prompt and pass the selected model:

```bash
node <skill-directory>/scripts/imagegen.mjs \
  --model <selected-model> \
  --prompt "<complete brief>"
```

Run one call per image, allowing at least 180 seconds. Use `--prompt-file` for long briefs and repeated `--input` flags for attachments in prompt order; filenames in a prompt do not attach images.

On helper errors, report the error and any request ID rather than switching models or runners. Ask the user to run `/login` for authentication failures. Stop on quota or moderation errors.

## 3. Inspect and refine

Open every output with `read`. Check the full brief, exact text, preserved features, and applicable reference checks.

For a visible miss, attach the output as the edit target and rerun with a targeted correction plus the complete brief. Identify retained references and compare with original inputs for drift.

Stop when the image passes or the same requirement fails in two consecutive inspected outputs. Report persistent defects as limitations; helper errors are not inspected attempts.

## 4. Deliver

Copy selected images from the helper's returned paths to the requested destination. For project use, keep them in the workspace and update their consumers; previews may stay at the helper path.

Preserve originals and version existing destinations unless replacement is authorized. Verify copied files and updated project references resolve.

Return final paths and any limitations or failures; include prompts or model details when requested. Finish when every requested image is inspected and delivered, or explicitly reported as unsuccessful.

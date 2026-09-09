---
name: imagegen
description: Generate and edit raster images with AI.
disable-model-invocation: true
---

# Image generation

Use a **render loop**: prompt → render → inspect → refine → deliver. Run generative raster work through [the helper](scripts/imagegen.mjs). Resolve relative paths against this skill directory.

The helper uses Pi's existing OpenAI OAuth login; API keys are not supported.

This skill produces bitmaps, including mockups and logo concepts. Use native code for editable SVGs, existing-system icons, and HTML/CSS/canvas visuals.

## 1. Prompt

Write a self-contained brief for each image or variant, including the subject and any specified style, composition, intended use, exact text, and constraints. Preserve detailed prompts; augment generic prompts only with context-supported framing or intended-use cues.

For input-guided work, open every input with `read`, then attach its local file with a repeated `--input` flag in brief order (`Image 1: edit target; Image 2: style reference`). Separate **change** from **preserve**; reference-only inputs guide a new image rather than becoming edit targets. Reading an image does not attach it to the helper; ask for a local file when a required conversation image has none.

Load all applicable references before finalizing the brief:

- [Prompting](references/prompting.md): photography/products, text/layouts, illustrations, game assets, or edits and references.
- [Transparency](references/transparency.md): transparent backgrounds and alpha validation.

Proceed per image when its brief is self-contained and its required inputs are readable. Ask only for missing inputs or facts that block correctness; leave unspecified creative choices open.

## 2. Render

Before the first render, use `bash` to read the helper's options:

```bash
node <skill-directory>/scripts/imagegen.mjs --help
```

Honor a requested model if supported; report unsupported requests without substituting. When no model is specified, choose:

- **Flare** (`gpt-image-2.5-flare`): fast, high-quality everyday generation, concepts, and variants.
- **Sunburst** (`gpt-image-2.5-sunburst`): the most capable option for generation and editing; prefer it when editing precision matters most.

Both models support generation and editing; choose by the brief, not attachment presence. Use only the helper's supported controls; express output requirements in the prompt and pass the selected model:

```bash
node <skill-directory>/scripts/imagegen.mjs \
  --model <selected-model> \
  --prompt "<complete brief>"
```

Run one helper call per image through `bash`, allowing at least 180 seconds. Use `--prompt-file` for long briefs.

On helper errors, report the error and any request ID rather than switching models or runners. For authentication failures, ask the user to run `/login` in Pi and select the OpenAI subscription login. Stop on quota or moderation errors.

Proceed to inspection only when the helper returns an output path whose image can be opened.

## 3. Inspect and refine

Open every output with `read` and check the full brief and applicable reference checks. Verify required pixel dimensions or file properties with image tooling rather than inferring them from the preview.

For a failed requirement, attach the output as the edit target and rerun with a targeted correction plus the complete brief. Relabel inputs to match the new attachment order, retain needed references, and compare with originals for drift.

Per image, stop refining when all verifiable requirements pass or the same requirement fails in two consecutive inspected outputs. Report persistent defects and unverified checks as limitations; missing inspection tools are not a reason to rerender. Helper errors are not inspected attempts.

## 4. Deliver

Copy selected images from the helper's returned paths to the requested destination. For project use, keep them in the workspace and update their consumers; previews may stay at the helper path.

Preserve originals and version existing destinations unless replacement is authorized. Verify copied files and updated project references resolve.

Return final paths and any limitations or failures; include prompts or model details when requested. Finish when every requested image is inspected and delivered, or explicitly reported as unsuccessful.

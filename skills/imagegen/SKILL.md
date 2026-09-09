---
name: imagegen
description: Generate and edit raster images with AI.
disable-model-invocation: true
---

# Image generation

Run a **render loop**: brief → render → inspect → refine → deliver. Use [the helper](scripts/imagegen.mjs) for every generative raster operation. Resolve skill-relative paths against this directory.

This workflow produces bitmaps. For repo-native SVG/vector assets, existing-system icons or logos, and HTML/CSS/canvas visuals, implement in native code instead. A raster mockup or logo concept belongs here; an editable implementation does not.

## 1. Brief

Create a manifest with one entry per requested asset or variant. Each entry records:

- **Mode:** generate (no inputs), reference-guided (inputs guide the result), or edit (change an input while preserving named features).
- **Acceptance:** subject, style, composition, exact text, constraints, and intended use.
- **Inputs:** absolute paths and indexed roles in attachment order, such as `Image 1: edit target; Image 2: style reference`.
- **Destination:** requested save path, project consumer, or preview-only output.

Open every input with `read`. Ask for a missing or unreadable required image; otherwise proceed with the available brief.

Write one self-contained prompt per entry. Detailed requests need normalization, not extra creative requirements. For generic requests, add useful framing, layout, or material detail grounded in the request. Cast, props, brand language, story, and side-specific placement need support from the user or surrounding project.

Load only the references the entry needs:

- [Prompting](references/prompting.md) for photography, exact text, structured layouts, domain-specific scenes, or input-guided work.
- [Sample prompts](references/sample-prompts.md) when a generic website, game, wireframe, or raster-logo request needs a starting brief.
- [Transparency](references/transparency.md) whenever the output requires a transparent background; apply its prompt and validation rules within this loop.

**Ready:** every requested deliverable has acceptance criteria and a prompt; every required input is readable and has an explicit role wherever used. For edits, the prompt separates the change from the invariants.

## 2. Render

Read the helper's CLI contract before the first call:

```bash
node <skill-directory>/scripts/imagegen.mjs --help
```

Use its documented default model unless the user requests another supported model. Pass `--model` explicitly on every call and retain the selection through refinements. Treat `--help` as the source of truth for supported models, input limits, and fixed request controls. Explain requirements those controls cannot guarantee rather than changing the helper's request shape.

Run one call per manifest entry, with a tailored prompt and at least 180 seconds allowed:

```bash
node <skill-directory>/scripts/imagegen.mjs \
  --model <selected-model> \
  --prompt-file <absolute-brief-path>
```

For a short brief, use `--prompt "<complete brief>"` instead of `--prompt-file`. Attach each input with a separate `--input <absolute-image-path>`, in the indexed order. A filename mentioned in the prompt is not an attachment.

Use the existing OAuth session. On authentication failure, ask the user to run `/login`; keep credential storage untouched and undisclosed. Do not substitute API keys, providers, or ad hoc runners. If the endpoint rejects the selected model, report the error without switching models.

Record the helper's returned path, model, and prompt against the entry.

**Rendered:** every entry has an output path or a concrete helper error. Keep failed entries in the manifest so they remain accounted for at delivery.

## 3. Inspect and refine

Open every output with `read`. Compare it against every acceptance criterion, including exact text and edit invariants. Apply any branch-specific checks loaded during briefing.

For a visible miss, issue a targeted correction with the complete brief and all invariants. Change only the instruction needed to address the defect. If refining the rendered image, attach it explicitly as the edit target and restate the roles of any retained references; keep original inputs available for invariant checks.

Stop refining an entry when it passes, or when the same requirement fails in two consecutive inspected outputs. Report that persistent defect as a limitation. A helper error is not a visual failure: report it rather than counting it as an inspected attempt.

**Reviewed:** every selected image has been opened and every criterion either passes or has an explicit limitation. An uninspected output is not an accepted asset.

## 4. Deliver

Treat the returned helper path as the source; its location can vary with the environment.

- Copy selected images to a user-requested destination. For project use, keep a copy inside the workspace and update its consumers. Preview-only images may remain at the helper path.
- Preserve the generated originals unless the user asks to delete them.
- Use a sibling versioned filename when a destination already exists; overwrite only with explicit replacement permission.
- Verify copied files exist and every updated project reference resolves.

Report final bitmap paths, the selected model, final prompts (inline or linked prompt files), and any failed entries or limitations.

**Done:** every manifest entry is delivered or explicitly reported as failed; every delivered asset has a stable path, and every project-bound asset is available from the workspace.

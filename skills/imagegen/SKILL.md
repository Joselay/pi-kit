---
name: imagegen
description: "Generate and edit raster images with AI."
disable-model-invocation: true
---

# Image generation

Use `scripts/imagegen.mjs` for every generative raster operation. Work as a render loop: **brief → render → inspect → refine → deliver**. Proceed once required inputs are readable.

## Guardrails

- Use OAuth. When authentication fails, ask the user to run `/login`; keep authentication storage untouched and undisclosed. The supported recovery path is `/login`, rather than API keys, alternate providers, or one-off SDK runners.
- Keep the helper's fixed request shape: `gpt-image-2`; `background`, `quality`, and `size` set to `auto`; one result; at most five high-fidelity inputs. Explain requests these controls cannot satisfy.
- Use `imagegen.mjs` for generative work. Use Python only for local post-processing, running the supplied helper with `uv run --with Pillow`.
- Render each requested asset and variant with its own call and tailored brief.
- Deliver bitmap files. Build repo-native SVG/vector, existing-system icons or logos, and HTML/CSS/canvas visuals in native code instead.

## Render loop

1. **Brief.** Make a manifest of every deliverable. Classify each as:
   - **generate** — no input image;
   - **reference-guided** — inputs guide style, composition, identity, or mood;
   - **edit** — an input is changed while named parts stay invariant.

   Collect exact text, visual requirements, constraints, and input images. Inspect every input with `read`; assign each one index and role (`Image 1: edit target; Image 2: style reference`). A mentioned file is attached only when supplied through `--input`. Ask for an attachment only when a required input is missing or unreadable. Load `references/prompting.md`, choose its matching use-case slug, and produce one creative brief per deliverable. For edits, name the change and every invariant. For transparent output, also load and follow `references/transparency.md` before rendering. This step is complete when every requirement belongs to a manifest entry and every input has an explicit role wherever used.

2. **Render.** Run one initial helper call per manifest entry. Pass each image with a separate `--input`, use `--prompt-file` for a long brief, and allow at least 180 seconds. This step is complete when every entry has an output path or a concrete helper error.

3. **Inspect and refine.** Open every output with `read` and compare it against the corresponding manifest: subject, style, composition, exact text, and invariants. For a miss, make a targeted follow-up call with the complete brief and all invariants, changing only the instruction needed to correct the miss. Repeat only while a concrete correction remains; report a limitation when the same requirement fails twice. This step is complete when every selected output visibly passes its manifest or has a reported limitation.

4. **Deliver.** Apply the save-path policy. For project assets, update consumers and verify every reference resolves. Report final path(s), final brief(s), and limitations. This step is complete when every deliverable has a stable bitmap path and every project-bound path is valid.

## Helper

Generate:

```bash
node <skill-directory>/scripts/imagegen.mjs --prompt "<complete prompt>"
```

Edit or use references:

```bash
node <skill-directory>/scripts/imagegen.mjs \
  --prompt "<complete prompt with indexed roles and invariants>" \
  --input "<absolute-image-1>" \
  --input "<absolute-image-2>"
```

The helper prints the saved path under `~/.pi/generated_images/`.

## Save-path policy

- Every output lands under `~/.pi/generated_images/` with a unique per-call name.
- If the user names a destination, copy the selected output there. If the image is for the current project, copy it into the workspace before finishing. Preview-only images may stay at the default path. A project-referenced asset must never live only under `~/.pi/generated_images/`.
- When copying, leave the original in place unless the user explicitly asks to delete it.
- Save as a sibling versioned filename (`hero-v2.png`, `item-icon-edited.png`); overwrite an existing asset only when the user explicitly asks for replacement.

## References

- `references/sample-prompts.md` — load when a generic website, game, wireframe, or logo request needs a starting recipe.

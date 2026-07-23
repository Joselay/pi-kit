---
name: imagegen
description: "Generate or edit raster images with AI when the deliverable is a bitmap: photos, illustrations, textures, sprites, mockups, transparent cutouts, or reference-guided variants. Not for visuals better built as repo-native SVG/vector or HTML/CSS/canvas, such as extending an existing icon or logo system."
---

# Image Generation Skill

All image generation and editing goes through `imagegen.mjs`. Generate directly without reconfirmation unless a required input image is missing or unreadable.

## Rules

- OAuth is the only credential. If it is unavailable or the helper reports an auth error, ask the user to run `/login`. Never fall back to an API key, alternate provider, or one-off SDK runner, and never read or expose authentication storage.
- The helper's request shape and model pin match the upstream built-in `image_gen` tool: `model: "gpt-image-2"`, `background`/`quality`/`size` all `"auto"`, no `n` (one result), up to five input images, always high-fidelity inputs. These controls are fixed — do not expose them to callers or modify `imagegen.mjs` during an image task. If a needed capability is unavailable, explain the limitation.
- Use Python only for local post-processing such as chroma-key removal, never as a substitute for generative editing. Run Python helpers with `uv run`; their inline metadata supplies dependencies.
- Issue one tailored helper call per requested asset or variant, with a distinct prompt per deliverable.
- Deliver a generated bitmap for raster-style requests (photo, sprite, banner, product image), never an SVG/HTML/CSS placeholder.

## Workflow

1. Classify intent: **edit** when the user wants an existing image changed while parts of it are preserved; **generate** when they provide no images or the images are only style/composition/mood references. Default to generate.
2. Collect inputs: prompt(s), exact text (verbatim), constraints, input images. Inspect every input image with `read` and label it by index and role (`Image 1: edit target; Image 2: style reference`). A filename mentioned in the prompt is not attached — pass it with `--input`. If a required image is unreadable, ask the user to re-attach it; a requested reference must be present before generating.
3. Build the prompt with the shared schema below: pick a use-case slug, follow the specificity policy in `prompting.md` (normalize detailed prompts; augment generic ones only where it materially helps), and for edits list invariants explicitly (`change only X; keep Y unchanged`).
4. Run the helper. Use `--prompt-file` for long prompts, `--input` once per input image, and at least a 180-second timeout.
5. Inspect every output with `read` and validate subject, style, composition, text accuracy, and invariants. Iterate one targeted change at a time, restating invariants each round.
6. Save per the save-path policy, update any consuming code for project-bound assets, and report the final path(s) and final prompt(s).

## Helper

Generate:

```bash
node <skill-directory>/imagegen.mjs --prompt "<complete prompt>"
```

Edit or use references:

```bash
node <skill-directory>/imagegen.mjs \
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

## Shared prompt schema

```text
Use case: <taxonomy slug>
Asset type: <where the asset will be used>
Primary request: <user's main prompt>
Input images: <Image 1: role; Image 2: role> (optional)
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo/illustration/3D/etc>
Composition/framing: <wide/close/top-down; placement>
Lighting/mood: <lighting + mood>
Color palette: <palette notes>
Materials/textures: <surface details>
Text (verbatim): "<exact text>"
Constraints: <must keep/must avoid>
Avoid: <negative constraints>
```

Use only the lines that help; `Asset type`, `Input images`, and `Scene/backdrop` are prompt scaffolding, not helper flags or request controls. If a critical detail is missing and blocks success, ask; otherwise proceed.

Use-case slugs — generate: `photorealistic-natural`, `product-mockup`, `ui-mockup`, `infographic-diagram`, `scientific-educational`, `ads-marketing`, `productivity-visual`, `logo-brand`, `illustration-story`, `stylized-concept`, `historical-scene`. Edit: `text-localization`, `identity-preserve`, `precise-object-edit`, `lighting-weather`, `background-extraction`, `style-transfer`, `compositing`, `sketch-to-render`. Per-slug tips live in `prompting.md`.

## Transparent images

For a transparent background, cutout, or alpha PNG, follow `transparency.md` before generating: chroma-key generation prompt, local key-to-alpha conversion, validation, and known-imperfect materials.

## References

- `sample-prompts.md` — copy/paste prompt recipes plus asset-type templates (website, game, wireframe, logo).

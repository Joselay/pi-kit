# Transparent images

Request genuine transparency directly through `imagegen.mjs`, keeping its tested `background=auto` request shape. Preserve the returned PNG and its alpha channel.

1. **Render.** Include the transparency brief below with the complete subject requirements and edit invariants. Use the model selected under `SKILL.md`. Complete when the helper returns an image path or a concrete error.
2. **Validate.** Inspect the file's alpha channel with an image inspection tool: verify fully transparent background pixels, transparent corners where the composition leaves them empty, and appropriately opaque subject regions. Open the image with `read` and inspect subject coverage, holes, fine edges, halos, and stray speckles. A painted checkerboard or plain background is not transparency. Complete when both alpha inspection and visual inspection pass, or a specific defect is identified.
3. **Refine.** For a defect, request a targeted correction through the same helper while preserving the complete brief and invariants. Follow the render loop's retry bound in `SKILL.md`; report persistent failure rather than switching to local background removal. Complete when the result passes validation or the limitation is reported.

## Transparency brief

```text
Render the requested subject isolated on a genuinely transparent background with an alpha channel.
Keep the subject intact with clean edges and generous transparent padding.
Preserve appropriate opacity within the subject and transparency through open spaces.
No backdrop, floor plane, cast shadow, checkerboard pattern, edge halo, or stray pixels.
No watermark or text unless explicitly requested.
```

For edits, explicitly preserve identity, geometry, colors, and label text. For translucent subjects or requested shadows, adapt the opacity and shadow requirements to the brief rather than forcing those regions opaque or removing them.

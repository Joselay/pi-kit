# Prompting

Use the cues relevant to the brief; they are not extra acceptance requirements. Prefer visible states (`unretouched skin texture`, `plain white backdrop`, `only the supplied labels`) over generic quality claims. Use exclusions for exact failure boundaries.

## Photography and products

For photorealism, specify plausible viewpoint, framing, lighting, focus, and material texture. Add studio polish only when the intended use calls for it.

For people, resolve body framing, scale, gaze, and object interaction where they matter. For products, resolve materials, silhouette, packaging, and label readability.

## Exact text

Quote literal strings and specify typography, placement, and hierarchy. Require verbatim rendering with only the requested copy; spell uncommon words letter-by-letter when useful. Inspect every required string.

Dense labels, legends, axes, and footnotes need readable spacing. Use supplied labels and data for charts or slides; ask for missing data that blocks correctness.

For localization, map source strings to replacements. Preserve imagery, layout, typography, spacing, and hierarchy, allowing reflow only where replacements require it.

## Layout

| Asset | Resolve in the brief |
| --- | --- |
| UI mockup or wireframe | Fidelity, device, sections, hierarchy, controls, and labels. Generate screens separately unless an overview is requested. |
| Infographic or workflow | Audience, reading order, labeled parts, and connection meanings and directions. |
| Slide or chart | Canvas, supplied data, hierarchy, labels, and spacing. |
| Scientific illustration | Audience, lesson objective, accurate relationships, labels, and arrow meanings. |
| Historical scene | Place, date, and period constraints on clothing, objects, and environment. |
| Advertisement | Supplied brand positioning, audience, mood, and exact copy. |
| Raster logo concept | Silhouette, balanced negative space, and clarity at small sizes. |
| Story illustration | Concrete action per scene or panel and reading order. |
| Stylized concept | Medium, palette, surface finish, and lighting grounded in the request. |

For website assets, reserve space for copy or UI according to the surrounding layout.

## Game assets

Match the game's rendering style, then resolve:

- **Environment:** focal point and camera perspective.
- **Character:** body coverage, silhouette, equipment, and continuity with attached anchors.
- **Icon or sprite:** clarity at display size, padding, and [verified transparency](transparency.md) when alpha is required.
- **Tileable texture:** consistent scale and lighting; inspect a repeated-grid preview for seams and distracting repetition.

## Inputs and invariants

An **anchor** supplies features to retain; a **reference** supplies features to borrow. Specify which properties matter: a style reference need not contribute its subject or composition. Preserve only properties unaffected by the requested change—a new pose cannot also be an invariant.

| Operation | Edit-specific cues |
| --- | --- |
| Identity-preserving edit | Retain facial features, body proportions, and other identity cues. Lock pose, hair, expression, or clothing only where unchanged. |
| Object replacement or removal | Identify the object or region; retain surrounding texture, objects, framing, and lighting; integrate shadows. |
| Lighting or weather | Retain identity, geometry, and camera framing. |
| Style transfer | Identify palette, texture, brushwork, or rendering cues to borrow and content to retain. |
| Compositing | Identify base and inserted subject by index; reconcile placement, perspective, scale, lighting, and shadows while retaining base framing. |
| Sketch to render | Retain layout, proportions, and perspective; specify materials and lighting. |
| Character continuity | Attach a previous character anchor; retain identity, proportions, outfit, and palette unless explicitly changed. Allow the requested action and pose. |
| Background extraction | Retain identity, geometry, colors, and label text; apply [Transparency](transparency.md). |

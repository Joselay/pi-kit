# Prompting

Use the sections matching the asset. These are prompt-writing cues, not helper options or extra acceptance requirements.

## Creative brief

Use only fields that affect the result:

```text
Asset: <intended use>
Request: <subject and requested result>
Inputs: <Image 1: role; Image 2: role, in attachment order>
Scene: <setting and relevant objects>
Style: <medium, materials, lighting, palette>
Composition: <framing, viewpoint, hierarchy, usable negative space>
Text (verbatim): "<literal copy>"
Change: <specific edit>
Preserve: <edit invariants>
Constraints: <other required visible states or hard exclusions>
```

Prefer the desired visible state: `unretouched skin texture`, `plain white backdrop`, `only the supplied labels`. Use exclusions when they define an exact failure boundary. Examples illustrate structure; their scene details are not defaults.

## Photography and products

Say `photorealistic` when that is the target. Describe plausible capture conditions: viewpoint, framing, lighting, and focus. Ground realism in relevant texture—skin pores, fabric wear, wood grain—rather than generic claims of quality.

For people, specify body framing, scale, gaze, and object interaction when acceptance depends on them. For products, specify materials, silhouette, packaging, and label readability. Add studio polish only when the intended use calls for it.

## Exact text

Quote each literal string and specify typography, placement, and hierarchy. Require verbatim rendering with only the requested copy; spell uncommon words letter-by-letter when useful.

Dense labels, legends, axes, and footnotes need explicit readability and spacing. Provide real labels and data for charts or slides; request missing data when it blocks correctness rather than inventing facts. Visual inspection must check every required string, not merely the overall layout.

For localization, map each source string to its replacement. Preserve imagery, layout, typography, spacing, and hierarchy; allow reflow only where the replacement requires it.

## Layout and domain cues

| Asset | Brief must resolve |
| --- | --- |
| UI mockup or wireframe | Fidelity first, then device, sections, hierarchy, controls, and labels. Distinguish a low-fi sketch from a polished raster mockup. |
| Infographic or workflow | Audience, reading order, labeled parts, and the meaning and direction of connections. |
| Slide or chart | Canvas, supplied data, visual hierarchy, readable labels, and spacing. |
| Scientific illustration | Audience, lesson objective, accurate relationships, required labels, and arrow meanings. |
| Historical scene | Place, date, and period constraints on clothing, objects, and environment. |
| Advertisement | Supplied brand positioning, audience, mood, and exact copy. |
| Raster logo concept | Strong silhouette, balanced negative space, and simplicity at small sizes. A vector-like style still yields a bitmap. |
| Story illustration | Concrete action in each scene or panel and a clear reading order. |
| Stylized concept | Rendering medium, palette, surface finish, and lighting; keep story elements grounded in the request. |

For website assets, reserve space for copy or UI where the surrounding layout requires it. Choose left/right placement from that layout, not habit.

## Inputs and invariants

Distinguish an **anchor** (features to retain) from a **reference** (features to borrow). Name each image's role and which of its properties matter; a style reference need not contribute its subject or composition.

| Operation | State the change and lock the unaffected properties |
| --- | --- |
| Identity-preserving edit | Preserve facial features, body proportions, and other identity cues. Lock pose, hair, expression, and clothing only where the requested change leaves them invariant. |
| Object replacement or removal | Identify the exact object or region. Preserve surrounding objects, texture, framing, and lighting; integrate the edit's shadows. |
| Lighting or weather | Change environmental conditions while preserving subject identity, geometry, and camera framing. |
| Style transfer | Identify the palette, texture, brushwork, or rendering cues to borrow and the content to retain. |
| Compositing | Identify the base and inserted subject by index. Specify placement and reconcile perspective, scale, lighting, and shadows while retaining base framing. |
| Sketch to render | Preserve layout, proportions, and perspective; specify materials and lighting for the rendered result. |
| Character continuity | Attach a previous character anchor. Preserve identity, proportions, outfit, and palette unless the new scene explicitly changes them; allow the requested action and pose. |
| Background extraction | Preserve subject identity, geometry, colors, and label text; use [Transparency](transparency.md) for the background and alpha checks. |

For every edit, distinguish intentional changes from drift during inspection. A new pose cannot simultaneously be an invariant.

# Prompting best practices

## Specificity policy
- If the user prompt is already specific and detailed, normalize it into a clean spec without adding creative requirements.
- If the prompt is generic, you may add tasteful detail when it materially improves the output.
- Treat examples in `sample-prompts.md` as fully-authored recipes, not as the default amount of augmentation to add to every request.
- For photorealism, include `photorealistic` directly when that is the goal, plus concrete real-world texture such as pores, wrinkles, fabric wear, material grain, or imperfect everyday detail.

## Allowed and disallowed augmentation

Allowed augmentation for generic prompts:
- composition and framing cues
- intended-use or polish-level hints
- practical layout guidance
- reasonable scene concreteness that supports the request

Do not add:
- extra characters, props, or objects that are not implied
- brand palettes, slogans, or story beats that are not implied
- arbitrary side-specific placement unless the surrounding layout supports it

## Composition and layout
- Specify framing and viewpoint (close-up, wide, top-down) and placement only when it materially helps.
- Call out negative space if the asset clearly needs room for UI or copy.
- Avoid making left/right layout decisions unless the user or surrounding layout supports them.
- For people, describe body framing, scale, gaze, and object interactions when they matter (`full body visible`, `looking down at the book`, `hands naturally gripping the handlebars`).

## Text in images
- Put literal text in quotes or ALL CAPS and specify typography (font style, size, color, placement).
- Spell uncommon words letter-by-letter if accuracy matters.
- For in-image copy, require verbatim rendering and no extra characters.
- For small text, dense infographics, data-heavy slides, multi-font layouts, legends, axes, and footnotes, make readable typography and hierarchy especially explicit.

## Use-case tips
Generate:
- photorealistic-natural: Prompt as if a real photo is captured in the moment; use photography language (lens, lighting, framing); call for real texture; avoid over-stylized polish unless requested.
- product-mockup: Describe the product/packaging and materials; ensure clean silhouette and label clarity; if in-image text is needed, require verbatim rendering and specify typography.
- ui-mockup: Describe the target fidelity first (shippable mockup or low-fi wireframe), then focus on layout, hierarchy, and practical UI elements; avoid concept-art language.
- infographic-diagram: Define the audience and layout flow; label parts explicitly; require verbatim text; make dense labels and hierarchy explicit.
- logo-brand: Keep it simple and scalable; ask for a strong silhouette and balanced negative space; avoid decorative flourishes unless requested.
- ads-marketing: Write like a creative brief; include brand positioning, audience, desired vibe, scene, and exact tagline if text must appear.
- productivity-visual: Name the exact artifact (slide, chart, workflow diagram), define the canvas and hierarchy, provide real labels/data, and ask for readable typography and polished spacing.
- scientific-educational: Define audience, lesson objective, required labels, scientific constraints, arrows, and scan-friendly whitespace.
- illustration-story: Define panels or scene beats; keep each action concrete.
- stylized-concept: Specify style cues, material finish, and rendering approach (3D, painterly, clay) without inventing new story elements.
- historical-scene: State the location/date and required period accuracy; constrain clothing, props, and environment to match the era.

Edit:
- text-localization: Change only the text; preserve layout, typography, spacing, and hierarchy; no extra words or reflow unless needed.
- identity-preserve: Lock identity (face, body, pose, hair, expression); change only the specified elements; match lighting and shadows.
- precise-object-edit: Specify exactly what to remove/replace; preserve surrounding texture and lighting; keep everything else unchanged.
- lighting-weather: Change only environmental conditions (light, shadows, atmosphere, precipitation); keep geometry, framing, and subject identity.
- background-extraction: Request a clean cutout on a perfectly flat chroma-key background per `transparency.md`; crisp silhouette; generous padding; preserve label text exactly; no restyling.
- style-transfer: Specify style cues to preserve (palette, texture, brushwork) and what must change; add `no extra elements` to prevent drift.
- compositing: Reference inputs by index; specify what moves where; match lighting, perspective, and scale; keep the base framing unchanged.
- sketch-to-render: Preserve layout, proportions, and perspective; choose materials and lighting that support the supplied sketch without adding new elements.

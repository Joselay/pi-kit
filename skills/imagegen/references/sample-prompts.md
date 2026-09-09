# Starting briefs

Use these when a generic asset request needs structure. Replace placeholders with user or project requirements and omit unsupported fields. Each block describes one raster deliverable; implementation code and vector assets follow the scope boundary in `SKILL.md`.

## Website image

Choose the actual use: hero, section illustration, product image, or editorial header. Reserve copy space only when required by the page layout.

```text
Asset: <website slot>
Request: <requested subject>
Style: <photo, illustration, or rendered material; project-supported palette>
Composition: <framing appropriate to the slot; copy-safe region from the layout>
Constraints: <required visible content; whether copy is supplied separately by the page>
```

For an abstract hero background, emphasize texture, contrast, and usable negative space. For a product slot, emphasize silhouette and material fidelity. For an editorial header, ground the scene in the article's subject rather than adding unrelated decorative props.

## Game asset

```text
Asset: <environment concept, character, painted UI icon, or tileable texture>
Request: <requested biome, character, object, or material>
Style: <rendering medium and finish consistent with the game>
Composition: <camera angle, framing, and margins appropriate to the asset>
Preserve: <features from attached continuity anchors, if any>
Constraints: <production requirements relevant to this asset>
```

Choose the matching acceptance cues:

- **Environment:** readable focal point and requested camera perspective.
- **Character:** required body coverage, silhouette, equipment, and anchor consistency.
- **Icon:** clarity at intended display size and sufficient padding.
- **Texture:** consistent scale and lighting; for tiling, inspect a repeated-grid preview for seams and obvious repeating focal points.

For isolated sprites or icons requiring alpha, load [Transparency](transparency.md) before rendering.

## Wireframe

```text
Asset: raster wireframe of <page or screen>
Request: <page purpose>
Style: low-fidelity grayscale wireframe
Composition: <target device; sections in reading order>
Text (verbatim): <required navigation, section, and control labels>
Constraints: schematic placeholders for imagery; clear hierarchy and readable labels
```

Use the user's or project's section list. For a multi-screen flow, give each requested screen its own manifest entry unless the deliverable is explicitly a single overview image.

## Raster logo concept

```text
Asset: bitmap logo concept for <supplied brand>
Request: <symbol, monogram, or wordmark requested by the user>
Style: flat-color, vector-like appearance
Composition: centered mark, balanced negative space, clear silhouette at small sizes
Text (verbatim): "<supplied letters or name, if required>"
Constraints: <supplied palette and brand requirements>
```

A symbol brief needs its requested visual idea; a monogram needs exact letters; a wordmark needs exact spelling. Describe only the requested treatment rather than adding a mockup scene.

## Edit example: object replacement

This fully authored example demonstrates the change/invariant split. Its room and furniture are illustrative, not defaults.

```text
Asset: edited room photograph
Inputs: Image 1: original room and edit target
Request: replace the white chairs with wooden chairs
Change: only the white chairs, with shadows adjusted to integrate their replacements
Preserve: camera angle, room geometry, lighting direction, floor texture, and surrounding objects
Constraints: photorealistic materials and perspective consistent with Image 1
```

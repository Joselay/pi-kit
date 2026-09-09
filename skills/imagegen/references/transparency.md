# Transparency

Use these rules inside the main render loop when a bitmap needs a transparent background. Request alpha through the helper's existing request shape and preserve the returned PNG's alpha channel.

## Brief

Add the following requirements to the subject brief:

```text
Isolate the subject on a genuinely transparent background with an alpha channel.
Keep the complete silhouette inside the canvas with generous transparent padding.
Keep solid subject regions opaque and open spaces transparent, with clean fine edges.
The background is empty: no backdrop, floor plane, painted checkerboard, or cast shadow.
Edges are free of halos and stray pixels. Include text only where the brief requests it.
```

For extraction, name the identity, geometry, colors, and label text to preserve. Adapt opacity requirements for translucent materials and shadow requirements for requested shadows; those features belong to the subject brief.

## Acceptance

Perform both checks on every candidate selected for transparent delivery:

1. **Alpha inspection.** Use an available image inspection tool to examine channel values, not just metadata. Verify fully transparent background pixels, transparent corners where empty, and appropriate opacity within the subject. Channel presence alone is insufficient: an alpha channel can be opaque everywhere.
2. **Visual inspection.** Open with `read` and check the complete subject, open spaces, hair or other fine edges, halos, and stray speckles. If the viewer obscures edge defects, inspect previews composited over contrasting light and dark backgrounds while preserving the original PNG.

**Pass:** actual alpha values and visible edges both satisfy the brief. A painted checkerboard or solid backdrop fails, even if it looks like a cutout. If channel inspection is unavailable, report transparency as unverified.

For a defect, return its specific correction to the main loop and use that loop's retry bound. Keep extraction generative through the helper; do not substitute local background removal. Report persistent alpha defects as limitations rather than claiming transparent delivery.

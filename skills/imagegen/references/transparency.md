# Transparency

Request transparency on every render and refinement; verify actual alpha before delivery.

## Brief

Adapt these requirements to the subject, including any translucent materials or requested shadows:

```text
Isolate the complete subject on a transparent background with an alpha channel
and generous transparent padding. Keep solid regions opaque, open spaces
transparent, and fine edges clean. Leave the background empty, without a
backdrop, floor, painted checkerboard, or cast shadow. Keep edges free of
halos and stray pixels; include only requested text.
```

For extraction, specify the identity, geometry, colors, and label text to preserve.

## Acceptance

Perform both checks on every candidate selected for transparent delivery:

1. **Alpha:** inspect channel values with an available image tool. Verify fully transparent background pixels, transparent corners where empty, and appropriate subject opacity. Channel presence alone is insufficient.
2. **Edges:** use the main loop's visual inspection to check the complete silhouette, open spaces, fine edges, halos, and speckles. If needed, inspect copies composited over contrasting light and dark backgrounds while preserving the original.

Pass only when alpha values and visible edges satisfy the brief. A painted checkerboard or solid backdrop fails. If channel inspection is unavailable, report transparency as unverified.

Return defects to the main loop as targeted corrections under its retry bound. Keep extraction generative through the helper rather than substituting local background removal; report persistent defects as limitations.

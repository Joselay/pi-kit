# Transparent images

`gpt-image-2` exposes no native transparency here: generate a chroma-key source image, then convert the key color to alpha locally.

1. Generate the subject on a perfectly flat solid chroma-key background. Default key `#00ff00`; use `#ff00ff` for green subjects and avoid `#0000ff` for blue subjects.
2. Remove the background locally, writing the alpha result to a new name under `~/.pi/generated_images/`:
   ```bash
   uv run <skill-directory>/remove_chroma_key.py \
     --input <source> \
     --out <final.png> \
     --auto-key border \
     --soft-matte \
     --transparent-threshold 12 \
     --opaque-threshold 220 \
     --despill
   ```
3. Validate with `read`: alpha channel present, transparent corners, plausible subject coverage, no key-color fringe. If a thin fringe remains, retry once with `--edge-contract 1`; add `--edge-feather 0.25` only when the edge is visibly stair-stepped and the subject is not shiny or reflective.

Prompt transparent requests like this:

```text
Create the requested subject on a perfectly flat solid #00ff00 chroma-key background for background removal.
The background must be one uniform color with no shadows, gradients, texture, reflections, floor plane, or lighting variation.
Keep the subject fully separated from the background with crisp edges and generous padding.
Do not use #00ff00 anywhere in the subject.
No cast shadow, no contact shadow, no reflection, no watermark, and no text unless explicitly requested.
```

Chroma keying may be imperfect for hair, fur, feathers, smoke, glass, liquids, translucent or reflective materials, soft shadows, realistic product grounding, or subject colors that conflict with practical key colors. Explain the limitation when it applies.

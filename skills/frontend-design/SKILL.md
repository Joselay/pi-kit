---
name: frontend-design
description: Frontend design for creating new web UI or materially reshaping existing pages, components, and applications; use when visual direction, layout, typography, color, motion, or coded polish is a substantive part of the task.
---

# Frontend Design

Build a coherent, rendered interface whose visual choices belong to this subject and this brief.

## Priorities

1. **Brief wins.** Honor explicit requirements, brand rules, and requested references.
2. **Task first.** Protect the primary user task, content hierarchy, usability, and accessibility.
3. **Subject-specific.** Derive the direction from the subject's materials, artifacts, language, audience, and context.
4. **Signature.** Concentrate distinction in one memorable move; keep supporting elements disciplined.

## Workflow

### 1. Frame

Inspect the existing implementation before proposing a direction. Find the current UI, assets, fonts, tokens, component conventions, and technical constraints. Preserve useful inherited decisions.

Identify:

- the subject and audience;
- the interface's primary task;
- whether the work is marketing/editorial, product/workflow, or component/system UI;
- which constraints are explicit and which choices remain open.

When the brief leaves these open, choose a concrete framing rather than designing for an abstract product, and record the assumption.

**Done when:** the subject, audience, primary task, interface context, inherited system, and every explicit constraint are accounted for.

### 2. Direct

Consider at least two materially different directions, then select the one best supported by the frame. Present only the selected direction unless comparison would help the user decide.

Create a compact plan:

- **Concept:** one sentence tying the aesthetic to the subject.
- **Color:** named tokens with actual values and clear roles.
- **Type:** display, body, and utility roles as needed, including weights, widths, and scale. One family may fill several roles when that choice is intentional.
- **Layout:** the governing composition in prose; add a small ASCII wireframe when inventing a page structure.
- **Signature:** one element or interaction the interface will be remembered by.
- **Behavior:** the role of motion, including the valid choice of no motion.

Apply the **traceability test**: every prominent choice must come from the brief, the subject, the content, or the inherited system. Revise any choice that could be transferred unchanged to an unrelated project.

**Done when:** each prominent choice is traceable, the signature strengthens the concept without competing with the primary task, and the plan covers all open design axes.

### 3. Build

Implement the selected direction in the project's existing stack. Treat the plan as a baseline and revise it when rendered evidence exposes a better solution.

- Use real subject matter and provided assets. When content is missing, create specific, credible content rather than generic filler.
- Encode repeated decisions as tokens or shared primitives.
- Make structure communicate: labels, dividers, numbering, and grouping should express real relationships in the content.
- Give visual emphasis a hierarchy. Spend the boldest treatment on the signature and primary task.
- Implement relevant states, including hover, focus, active, disabled, loading, empty, and error states where the interface needs them.
- Make responsive behavior intentional rather than a scaled-down desktop composition.
- Use motion to clarify change, guide attention, or express the concept. Favor one orchestrated moment over unrelated effects, and provide a reduced-motion path.

If creating or changing user-facing words, read [COPY.md](COPY.md) before writing them.

**Done when:** the required content, interactions, states, and responsive structure are implemented, with recurring visual decisions derived from the plan.

### 4. Render and critique

Render before declaring the work complete. When browser access exists, inspect screenshots at one representative wide viewport and one narrow viewport, plus the states central to the task.

Check every rendered surface for:

- a clear primary task and hierarchy;
- clipping, overflow, collisions, awkward wrapping, and dead space;
- readable type, usable contrast, and consistent spacing;
- keyboard operation and visible focus;
- coherent hover, active, disabled, loading, empty, and error states where applicable;
- reduced-motion behavior;
- whether the signature still feels subject-specific and proportionate.

Simplify or remove any decorative choice that fails the traceability test. Fix issues and render again until the checks pass.

**Done when:** representative wide and narrow renders pass every applicable check. If rendering or interaction testing is unavailable, report exactly what remains unverified.

## Direction reference

### Marketing and editorial pages

Treat the opening as a thesis: lead with the most characteristic idea, artifact, image, demonstration, or interaction from the subject's world. Let the rest of the page prove that thesis. A conventional hero pattern is appropriate only when it communicates the subject better than a more specific composition.

### Product and workflow UI

Let task frequency, consequence, and state drive emphasis. Distinction should improve orientation and comprehension rather than turn routine controls into spectacle. Design the dense, empty, loading, and failure cases as parts of the same system.

### Component and existing-system work

Preserve surrounding conventions unless the brief explicitly changes them. Put novelty inside the component's available visual and behavioral budget so it still belongs in the host interface.

### Visual language

Typography carries personality: select faces and treatments for the subject, then tune scale, measure, weight, and spacing with equal care. Color and imagery should have roles, not merely atmosphere. Structural devices should encode meaning. Match execution complexity to the direction: expressive systems need enough detail to feel intentional; restrained systems depend on exact spacing, rhythm, and proportion.

## Handoff

Summarize the chosen direction, changed files, rendered checks, and any unverified limitations. Keep process notes internal unless the user asks for alternatives or rationale.

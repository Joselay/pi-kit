---
name: refactor
description: Behavior-preserving, subtraction-first refactoring of an existing codebase.
disable-model-invocation: true
---

# Refactor

Improve an existing codebase through **subtraction-first** refactoring. Preserve intended behavior while reducing the amount and complexity of code the project must carry.

## Workflow

1. **Set the boundary and baseline.**
   - Read repository instructions, manifests, build configuration, entry points, and representative tests before editing.
   - Inspect version-control status and preserve pre-existing work outside the requested boundary.
   - Identify behavior and public interfaces that must remain stable. Ask the minimum focused questions needed when scope or compatibility cannot be inferred safely.
   - Run the cheapest representative checks and record pre-existing failures.

   **Done when:** the scope and protected contracts are explicit, relevant validation commands are identified, baseline results are recorded, and existing work is classified as inside or outside the boundary.

2. **Build an evidence map.**
   - Trace the affected execution paths and ownership boundaries before choosing changes.
   - Find candidates using compiler or linter diagnostics, reference searches, dependency/configuration inspection, tests, and direct code reading.
   - For every deletion candidate, check source imports and calls, tests, package exports, build configuration, scripts, documentation, assets, reflection, dynamic loading, framework conventions, and external/public use where applicable.
   - Consult history when a suspicious file or compatibility layer has unclear intent.

   **Done when:** every planned deletion is proven unreachable, or has explicit approval plus a replacement or migration plan; every planned refactor names the complexity it removes.

3. **Plan subtraction-first.** Apply this preference order:
   1. Delete proven dead code, unused files, stale exports, and unused dependencies.
   2. Inline needless indirection and collapse redundant branches or data transformations.
   3. Simplify control flow, names, interfaces, and module responsibilities.
   4. Consolidate genuine duplication.
   5. Extract a reusable abstraction only when multiple real callers share a stable concept and the extraction reduces total complexity.

   Keep changes in coherent, reviewable slices. Prefer local clarity over speculative generality or mechanical DRYness. For a whole-repository request, partition the work into explicit slices and expose any uncompleted slices rather than implying the entire repository is clean.

   **Done when:** each proposed slice has a concrete simplification, a behavior-preservation argument, and a validation method.

4. **Refactor safely.**
   - Add or strengthen characterization tests before changing behavior-sensitive code whose contract is not already covered.
   - Make the smallest complete change: update references, exports, configuration, tests, documentation, and dependencies together.
   - Keep generated, vendored, migration, fixture, plugin-registration, and compatibility code live unless its source of truth and lifecycle prove it removable.
   - Preserve public APIs and serialized formats unless the user explicitly includes a breaking change.
   - Match repository conventions and keep unrelated formatting churn outside the diff.

   **Done when:** each slice is internally complete, all references resolve, and the implementation is simpler without moving complexity into a new abstraction.

5. **Prove the result.**
   - Run focused checks after each risky slice, then the repository's relevant full test, typecheck, lint, and build commands.
   - Search again for removed symbols, paths, exports, dependencies, and stale documentation references.
   - Inspect the complete diff and final version-control status. Compare failures with the recorded baseline and investigate every new failure.
   - Re-read changed code for duplicated logic, misleading names, widened APIs, or abstractions with only one incidental caller.

   **Done when:** relevant checks introduce no regressions, every changed line belongs to the cleanup boundary, and each retained abstraction earns its complexity.

## Completion Report

Summarize:

- files or symbols removed and the evidence that each non-obvious deletion was safe;
- important simplifications and reusable boundaries introduced;
- checks run and their results, including baseline failures;
- retained candidates whose removal was uncertain and why;
- remaining slices when the requested scope was larger than the completed safe pass.

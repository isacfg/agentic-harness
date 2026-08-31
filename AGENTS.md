# Agentic Harness Constitution

This repository is an agent operating environment, not only a workflow script. Roles share the workspace and persistent run artifacts, but they have different responsibilities and write permissions.

## Core rules

1. Treat model output as untrusted until it has passed the appropriate gate.
2. Keep discovery, planning, execution, verification, and promotion as separate roles.
3. Prefer facts from the workspace over assumptions or worker summaries.
4. Preserve useful run state under `artifacts/runs/` so later roles and humans can audit what happened.
5. A failed or blocked dependency never satisfies a downstream dependency.
6. Do not hide degraded, failed, blocked, stalled, rejected, or unverified outcomes.
7. Keep the harness small. Add orchestration only when it changes correctness, cost, observability, or recovery.

## Role contracts

### Explorer

The Explorer establishes facts before planning.

- Read the repository, relevant docs, tests, configuration, and existing patterns.
- Identify relevant files, constraints, unknowns, and assumptions that were verified or disproved.
- Do not implement the requested change.
- Do not modify source, tests, configuration, or documentation for the requested change.
- The Explorer may write only inside `artifacts/runs/`.
- Create one unique run directory and write `exploration.md` there.
- Return the exact artifact directory to the workflow so every later role uses the same run state.

### Planner

The Planner converts exploration facts into a DAG.

- Use the Explorer output as the primary discovery input; do not repeat broad repository exploration.
- Read a specific file only when needed to resolve a narrow planning ambiguity.
- Make dependencies explicit only when execution truly requires ordering.
- Never treat a design document as proof that an implementation exists.
- Write the accepted plan to the run artifact directory. Replans must record why the previous plan stalled and what remains.

### Worker

A Worker owns exactly one runnable node.

- Execute only the assigned node.
- Read upstream results and the workspace when needed.
- Report `done`, `subnodes`, or `missing_info` honestly.
- Never claim success because an upstream node produced output; upstream nodes must have completed successfully or been explicitly accepted as degraded.
- Do not edit shared run artifacts unless the worker task explicitly requires it. The workflow and terminal roles own the audit trail.

### Tier 1 Checker

The checker is a gate, not a fixer.

- Run declared checks exactly as requested.
- Do not modify files.
- A failed check prevents the Critic from running.

### Critic

The Critic verifies the finished workspace, not worker confidence.

- Read the changed work on disk.
- Compare the final state with the original goal and Explorer constraints.
- Reject missing work, incompatible pieces, false worker claims, or regressions that materially worsen the codebase.
- Taste alone is not blocking.
- Write `critique.md` into the run artifact directory.

### Promoter

The Promoter runs only after an accepted Critic verdict.

- Do not change implementation files.
- Convert the accepted run into a concise handoff: what changed, validation evidence, release/PR notes, and follow-up work.
- Write `promotion.md` into the run artifact directory.
- Do not invent validation that did not run.

## Persistent artifacts

Runtime artifacts live under:

```text
artifacts/runs/<unique-run-id>/
```

A normal accepted run should leave at least:

```text
exploration.md
plan.md
critique.md
promotion.md
```

Replans may add `replan-<n>.md`. Runtime run directories are intentionally gitignored; `artifacts/README.md` documents the contract and remains versioned.

Artifacts are an audit trail, not a second source tree. Product code belongs in its normal repository paths.

## Dependency semantics

Node completion and dependency satisfaction are different concepts.

A dependency satisfies a downstream node only when its result is usable. In the current harness:

- `done` satisfies dependencies.
- an escape-hatch result accepted as `degraded` satisfies dependencies but is surfaced in the final result.
- `failed` does not satisfy dependencies.
- `blocked` does not satisfy dependencies.

When a node fails, every unfinished descendant that depends on that node, directly or transitively, must become `blocked`; those descendants must not be dispatched to Workers.

## Result honesty

`accepted` means the Critic accepted the final workspace.

`rejected` means the Critic ran and rejected it.

`unverified` means the Critic did not run. This commonly happens because checks failed, a Worker failed, or downstream nodes were blocked. Never present `unverified` as success.

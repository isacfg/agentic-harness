---
name: harness
description: "Use only when explicitly invoked."
---

# Harness

A DAG-driven BB workflow for structured multi-agent work:

```text
Explore → Plan → Work → Check → Critique → Promote
```

Use it for tasks with real internal structure: multiple independent pieces, dependency chains, or work where an independent verification pass is worth the overhead. Do not use it for a single small edit or one-pass question.

## Running it

The workflow must exist in the project's `.bb/workflows` directory.

```bash
mkdir -p .bb/workflows
cp ~/.claude/skills/harness/harness.js .bb/workflows/harness.js
bb workflows validate --name harness
```

Then run `bb_workflow_run` with `name: "harness"` and a real JSON args object:

```text
name: "harness"
args: {
  "goal": "Migrate every API route from the old error middleware to the new Result type",
  "context": "Routes live in src/api/. The new type is in src/lib/result.ts.",
  "checks": ["npm run typecheck", "npm test"]
}
```

After the call returns, emit its `previewDirective` once on its own line, outside a code fence.

## Arguments

| Arg | Default | Meaning |
|---|---|---|
| `goal` | required | The requested outcome. |
| `context` | `""` | Background and constraints shared across roles. |
| `checks` | `[]` | Commands that must pass before Critique. |
| `maxNodes` | 40 | Maximum graph size including sub-nodes. |
| `maxDepth` | 2 | Maximum sub-node nesting depth. |
| `maxReplans` | 2 | Maximum `missing_info` replans. |
| `contextChars` | 6000 | Upstream-result budget per Worker prompt. |
| `tiered` | true | `false` inherits the origin thread model for all roles. |

## Roles

**Explorer** performs broad discovery first. It verifies repository facts, relevant files, constraints, and unknowns without implementing the goal. It creates a unique persistent directory under `artifacts/runs/`, writes `exploration.md`, and returns that exact path.

**Planner** plans from the Explorer findings rather than repeating broad exploration. It returns a validated DAG and writes `plan.md`; bounded replans write `replan-N.md`.

**Workers** execute runnable nodes in parallel. They return `done`, `subnodes`, or `missing_info`. Subnodes extend the graph. `missing_info` can trigger a bounded replan.

**Tier 1 Checker** runs declared checks without fixing files. A failed check prevents Critique.

**Critic** verifies the workspace on disk, not Worker summaries, and writes `critique.md`.

**Promoter** runs only after the Critic accepts. It does not modify implementation files; it writes `promotion.md` with a concise handoff, release/PR notes, actual validation evidence, and follow-ups.

## Dependency semantics

Do not equate "has a result" with "satisfied dependency".

- successful nodes satisfy dependencies;
- degraded nodes satisfy dependencies but remain visible in the final result;
- failed nodes do not satisfy dependencies;
- blocked nodes do not satisfy dependencies.

When a Worker fails, every unfinished descendant that depends on it directly or transitively is marked `blocked` and must not be dispatched. Failed or blocked execution remains `unverified`; do not describe it as successful.

## Persistent artifacts

Accepted runs normally leave:

```text
artifacts/runs/<run-id>/
├── exploration.md
├── plan.md
├── critique.md
└── promotion.md
```

The workflow returns the artifact paths. Runtime run directories are gitignored but persist in the workspace.

## Reading the result

`outcome` is one of:

- `accepted` — Critic accepted the final workspace;
- `rejected` — Critic ran and rejected it;
- `unverified` — Critic did not run.

Also inspect `failed`, `blocked`, `degraded`, `stalled`, `checks`, `critic`, `promotion`, and `artifacts`. Do not gloss over any non-empty failure/degradation fields.

## Model tiering

Tiering is hardcoded in `roleAgent()` because BB requires literal provider/model/reasoning values. Planner and Critic use high reasoning; Explorer, Workers, and Promoter use medium by default. Set `tiered: false` to inherit the origin thread selection.

## Resume

Runs are durable. Resume with the same source and `resumeRunId`. Replayed Explorer output keeps later roles pointed at the same persistent artifact directory. Prompt/source changes can invalidate cached calls from the first changed call onward.

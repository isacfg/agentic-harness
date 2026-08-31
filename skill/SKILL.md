---
name: harness
description: "Use only when explicitly invoked."
---

# Harness

Run the same agentic lifecycle on either **BB Workflows** or **Claude Code Dynamic Workflows**:

```text
Explore → Plan → Work → Check → Critique → Promote
```

The workflow runtime is chosen before the run. Model selection is also resolved before the run; never silently guess a provider or model.

## Mandatory preflight

Before every new run:

1. Determine the runtime: `bb` or `claude`. If the user did not specify one, ask.
2. Discover the models that are actually available for that runtime/account.
3. Show the available choices compactly.
4. Ask for two model tiers:
   - **Reasoning** — Planner + Critic.
   - **Execution** — Explorer + Workers + Promoter + Checker.
5. Offer **inherit current/session model** for either or both tiers.
6. Only after the user chooses, prepare and validate the runtime-specific workflow and run it.

Do not start the harness before this preflight is complete.

## BB Workflows preflight

BB model overrides are exact tuples. Discover the live catalog first:

```bash
bb provider list --environment "$BB_ENVIRONMENT_ID" --json
bb provider models <provider-id> --environment "$BB_ENVIRONMENT_ID" --json
```

Run the second command for the provider(s) the user may reasonably choose. If the provider list is short, inspect all of them. Never invent model ids.

Present choices in this shape:

```text
BB Workflows
Reasoning tier: provider / model / reasoning level | inherit current
Execution tier: provider / model / reasoning level | inherit current

Available providers/models:
- codex: ...
- claude-code: ...
```

BB requires all three override fields together: `provider`, `model`, and `reasoningLevel`. A tier that inherits must omit the entire tuple.

The distributed `harness.js` contains two explicitly marked literal BB profile blocks because BB requires literal selection values in `agent()` calls. Before a tiered BB run:

1. copy `harness.js` into the target project's `.bb/workflows/`;
2. rewrite `BB_REASONING_PROFILE_*` with the selected Reasoning tuple unless that tier inherits;
3. rewrite `BB_EXECUTION_PROFILE_*` with the selected Execution tuple unless that tier inherits;
4. validate the exact copied file before execution.

Do not mutate the source copy in this skill directory.

```bash
mkdir -p .bb/workflows
cp ~/.claude/skills/harness/harness.js .bb/workflows/harness.js
bb workflows validate --file .bb/workflows/harness.js
```

Run with `tiered: true` after explicit model selection:

```bash
bb workflows run --file .bb/workflows/harness.js --args '{"runtime":"bb","goal":"...","context":"...","checks":[],"tiered":true}'
```

For a mixed profile, set `inheritReasoning: true` and/or `inheritExecution: true` for the tier that should inherit the originating BB thread. If both tiers inherit, use `tiered: false` and do not patch either tuple.

After a BB workflow tool call returns, emit its `previewDirective` once on its own line.

## Claude Code Dynamic Workflows preflight

Use Claude Code's live `/model` picker as the source of truth for models available to the current account/session. Ask the user to choose from what `/model` shows rather than assuming that every Claude model or alias is enabled by their organization.

Ask for:

```text
Claude Workflows
Reasoning model: <model from /model> | inherit session
Execution model: <model from /model> | inherit session
```

Claude workflow agents inherit the session model when no model is supplied. The portable workflow accepts `reasoningModel` and `workerModel` for per-stage model routing.

Install the same source into the project:

```bash
mkdir -p .claude/workflows
cp ~/.claude/skills/harness/harness.js .claude/workflows/harness.js
```

Run the saved `/harness` workflow with args equivalent to:

```json
{
  "runtime": "claude",
  "goal": "...",
  "context": "...",
  "checks": [],
  "tiered": true,
  "reasoningModel": "<selected reasoning model>",
  "workerModel": "<selected execution model>"
}
```

If a Claude tier inherits the session model, omit that tier's model argument. If both inherit, use `tiered: false`.

Claude Dynamic Workflows must be enabled. If `/harness` does not appear after installing or editing the file, run `/reload-skills` and verify that Dynamic workflows are enabled in `/config`.

## Arguments

| Arg | Default | Meaning |
|---|---|---|
| `runtime` | auto-detected | `bb` or `claude`. |
| `goal` | required | The requested outcome. |
| `context` | `""` | Background and constraints shared across roles. |
| `checks` | `[]` | Commands that must pass before Critique. |
| `maxNodes` | 40 | Maximum graph size including sub-nodes. |
| `maxDepth` | 2 | Maximum sub-node nesting depth. |
| `maxReplans` | 2 | Maximum `missing_info` replans. |
| `contextChars` | 6000 | Upstream-result budget per Worker prompt. |
| `tiered` | `false` | Opt in to per-role model routing after preflight. |
| `reasoningModel` | omitted | Claude-only Planner/Critic model; omitted means inherit. |
| `workerModel` | omitted | Claude-only execution model; omitted means inherit. |
| `inheritReasoning` | `false` | BB-only: Reasoning tier inherits origin thread. |
| `inheritExecution` | `false` | BB-only: Execution tier inherits origin thread. |

## Roles

**Explorer** performs broad discovery first. It verifies repository facts, relevant files, constraints, and unknowns without implementing the goal. It creates a unique persistent directory under `artifacts/runs/`, writes `exploration.md`, and returns that exact path.

**Planner** plans from Explorer findings rather than repeating broad exploration. It returns a validated DAG and writes `plan.md`; bounded replans write `replan-N.md`.

**Workers** execute runnable nodes in parallel. They return `done`, `subnodes`, or `missing_info`. Subnodes extend the graph. `missing_info` can trigger a bounded replan.

**Tier 1 Checker** runs declared checks without fixing files. A failed check prevents Critique.

**Critic** verifies the workspace on disk, not Worker summaries, and writes `critique.md`.

**Promoter** runs only after the Critic accepts. It does not modify implementation files; it writes `promotion.md` with handoff notes, validation evidence, and follow-ups.

## Dependency semantics

Do not equate "has a result" with "satisfied dependency".

- successful nodes satisfy dependencies;
- degraded nodes satisfy dependencies but remain visible;
- failed nodes do not satisfy dependencies;
- blocked nodes do not satisfy dependencies.

When a Worker fails, every unfinished descendant that depends on it directly or transitively is marked `blocked` and must not be dispatched. Failed or blocked execution remains `unverified`.

## Persistent artifacts

Runs normally leave:

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

Also inspect `failed`, `blocked`, `degraded`, `stalled`, `checks`, `critic`, `promotion`, and `artifacts`. Do not gloss over non-empty failure/degradation fields.

## Resume

Both runtimes have durable/replay behavior, but use their native run controls. Preserve the same workflow source and args when resuming. The Explorer output includes the persistent artifact directory so replayed later stages continue to point at the same run artifacts.
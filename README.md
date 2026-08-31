# agentic-harness

A DAG-driven agentic harness that runs on [BB](https://getbb.app) workflows. One goal in; exploration, planning, parallel execution, verification, and a durable handoff out.

The lifecycle is:

```text
Explore → Plan → Work → Check → Critique → Promote
```

The design is influenced by Scott Fryxell's [The Harness Is the Thing](https://scott-fryxell.github.io/blog/the-harness-is-the-thing/) and Data4Sci's [Building an Advanced Agentic Harness](https://data4sci.com/blog/building-an-advanced-agentic-harness).

BB already supplies durable workflow runs, hidden worker threads, per-agent model selection, structured output, concurrency caps, resume, and an append-only trace. This repository adds the role separation and planning/execution policy around those primitives.

## Install

```bash
git clone https://github.com/isacfg/agentic-harness.git
cd agentic-harness

mkdir -p /path/to/project/.bb/workflows
cp harness.js /path/to/project/.bb/workflows/harness.js

mkdir -p ~/.claude/skills/harness
cp skill/SKILL.md harness.js ~/.claude/skills/harness/
```

Verify from the project root:

```bash
bb workflows validate --name harness
```

## Use

```bash
bb workflows run --name harness --args '{
  "goal": "Migrate every API route in src/api/ from the old error middleware to the new Result type",
  "context": "The new type is in src/lib/result.ts. Response contracts must not change.",
  "checks": ["npm run typecheck", "npm test"]
}'
```

### Arguments

| Arg | Default | What it does |
|---|---|---|
| `goal` | required | What to accomplish. |
| `context` | `""` | Background and constraints shared by roles. |
| `checks` | `[]` | Commands that must pass before Critique. |
| `maxNodes` | 40 | Ceiling on plan size, including sub-nodes. |
| `maxDepth` | 2 | Maximum Worker sub-node nesting depth. |
| `maxReplans` | 2 | Maximum `missing_info` replans. |
| `contextChars` | 6000 | Upstream-result budget per Worker prompt. |
| `tiered` | `true` | `false` inherits the origin thread model for every role. |

## Lifecycle

### Explore

The Explorer performs broad repository discovery before planning. It records verified facts, relevant files, constraints, unknowns, and disproved assumptions. It must not implement the goal.

The Explorer also creates a unique persistent directory under:

```text
artifacts/runs/<run-id>/
```

and writes `exploration.md`. The exact directory is returned as structured output and passed to every later role, which keeps resumed runs anchored to the same artifact path when the Explorer call replays.

### Plan

The Planner receives the Explorer output and turns it into a DAG. It should not repeat broad exploration. The graph is validated in JavaScript for duplicate ids, unknown dependencies, self references, cycles, and the node ceiling. An invalid initial graph receives one corrective pass.

The accepted plan is written to `plan.md`. `missing_info` replans write `replan-N.md`.

### Work

Every node whose dependencies have produced usable results runs in parallel, subject to BB's concurrency cap.

Workers return:

- `done` — node completed.
- `subnodes` — newly discovered independent work should be split out.
- `missing_info` — the plan relied on a false assumption that cannot be repaired inside the node.

Subnodes are inserted into the graph and the parent reruns after them. `missing_info` triggers a bounded replan.

### Dependency failure semantics

A result existing is not enough to satisfy a dependency.

- successful `done` results satisfy downstream dependencies;
- exhausted escape hatches accepted as `degraded` still satisfy dependencies, but remain visible in the final result;
- `failed` results do **not** satisfy dependencies;
- `blocked` results do **not** satisfy dependencies.

When a Worker fails, unfinished descendants are marked `blocked` transitively and are never dispatched. If execution contains failed or blocked nodes, checks and the Critic are skipped and the run is `unverified`.

### Check

Declared checks run before the Critic. The current BB workflow script has no direct shell access, so a dedicated checker agent runs the commands and reports without modifying files.

A failed check skips the Critic.

### Critique

The Critic reads the final workspace instead of trusting Worker summaries. It accepts or rejects the goal and writes `critique.md` into the run artifact directory.

Taste alone is not blocking.

### Promote

The Promoter runs only after an accepted Critic verdict. It does not modify implementation files. It turns the accepted run into a durable handoff containing:

- concise summary;
- release / PR notes;
- validation evidence that actually ran;
- follow-up work.

It writes `promotion.md` into the run artifact directory.

## Persistent artifacts

A normal accepted run leaves:

```text
artifacts/runs/<run-id>/
├── exploration.md
├── plan.md
├── critique.md
└── promotion.md
```

Runtime directories are gitignored; `artifacts/README.md` defines the contract and remains versioned. See `AGENTS.md` for the role constitution.

## Reading the result

`outcome` is `accepted`, `rejected`, or `unverified`.

The result also exposes:

- `artifacts` — persistent run paths;
- `exploration` — structured Explorer findings;
- `nodes` — execution trace;
- `failed` — outright Worker failures;
- `blocked` — descendants prevented from running because a dependency failed or was blocked;
- `degraded` — nodes whose escape hatch was exhausted and were accepted as-is;
- `checks` — declared check results;
- `critic` — final verification result when it ran;
- `promotion` — accepted-run handoff when it ran.

`unverified` is not success.

## Model tiering

Tiering is hardcoded in `roleAgent()` because the BB workflow runtime requires literal provider/model/reasoning values.

Planner and Critic use high reasoning. Explorer, Workers, and Promoter use medium reasoning by default. Pass `tiered: false` to inherit the origin thread selection for every role.

## Known limits

- The workflow script has no direct shell/filesystem API, so declared shell checks are executed by a checker agent.
- Execution remains level-synchronous because `parallel()` is a barrier.
- BB caps a run at 100 agent calls and 8 concurrent agents.
- Persistent run artifacts depend on agents respecting the role contract in `AGENTS.md`; the workflow cannot itself write files.

## Repository

| Path | Purpose |
|---|---|
| `harness.js` | BB workflow implementation. |
| `AGENTS.md` | Shared role constitution and dependency semantics. |
| `skill/SKILL.md` | Skill that teaches an agent how to drive the workflow. |
| `artifacts/README.md` | Persistent run artifact contract. |
| `docs/plugin-design.md` | Earlier native-plugin design. |
| `examples/smoke-test/` | Example utility built by the harness. |

## License

MIT

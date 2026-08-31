# agentic-harness

A portable DAG-driven agentic harness for **BB Workflows** and **Claude Code Dynamic Workflows**.

```text
Explore → Plan → Work → Check → Critique → Promote
```

One workflow source powers both runtimes. The runtime-specific launcher behavior lives in `skill/SKILL.md`: before a new run it discovers the models available to that runtime/account, shows them, asks which models to use for reasoning and execution, and only then starts the workflow.

The design is influenced by Scott Fryxell's [The Harness Is the Thing](https://scott-fryxell.github.io/blog/the-harness-is-the-thing/) and Data4Sci's [Building an Advanced Agentic Harness](https://data4sci.com/blog/building-an-advanced-agentic-harness).

## Runtime model

The lifecycle and result semantics are shared. Only model routing and runtime controls differ.

| Concern | BB Workflows | Claude Code Workflows |
|---|---|---|
| Project workflow path | `.bb/workflows/harness.js` | `.claude/workflows/harness.js` |
| Default model | originating BB thread | current Claude session model |
| Explicit model routing | `provider + model + reasoningLevel` | per-agent `model` |
| Model discovery | `bb provider list` + `bb provider models` | live `/model` picker |
| Resume / progress | BB workflow controls | `/workflows` |

The harness uses two logical tiers:

- **Reasoning** — Planner + Critic.
- **Execution** — Explorer + Workers + Checker + Promoter.

The launcher must resolve these tiers before starting a new run. It never guesses model ids.

## Install the skill

```bash
git clone https://github.com/isacfg/agentic-harness.git
cd agentic-harness

mkdir -p ~/.claude/skills/harness
cp skill/SKILL.md harness.js ~/.claude/skills/harness/
```

Then explicitly invoke the `harness` skill and give it a goal. The skill asks which runtime to use when that was not already specified.

## BB Workflows

Before a tiered run, inspect the live catalog:

```bash
bb provider list --environment "$BB_ENVIRONMENT_ID" --json
bb provider models <provider-id> --environment "$BB_ENVIRONMENT_ID" --json
```

The skill shows the available choices and asks for the exact Reasoning and Execution tuples. BB requires literal model tuples in workflow `agent()` calls, so the launcher copies `harness.js` into the project and rewrites the two marked BB profile blocks with the selected live values.

```bash
mkdir -p .bb/workflows
cp harness.js /path/to/project/.bb/workflows/harness.js
bb workflows validate --file /path/to/project/.bb/workflows/harness.js
```

Example args after model preflight:

```json
{
  "runtime": "bb",
  "goal": "Migrate every API route to the new Result type",
  "context": "Response contracts must not change.",
  "checks": ["npm run typecheck", "npm test"],
  "tiered": true
}
```

Set `inheritReasoning` or `inheritExecution` to `true` when only that BB tier should inherit the originating thread model. Set `tiered: false` when every role should inherit it.

## Claude Code Dynamic Workflows

Install the same source as a project workflow:

```bash
mkdir -p .claude/workflows
cp harness.js /path/to/project/.claude/workflows/harness.js
```

Use Claude Code's `/model` picker to inspect what the current account/organization actually allows. The launcher asks which available model should handle each tier. Claude stages with no explicit model inherit the session model.

Example args:

```json
{
  "runtime": "claude",
  "goal": "Migrate every API route to the new Result type",
  "context": "Response contracts must not change.",
  "checks": ["npm run typecheck", "npm test"],
  "tiered": true,
  "reasoningModel": "<selected model>",
  "workerModel": "<selected model>"
}
```

After installation, the saved workflow is available as `/harness`. If an edited workflow is not picked up, reload skills/workflows in Claude Code.

## Arguments

| Arg | Default | What it does |
|---|---|---|
| `runtime` | auto-detected | `bb` or `claude`. |
| `goal` | required | What to accomplish. |
| `context` | `""` | Background and constraints shared by roles. |
| `checks` | `[]` | Commands that must pass before Critique. |
| `maxNodes` | 40 | Ceiling on plan size, including sub-nodes. |
| `maxDepth` | 2 | Maximum Worker sub-node nesting depth. |
| `maxReplans` | 2 | Maximum `missing_info` replans. |
| `contextChars` | 6000 | Upstream-result budget per Worker prompt. |
| `tiered` | `false` | Enables per-role model routing after model preflight. |
| `reasoningModel` | inherit | Claude Reasoning-tier model. |
| `workerModel` | inherit | Claude Execution-tier model. |
| `inheritReasoning` | `false` | BB: make only the Reasoning tier inherit the origin thread. |
| `inheritExecution` | `false` | BB: make only the Execution tier inherit the origin thread. |

## Lifecycle

### Explore

The Explorer performs broad repository discovery before planning. It records verified facts, relevant files, constraints, unknowns, and disproved assumptions without implementing the goal. It creates a unique persistent directory under `artifacts/runs/<run-id>/` and writes `exploration.md`.

### Plan

The Planner receives Explorer output and turns it into a DAG. The graph is validated for duplicate ids, unknown dependencies, self references, cycles, and the node ceiling. The accepted plan is written to `plan.md`; bounded replans write `replan-N.md`.

### Work

Runnable nodes execute in parallel. Workers return `done`, `subnodes`, or `missing_info`. Subnodes extend the graph; `missing_info` can trigger a bounded replan.

A result existing does not automatically satisfy a dependency. Failed or blocked nodes never satisfy dependencies, and failure blocks unfinished descendants transitively.

### Check

A dedicated Checker agent runs declared commands without fixing files. A failed check prevents Critique.

### Critique

The Critic verifies the final workspace on disk rather than trusting Worker summaries. It accepts or rejects and writes `critique.md`.

### Promote

After acceptance, the Promoter writes `promotion.md` with a concise handoff, release/PR notes, validation evidence that actually ran, and follow-up work. It does not modify implementation files.

## Persistent artifacts

```text
artifacts/runs/<run-id>/
├── exploration.md
├── plan.md
├── critique.md
└── promotion.md
```

Runtime run directories are gitignored but persist in the workspace. `artifacts/README.md` defines the contract and `AGENTS.md` defines role boundaries and failure semantics.

## Reading the result

`outcome` is `accepted`, `rejected`, or `unverified`. Also inspect `failed`, `blocked`, `degraded`, `stalled`, `checks`, `critic`, `promotion`, and `artifacts`. `unverified` is not success.

## Known limits

- Neither workflow script has direct filesystem/shell access; agents perform filesystem and command work.
- Execution is level-synchronous where this implementation uses `parallel()` as a barrier.
- Model availability is runtime/account-specific, which is why the skill performs model preflight instead of embedding assumptions.
- Persistent run artifacts depend on agents respecting the role contract in `AGENTS.md`.

## Repository

| Path | Purpose |
|---|---|
| `harness.js` | Portable BB / Claude workflow implementation. |
| `AGENTS.md` | Shared role constitution and dependency semantics. |
| `skill/SKILL.md` | Interactive runtime/model launcher contract. |
| `artifacts/README.md` | Persistent run artifact contract. |
| `docs/plugin-design.md` | Earlier native-plugin design. |
| `examples/smoke-test/` | Example utility built by the harness. |

## License

MIT

# agentic-harness

A DAG-driven agentic harness that runs on [BB](https://getbb.app) workflows. One goal in, a plan, parallel execution, and a verified verdict out.

A Planner breaks the goal into a task graph. Workers execute the independent nodes at the same time. Deterministic checks run before an LLM Critic is allowed to spend anything, and the Critic reads the work on disk rather than the workers' summaries.

It is one JavaScript file and one skill. There is no plugin to install, no server, and no database.

## Why

Two articles argue the same thing from different directions:

- [The Harness Is the Thing](https://scott-fryxell.github.io/blog/the-harness-is-the-thing/), Scott Fryxell. Models are commodities. The structure you wrap around them is the leverage. He runs a five-stage arc with role-isolated agents and keeps frontier models off the bulk of the work.
- [Building an Advanced Agentic Harness](https://data4sci.com/blog/building-an-advanced-agentic-harness), Data4Sci. Production agents need composition around the naive loop: a planner that emits a whole dependency graph, parallel execution capped by a semaphore, a two-tier verification gate, and budgets that force a stop.

Both describe systems you would build. This is the observation that most of it already exists: BB workflows already gives durable runs, hidden worker threads, per-agent model selection, structured output, concurrency caps, resume, and an append-only trace. What was actually missing was the planning loop, and that is 40 lines.

## Install

```bash
git clone https://github.com/isacfg/agentic-harness.git
cd agentic-harness

# per project you want to use it in
mkdir -p /path/to/project/.bb/workflows
cp harness.js /path/to/project/.bb/workflows/harness.js

# optional: the skill, so an agent can drive it for you
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

Or, with the skill installed, tell your agent `/harness` and what you want.

### Arguments

| Arg | Default | What it does |
|---|---|---|
| `goal` | required | What to accomplish. The Planner sees only this and `context`. |
| `context` | `""` | Background for every role: where things live, constraints, prior decisions. |
| `checks` | `[]` | Shell commands that must pass. This is the tier 1 gate. |
| `maxNodes` | 40 | Ceiling on plan size, including sub-nodes. |
| `maxDepth` | 2 | How deep a Worker may nest sub-nodes. |
| `maxReplans` | 2 | How many `missing_info` replans are allowed. |
| `contextChars` | 6000 | Budget for upstream results in a Worker prompt. |
| `tiered` | `true` | `false` runs every role on the origin thread's own model. |

Declaring `checks` matters more than it looks. With none, the Critic is the only gate, and it is told so.

## How it works

**Planner** returns a DAG. Its output is validated in plain JavaScript before anything runs: duplicate ids, unknown dependencies, self-references, cycles by Kahn's algorithm, and the node ceiling. An invalid plan gets one corrective pass showing the validation errors, then the run fails. The Planner is a model, so its output is untrusted input.

**Workers** each take one node. Every node whose dependencies are satisfied runs at once. A Worker returns one of three statuses:

- `done` finished, with a summary and the files it touched
- `subnodes` the node contained distinct work that should run separately
- `missing_info` the plan assumed something untrue, and no work on this node fixes it

`subnodes` is the deliberate deviation from both articles. They force a full replan when a plan turns out wrong, throwing away completed work. In coding tasks the Planner cannot know at plan time what node 3 will find. Here the Worker returns children, the parent is rewritten to depend on them, and the parent re-runs afterward so downstream nodes consume its updated result rather than a stale one.

`missing_info` is the expensive path, reserved for a genuine wrong assumption. The replan is shown what was already completed and why the run stalled, so the Planner does not re-emit the same plan.

**Tier 1** runs the declared checks and reports. It fixes nothing. A failure here skips the Critic, because judging code that does not compile is wasted.

**Critic** reads the work on disk and returns accept or reject with specific issues. Taste is explicitly not a blocking issue.

## Reading the result

`outcome` is `accepted`, `rejected`, or `unverified`.

`unverified` means the Critic never ran. That is not the same as passing, and it is the easiest field to misread.

`degraded` lists nodes that wanted to escalate but had exhausted their depth or replan budget and were accepted as-is. Worth a look.

## Model tiering

Tiering is hardcoded in `roleAgent()` near the top of `harness.js`. It has to be: the BB workflow runtime requires literal provider and model strings and rejects values computed from args.

The default puts the Planner and Critic at high reasoning and the Workers at medium. That expresses the articles' economics through reasoning level rather than model choice, which avoids guessing at a strength ordering between sibling models. Edit the tuples to retune.

```bash
bb provider list --environment "$BB_ENVIRONMENT_ID" --json
bb provider models codex --environment "$BB_ENVIRONMENT_ID" --json
```

## Known limits

Stated plainly, because these decide whether it fits your task.

- The workflow script has no shell or filesystem access, so tier 1 checks run through an agent rather than a subprocess.
- No memory between runs. Each run starts cold; pass what matters through `context`.
- Execution is level-synchronous. A node waits for its whole level rather than starting the moment its own dependencies finish. Simpler to read, and it costs wall clock on lopsided levels.
- BB caps a run at 100 agent calls and 8 concurrent agents.
- Nobody reviews the Planner. The Critic checks the work, not the plan. In testing, a Planner read a design document describing a plugin and asserted that the plugin existed on disk. It did not. The wrong belief was harmless that time.

## What is in here

| Path | What |
|---|---|
| `harness.js` | The workflow. This is the whole thing. |
| `skill/SKILL.md` | Claude Code skill so an agent can drive it. |
| `docs/plugin-design.md` | The road not taken: a full design for building this as a native BB plugin instead. |
| `examples/smoke-test/` | The utility the harness built to verify itself, tests included. |

### About `docs/plugin-design.md`

Before writing the script, this was designed as a native BB plugin: SQLite DAG state, a background scheduler, compare-and-swap node claims, crash recovery, a custom graph panel. Six agents designed it in parallel, six adversarial reviewers found 26 blocking problems, and a synthesizer merged the result. The build order came to 18 to 31 days.

Then the obvious question landed: BB workflows already does most of that. The script took one session.

The document is kept because it is a genuinely detailed specification of the problem, and because the reviewers found real things. Four of six independently flagged leaked hidden threads as the most likely defect, which is the kind of finding that justifies the whole review pass.

## License

MIT

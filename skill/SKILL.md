---
name: harness

description: "Run a large task through an agentic harness: a Planner breaks the goal into a DAG, Workers execute independent nodes in parallel (opening sub-nodes or declaring MISSING_INFO when the plan was wrong), deterministic checks gate an LLM Critic. MANDATORY TRIGGERS: 'use the harness', 'run the harness', 'harness this', 'plan and execute this'. STRONG TRIGGERS (use when the task is genuinely large): a migration across many files, an audit or sweep of a whole codebase, a feature that decomposes into several independent pieces, 'break this down and do it', 'do all of this in parallel'. Do NOT trigger on single-file edits, quick fixes, questions, or anything one agent finishes in one pass. Running the harness spawns many agents and costs real tokens, so the user must have asked for it or for multi-agent execution in their own words."

---

# Harness

A DAG-driven agentic harness that runs on BB workflows. One goal in, a plan, parallel execution, and a verified verdict out.

Based on Scott Fryxell's "The Harness Is the Thing" and Data4Sci's "Building an Advanced Agentic Harness". Their shared claim: the model is not the leverage, the structure around it is.

## When to use it

Use it when a task has real internal structure. Several pieces that do not depend on each other, or a chain where each step needs the one before it. The harness pays for itself by running the independent pieces at the same time and by forcing a verification pass you would otherwise skip.

Do not use it for one edit, one question, or anything a single agent finishes in one pass. The planning and verification overhead is real and it will make small work slower and more expensive, not faster.

The Critic is often the actual reason to reach for this. It reads the work on disk rather than the workers' summaries, which is where overstated "done" gets caught.

## Running it

The script lives beside this file at `harness.js`. BB resolves workflows by name from the project's own workspace, so it has to be copied in once per project.

```bash
# from the project root, first time only
mkdir -p .bb/workflows
cp ~/.claude/skills/harness/harness.js .bb/workflows/harness.js
bb workflows validate --name harness
```

Then run it with `bb_workflow_run`, passing `name: "harness"` and an `args` object. Pass `args` as real JSON, never as a stringified blob.

```
name: "harness"
args: {
  "goal": "Migrate every API route from the old error middleware to the new Result type",
  "context": "Routes live in src/api/. The new type is in src/lib/result.ts.",
  "checks": ["npm run typecheck", "npm test"]
}
```

After the call returns, emit its `previewDirective` once on its own line, outside any code fence. That renders live progress in chat.

## Arguments

| Arg | Default | What it does |
|---|---|---|
| `goal` | required | What to accomplish. Be specific; the Planner only sees this and `context`. |
| `context` | `""` | Background handed to every role. Where things live, constraints, prior decisions. |
| `checks` | `[]` | Shell commands that must pass, e.g. `["npm test"]`. This is the tier 1 gate. |
| `maxNodes` | 40 | Ceiling on plan size, including sub-nodes. |
| `maxDepth` | 2 | How deep a Worker may nest sub-nodes. |
| `maxReplans` | 2 | How many MISSING_INFO replans are allowed. |
| `contextChars` | 6000 | Budget for upstream results in a Worker prompt. Overflow is dropped and the Worker is told so. |
| `tiered` | true | `false` runs every role on the origin thread's own model. |

Declaring `checks` matters more than it looks. With no checks the Critic is the only gate, and it is told so.

## The roles

**Planner** turns the goal into a DAG. Its output is validated in plain JavaScript before anything runs: duplicate ids, unknown dependencies, self-references, cycles by Kahn's algorithm, and the node ceiling. An invalid plan gets exactly one corrective pass with the validation errors shown, then the run fails. The Planner is a model and its output is treated as untrusted.

**Workers** each take one node. Every node whose dependencies are satisfied runs at the same time. A Worker reports one of three statuses:

- `done` finished, with a summary and the files it touched
- `subnodes` the node contained distinct pieces of work that should run separately
- `missing_info` the plan assumed something untrue and no work on this node fixes it

`subnodes` is the deviation from both articles. They force a full replan when the plan turns out wrong. In coding work the Planner cannot know at plan time what node 3 will find, and a full replan throws away everything. Instead the Worker adds children, the parent is rewritten to depend on them, and the parent re-runs afterward so downstream nodes consume its result and not a stale one.

`missing_info` is the expensive path and is reserved for a genuine wrong assumption. It triggers a replan that is shown what was already completed and why the run stalled, so the Planner does not re-emit the same plan.

**Tier 1** runs the declared `checks` and reports. It does not fix anything. A failure here skips the Critic, because there is no point paying for judgment on work that does not compile.

**Critic** reads the work on disk and returns accept or reject with specific issues. Taste is explicitly not a blocking issue.

## Reading the result

The run returns `outcome` as `accepted`, `rejected`, or `unverified`, plus the node trace, failures, degraded nodes, check results, and the Critic's issues.

Report these honestly. `unverified` means the Critic never ran, which is not the same as passing. `degraded` nodes are ones that wanted to escalate but had exhausted their depth or replan budget, so they were accepted as-is. Both are easy to gloss over and both matter.

## Tuning the models

Model tiering is hardcoded in `roleAgent()` inside the script. It has to be: the BB workflow runtime requires literal provider and model strings and rejects values computed from args.

The default puts the Planner and Critic at high reasoning and the Workers at medium. That is the articles' economics expressed through reasoning level rather than model choice, which avoids guessing at a strength ordering between sibling models. If you learn a cheaper model is genuinely good enough for execution, put it on the Worker line.

Check what is actually available before editing:

```bash
bb provider list --environment "$BB_ENVIRONMENT_ID" --json
bb provider models codex --environment "$BB_ENVIRONMENT_ID" --json
```

## What it does not do

Worth knowing before you reach for it.

The script has no shell or filesystem access, so tier 1 checks run through an agent rather than a subprocess. It works and it costs one cheap agent call.

There is no memory between runs. Each run starts cold. Pass what matters through `context`.

Execution is level-synchronous. A node waits for its whole level to finish rather than starting the instant its own dependencies are done. Simpler to read, and it costs some wall clock on lopsided levels.

BB caps a run at 100 agent calls and 8 concurrent agents. A very large DAG will hit that.

## Resuming

Runs are durable. After a stop, a crash, or an edit to the script, relaunch with the same source and `resumeRunId`. The longest unchanged prefix of successful agent calls replays from cache and only the first changed call onward runs live. Edits to a Worker prompt invalidate that call and everything after it, so expect a partial replay, not a free one.

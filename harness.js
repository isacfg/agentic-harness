export const meta = {
  name: "harness",
  description:
    "Planner emits a DAG, Workers execute nodes in parallel with sub-nodes and MISSING_INFO replans, deterministic checks gate an LLM Critic",
  phases: [
    { title: "Plan", detail: "Planner emits a validated task DAG" },
    { title: "Work", detail: "Workers execute ready nodes in parallel" },
    { title: "Check", detail: "Tier 1 deterministic checks" },
    { title: "Critique", detail: "Tier 2 Critic, only for check survivors" },
  ],
};

// ---------------------------------------------------------------------------
// Input
//
// args = {
//   goal:        string   (required) what to accomplish
//   context?:    string   background handed to every role
//   checks?:     string[] shell commands that must pass, e.g. ["npm test"]
//   maxNodes?:   number   default 40
//   maxDepth?:   number   default 2   sub-node nesting depth
//   maxReplans?: number   default 2
//   contextChars?: number default 6000  upstream-result budget per worker prompt
//   tiered?:     boolean  default true. false = every role runs on the origin
//                thread's own provider/model/reasoning. Tiering itself is
//                configured in roleAgent() below; the runtime requires literals.
// }
// ---------------------------------------------------------------------------

// Depending on the caller, args can arrive as a real object or as a JSON string.
// Accept both rather than failing on a serialization detail.
let input = args || {};
if (typeof input === "string") {
  try {
    input = JSON.parse(input);
  } catch (error) {
    throw new Error(
      `harness: args arrived as a string that is not valid JSON. Pass args as a JSON object. Parse error: ${error.message}`,
    );
  }
}
if (typeof input !== "object" || Array.isArray(input)) {
  throw new Error("harness: args must be a JSON object, e.g. { \"goal\": \"...\" }");
}

const GOAL = input.goal;
if (!GOAL || typeof GOAL !== "string") {
  throw new Error(
    `harness: args.goal is required and must be a string. Received keys: [${Object.keys(input).join(", ")}]`,
  );
}

const BACKGROUND = input.context || "";
const CHECKS = Array.isArray(input.checks) ? input.checks : [];
const MAX_NODES = input.maxNodes || 40;
const MAX_DEPTH = input.maxDepth === undefined ? 2 : input.maxDepth;
const MAX_REPLANS = input.maxReplans === undefined ? 2 : input.maxReplans;
const CONTEXT_CHARS = input.contextChars || 6000;

const limits = budget();
log(
  `harness: goal set. limits: ${limits.maxAgentCalls} agent calls, ${limits.maxConcurrentAgents} concurrent. maxNodes=${MAX_NODES} maxDepth=${MAX_DEPTH} maxReplans=${MAX_REPLANS}`,
);

// ---------------------------------------------------------------------------
// Role dispatch
//
// Agent options must be plain properties, so the tiered and inherited calls are
// written out separately rather than spread. Omitting the selection fields
// inherits the origin thread's provider, model, and reasoning level; a partial
// override is rejected by the runtime, so a tier must supply all three.
// ---------------------------------------------------------------------------

// EDIT THE TUPLES BELOW TO RETUNE THE HARNESS. The runtime requires literal
// provider/model/reasoning strings, so tiering cannot come from args. Pass
// `tiered: false` to ignore these entirely and run every role on the origin
// thread's own selection.
//
// The economics from the source article: the Planner and Critic think, the
// Workers grind. Reasoning level is the lever here rather than model choice,
// because the same model at a lower level is the cheaper worker without
// guessing at a strength ordering between sibling models. If you learn one of
// the sibling models is genuinely cheaper, put it on the worker line.

const TIERED = input.tiered !== false;

function roleAgent(prompt, label, phaseName, schema, role) {
  if (!TIERED) {
    return agent(prompt, { label: label, phase: phaseName, schema: schema });
  }
  if (role === "planner") {
    return agent(prompt, {
      label: label,
      phase: phaseName,
      schema: schema,
      provider: "codex",
      model: "gpt-5.6-luna",
      reasoningLevel: "high",
    });
  }
  if (role === "critic") {
    return agent(prompt, {
      label: label,
      phase: phaseName,
      schema: schema,
      provider: "codex",
      model: "gpt-5.6-luna",
      reasoningLevel: "high",
    });
  }
  return agent(prompt, {
    label: label,
    phase: phaseName,
    schema: schema,
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "medium",
  });
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DAG_SCHEMA = {
  type: "object",
  required: ["nodes"],
  properties: {
    rationale: { type: "string" },
    nodes: {
      type: "array",
      minItems: 1,
      maxItems: 60,
      items: {
        type: "object",
        required: ["id", "task", "deps"],
        properties: {
          id: { type: "string", maxLength: 60 },
          task: { type: "string" },
          deps: { type: "array", items: { type: "string" } },
          checks: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const WORKER_SCHEMA = {
  type: "object",
  required: ["status", "summary"],
  properties: {
    status: { enum: ["done", "missing_info", "subnodes"] },
    summary: { type: "string" },
    filesTouched: { type: "array", items: { type: "string" } },
    missingInfo: { type: "string" },
    subnodes: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        required: ["id", "task"],
        properties: {
          id: { type: "string", maxLength: 60 },
          task: { type: "string" },
        },
      },
    },
  },
};

const CHECK_SCHEMA = {
  type: "object",
  required: ["passed", "report"],
  properties: {
    passed: { type: "boolean" },
    report: { type: "string" },
    failures: { type: "array", items: { type: "string" } },
  },
};

const CRITIC_SCHEMA = {
  type: "object",
  required: ["verdict", "summary"],
  properties: {
    verdict: { enum: ["accept", "reject"] },
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "detail"],
        properties: {
          severity: { enum: ["blocking", "major", "minor"] },
          detail: { type: "string" },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// DAG validation. The planner is a model; treat its output as untrusted.
// ---------------------------------------------------------------------------

function validateDag(nodes) {
  const problems = [];
  const seen = {};
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (seen[node.id]) problems.push(`duplicate node id "${node.id}"`);
    seen[node.id] = true;
  }
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const deps = node.deps || [];
    for (let j = 0; j < deps.length; j++) {
      if (deps[j] === node.id) problems.push(`node "${node.id}" depends on itself`);
      else if (!seen[deps[j]]) problems.push(`node "${node.id}" depends on unknown node "${deps[j]}"`);
    }
  }
  if (nodes.length > MAX_NODES) {
    problems.push(`plan has ${nodes.length} nodes, over the maxNodes ceiling of ${MAX_NODES}`);
  }
  // Kahn's algorithm: whatever cannot be peeled off is in a cycle.
  const remaining = {};
  for (let i = 0; i < nodes.length; i++) remaining[nodes[i].id] = (nodes[i].deps || []).slice();
  let peeled = true;
  while (peeled) {
    peeled = false;
    const ids = Object.keys(remaining);
    for (let i = 0; i < ids.length; i++) {
      const pending = remaining[ids[i]].filter((dep) => remaining[dep] !== undefined);
      if (pending.length === 0) {
        delete remaining[ids[i]];
        peeled = true;
      }
    }
  }
  const stuck = Object.keys(remaining);
  if (stuck.length) problems.push(`cycle among nodes: ${stuck.join(", ")}`);
  return problems;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const ROLE_PREAMBLE = `You are one role inside an agentic harness. A Planner breaks a
goal into a DAG of tasks, Workers execute one node each in parallel, and a Critic
verifies the finished work. Do the job of your role and nothing else.

GOAL
${GOAL}
${BACKGROUND ? `\nBACKGROUND\n${BACKGROUND}\n` : ""}`;

function plannerPrompt(previousAttempt) {
  return `${ROLE_PREAMBLE}
YOUR ROLE: PLANNER

Break the goal into a DAG of tasks and return it. Each node is one unit of work a
single agent can finish on its own.

Sizing is the thing you most often get wrong. A node that takes one edit is too
small: spawning an agent for it costs more than doing it. A node that touches six
files across three concerns is too large: it cannot be verified and it cannot run
beside anything else. Aim for a node a competent engineer would finish in one
sitting and could describe in one sentence.

Dependencies are what force order. Two nodes with no dependency between them run
at the same time, so declare a dependency only when the second genuinely cannot
start until the first is done. Over-declaring dependencies serializes the run and
wastes most of the benefit of this harness.

For each node give:
  id     short, stable, kebab-case
  task   what to do, concrete enough that a worker needs no clarification
  deps   ids this node truly must wait for, [] when it can start immediately
  checks optional shell commands that would prove this node is done

Ceiling: ${MAX_NODES} nodes. Explore the codebase before planning; do not plan
against assumptions you have not checked.
${
  previousAttempt
    ? `\nTHIS IS A REPLAN. The previous plan stalled. Do not re-emit it.\n\nWhat was already completed and must NOT be redone:\n${previousAttempt.completed}\n\nWhy the run stalled:\n${previousAttempt.reason}\n\nPlan from the current state of the work, not from scratch. Include only what remains.`
    : ""
}`;
}

function workerPrompt(node, upstream, depth) {
  return `${ROLE_PREAMBLE}
YOUR ROLE: WORKER

YOUR NODE: ${node.id}
${node.task}

${upstream}

Do the work. Then report with one of three statuses:

  done         you finished the node. Put what you did in "summary" and list the
               files you touched.

  subnodes     the node turned out to contain distinct pieces of work that should
               run separately. Return them in "subnodes". Use this when you
               genuinely discovered structure, not to avoid doing the work. You
               are at depth ${depth} of a maximum of ${MAX_DEPTH}; at the maximum
               this option is unavailable and you must finish or report
               missing_info.

  missing_info something the plan assumed is not true, and no amount of work on
               this node will fix it. Put the specific fact you needed and could
               not get in "missingInfo". This triggers a replan, which is
               expensive, so do not use it for something you could resolve by
               reading the code.

Report honestly. A node reported "done" that is half-finished corrupts everything
downstream, because later nodes are told it succeeded.`;
}

function buildUpstreamContext(node, results) {
  const deps = node.deps || [];
  if (!deps.length) return "This node has no upstream dependencies.";
  const parts = [];
  let used = 0;
  let dropped = 0;
  for (let i = 0; i < deps.length; i++) {
    const result = results[deps[i]];
    if (!result) continue;
    const block = `--- result of "${deps[i]}" ---\n${result.summary}`;
    if (used + block.length > CONTEXT_CHARS) {
      dropped++;
      continue;
    }
    parts.push(block);
    used += block.length;
  }
  let text = `RESULTS OF THE NODES YOU DEPEND ON:\n\n${parts.join("\n\n")}`;
  if (dropped > 0) {
    // Explicit truncation. The worker is told what it is missing rather than
    // being handed a silently shortened context.
    text += `\n\n[TRUNCATED: ${dropped} upstream result(s) did not fit the ${CONTEXT_CHARS} character budget and were dropped. If you need them, read the work on disk rather than assuming.]`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const results = {};
const nodeDepth = {};
const trace = [];
let nodes = [];
let replans = 0;
let stalled = null;

phase("Plan");

let plan = await roleAgent(plannerPrompt(null), "planner", "Plan", DAG_SCHEMA, "planner");
let problems = validateDag(plan.nodes);
if (problems.length) {
  // One corrective pass. The planner is shown its own invalid graph.
  log(`planner produced an invalid DAG: ${problems.join("; ")}. Asking once for a fix.`);
  plan = await roleAgent(
    `${plannerPrompt(null)}\n\nYour previous plan was REJECTED by graph validation:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nReturn a corrected plan.`,
    "planner:retry",
    "Plan",
    DAG_SCHEMA,
    "planner",
  );
  problems = validateDag(plan.nodes);
  if (problems.length) {
    throw new Error(`harness: planner could not produce a valid DAG: ${problems.join("; ")}`);
  }
}

nodes = plan.nodes;
for (let i = 0; i < nodes.length; i++) nodeDepth[nodes[i].id] = 0;
log(`plan accepted: ${nodes.length} nodes`);

phase("Work");

let working = true;
while (working) {
  working = false;

  // Level-synchronous execution: every node whose dependencies are satisfied
  // runs at once. parallel() is a barrier, so the loop advances one level per
  // pass. The runtime caps actual concurrency at maxConcurrentAgents.
  const ready = nodes.filter((node) => {
    if (results[node.id]) return false;
    const deps = node.deps || [];
    for (let i = 0; i < deps.length; i++) if (!results[deps[i]]) return false;
    return true;
  });

  if (!ready.length) {
    const unfinished = nodes.filter((node) => !results[node.id]);
    if (!unfinished.length) break;
    stalled = {
      reason: `No node is runnable but ${unfinished.length} remain: ${unfinished.map((n) => n.id).join(", ")}. Their dependencies never completed.`,
      completed: Object.keys(results)
        .map((id) => `- ${id}: ${results[id].summary}`)
        .join("\n"),
    };
    break;
  }

  log(`level: running ${ready.length} node(s) in parallel: ${ready.map((n) => n.id).join(", ")}`);

  const batch = await parallel(
    ready.map((node) => () => {
      const depth = nodeDepth[node.id] || 0;
      return roleAgent(
        workerPrompt(node, buildUpstreamContext(node, results), depth),
        `work:${node.id}`,
        "Work",
        WORKER_SCHEMA,
        "worker",
      ).then((result) => ({ node: node, result: result }));
    }),
  );

  let missingInfo = null;

  for (let i = 0; i < batch.length; i++) {
    const entry = batch[i];
    if (!entry) {
      // The agent failed after the runtime exhausted its retries.
      const failedNode = ready[i];
      results[failedNode.id] = {
        summary: `WORKER FAILED: this node's agent errored and produced no result.`,
        failed: true,
      };
      trace.push({ node: failedNode.id, status: "failed" });
      log(`node ${failedNode.id} FAILED (agent error)`);
      continue;
    }

    const node = entry.node;
    const result = entry.result;
    const depth = nodeDepth[node.id] || 0;

    if (result.status === "missing_info" && replans < MAX_REPLANS) {
      missingInfo = missingInfo || { node: node.id, detail: result.missingInfo || result.summary };
      trace.push({ node: node.id, status: "missing_info" });
      continue;
    }

    if (result.status === "subnodes" && depth < MAX_DEPTH) {
      const children = (result.subnodes || []).filter((child) => child && child.id && child.task);
      if (children.length) {
        const known = {};
        for (let k = 0; k < nodes.length; k++) known[nodes[k].id] = true;
        const added = [];
        for (let c = 0; c < children.length; c++) {
          // Namespace the child id so two parents cannot collide, and so a child
          // can never accidentally name an existing node.
          const childId = `${node.id}/${children[c].id}`;
          if (known[childId]) continue;
          if (nodes.length + added.length + 1 > MAX_NODES) {
            log(`maxNodes (${MAX_NODES}) reached: dropping remaining sub-nodes of ${node.id}`);
            break;
          }
          added.push({ id: childId, task: children[c].task, deps: [] });
        }
        if (added.length) {
          for (let a = 0; a < added.length; a++) {
            nodes.push(added[a]);
            nodeDepth[added[a].id] = depth + 1;
          }
          // The parent is rewritten to depend on its children and re-run after
          // them, so its result is the one downstream nodes actually consume.
          node.deps = (node.deps || []).concat(added.map((child) => child.id));
          nodeDepth[node.id] = depth;
          trace.push({ node: node.id, status: "expanded", children: added.length });
          log(`node ${node.id} opened ${added.length} sub-node(s)`);
          working = true;
          continue;
        }
      }
    }

    // done, or a status whose escape hatch is exhausted at this depth
    results[node.id] = {
      summary: result.summary,
      filesTouched: result.filesTouched || [],
      degraded: result.status !== "done",
    };
    trace.push({ node: node.id, status: result.status });
    if (result.status !== "done") {
      log(`node ${node.id} returned "${result.status}" but its escape hatch is exhausted; accepting as-is`);
    }
  }

  if (missingInfo) {
    replans++;
    log(`MISSING_INFO from ${missingInfo.node}. Replan ${replans}/${MAX_REPLANS}.`);
    phase("Plan");
    const completed = Object.keys(results)
      .map((id) => `- ${id}: ${results[id].summary}`)
      .join("\n");
    const replan = await roleAgent(
      plannerPrompt({
        completed: completed || "Nothing completed yet.",
        reason: `Worker on node "${missingInfo.node}" reported MISSING_INFO: ${missingInfo.detail}`,
      }),
      `planner:replan-${replans}`,
      "Plan",
      DAG_SCHEMA,
      "planner",
    );
    const replanProblems = validateDag(replan.nodes);
    if (replanProblems.length) {
      log(`replan ${replans} produced an invalid DAG (${replanProblems.join("; ")}); continuing with the existing plan`);
    } else {
      nodes = replan.nodes.filter((node) => !results[node.id]);
      for (let i = 0; i < nodes.length; i++) {
        if (nodeDepth[nodes[i].id] === undefined) nodeDepth[nodes[i].id] = 0;
      }
      log(`replan accepted: ${nodes.length} remaining node(s)`);
    }
    phase("Work");
    working = true;
    continue;
  }

  const outstanding = nodes.filter((node) => !results[node.id]);
  if (outstanding.length) working = true;
}

const failedNodes = Object.keys(results).filter((id) => results[id].failed);
const degradedNodes = Object.keys(results).filter((id) => results[id].degraded);
const workSummary = Object.keys(results)
  .map((id) => `- ${id}${results[id].failed ? " [FAILED]" : results[id].degraded ? " [DEGRADED]" : ""}: ${results[id].summary}`)
  .join("\n");

// ---------------------------------------------------------------------------
// Tier 1: deterministic checks. Cheap, and it gates the expensive Critic.
// The script has no shell access, so one agent runs the commands and reports.
// ---------------------------------------------------------------------------

const declaredChecks = CHECKS.concat(
  nodes.reduce((all, node) => all.concat(node.checks || []), []),
).filter((check, index, list) => list.indexOf(check) === index);

let checkResult = null;
if (declaredChecks.length) {
  phase("Check");
  checkResult = await agent(
    `${ROLE_PREAMBLE}
YOUR ROLE: TIER 1 CHECKER

Run each of these commands exactly as written, from the workspace root, and report
what happened. Do not fix anything. Do not modify any file. You are a gate, not a
worker.

${declaredChecks.map((check, index) => `${index + 1}. ${check}`).join("\n")}

"passed" is true only if every command exited successfully. For each failure put
the command and the relevant output in "failures". Keep the report short; quote
only the lines that show the failure.`,
    { label: "tier1-checks", phase: "Check", schema: CHECK_SCHEMA },
  );
  log(`tier 1 checks: ${checkResult.passed ? "PASSED" : "FAILED"} (${declaredChecks.length} command(s))`);
} else {
  log("tier 1 skipped: no checks declared. The Critic is the only gate.");
}

// ---------------------------------------------------------------------------
// Tier 2: the Critic, reached only by tier-1 survivors.
// ---------------------------------------------------------------------------

let critique = null;
let criticSkipped = null;

if (checkResult && !checkResult.passed) {
  criticSkipped = "tier 1 checks failed, so the Critic was not run";
  log(`Critic SKIPPED: ${criticSkipped}`);
} else if (failedNodes.length) {
  criticSkipped = `${failedNodes.length} node(s) failed outright, so the Critic was not run`;
  log(`Critic SKIPPED: ${criticSkipped}`);
} else {
  phase("Critique");
  critique = await roleAgent(
    `${ROLE_PREAMBLE}
YOUR ROLE: CRITIC

The work is finished. Decide whether it actually meets the goal.

WHAT THE WORKERS REPORTED
${workSummary}
${checkResult ? `\nTIER 1 CHECKS: passed\n${checkResult.report}` : "\nNo deterministic checks were declared, so you are the only gate. Weigh that."}

Verify against the work on disk, not against the summaries. Workers overstate.
Read what they claim to have written.

Reject when the goal is not met, when a worker claimed something it did not do,
when the pieces do not fit together, or when the work is correct but leaves the
codebase worse. Accept when the goal is met, even if you would have done it
differently. Taste is not a blocking issue.

Be specific. "Could be cleaner" is not a finding. Name the file and what is wrong.`,
    "critic",
    "Critique",
    CRITIC_SCHEMA,
    "critic",
  );
  log(`critic verdict: ${critique.verdict}`);
}

const blocking = critique ? (critique.issues || []).filter((issue) => issue.severity === "blocking") : [];

return {
  goal: GOAL,
  outcome: critique
    ? critique.verdict === "accept"
      ? "accepted"
      : "rejected"
    : "unverified",
  plan: { nodes: nodes.length, replans: replans, rationale: plan.rationale || null },
  nodes: trace,
  failed: failedNodes,
  degraded: degradedNodes,
  stalled: stalled ? stalled.reason : null,
  checks: checkResult
    ? { ran: declaredChecks, passed: checkResult.passed, failures: checkResult.failures || [] }
    : { ran: [], passed: null, failures: [] },
  critic: critique
    ? { verdict: critique.verdict, summary: critique.summary, blocking: blocking.length, issues: critique.issues || [] }
    : null,
  criticSkipped: criticSkipped,
  work: workSummary,
};

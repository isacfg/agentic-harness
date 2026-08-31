export const meta = {
  name: "harness",
  description:
    "Explorer establishes facts, Planner emits a DAG, Workers execute ready nodes, checks gate a Critic, and an accepted run is packaged by a Promoter",
  phases: [
    { title: "Explore", detail: "Explorer establishes repository facts and a persistent run artifact directory" },
    { title: "Plan", detail: "Planner emits a validated task DAG from exploration facts" },
    { title: "Work", detail: "Workers execute ready nodes in parallel; failed dependencies block descendants" },
    { title: "Check", detail: "Tier 1 declared checks" },
    { title: "Critique", detail: "Tier 2 Critic, only for check survivors" },
    { title: "Promote", detail: "Accepted work is packaged into a durable handoff artifact" },
  ],
};

let input = args || {};
if (typeof input === "string") {
  try {
    input = JSON.parse(input);
  } catch (error) {
    throw new Error(`harness: args must be valid JSON: ${error.message}`);
  }
}
if (typeof input !== "object" || Array.isArray(input)) {
  throw new Error("harness: args must be a JSON object");
}

const GOAL = input.goal;
if (!GOAL || typeof GOAL !== "string") throw new Error("harness: args.goal is required and must be a string");

const BACKGROUND = input.context || "";
const CHECKS = Array.isArray(input.checks) ? input.checks : [];
const MAX_NODES = input.maxNodes || 40;
const MAX_DEPTH = input.maxDepth === undefined ? 2 : input.maxDepth;
const MAX_REPLANS = input.maxReplans === undefined ? 2 : input.maxReplans;
const CONTEXT_CHARS = input.contextChars || 6000;
const TIERED = input.tiered !== false;

const limits = budget();
log(`harness: limits ${limits.maxAgentCalls} calls / ${limits.maxConcurrentAgents} concurrent; maxNodes=${MAX_NODES} maxDepth=${MAX_DEPTH} maxReplans=${MAX_REPLANS}`);

function roleAgent(prompt, label, phaseName, schema, role) {
  if (!TIERED) return agent(prompt, { label, phase: phaseName, schema });
  const high = role === "planner" || role === "critic";
  return agent(prompt, {
    label,
    phase: phaseName,
    schema,
    provider: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: high ? "high" : "medium",
  });
}

const EXPLORER_SCHEMA = {
  type: "object",
  required: ["artifactDir", "summary", "facts", "relevantFiles", "constraints", "unknowns"],
  properties: {
    artifactDir: { type: "string" },
    summary: { type: "string" },
    facts: { type: "array", items: { type: "string" } },
    relevantFiles: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    unknowns: { type: "array", items: { type: "string" } },
  },
};

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

const PROMOTER_SCHEMA = {
  type: "object",
  required: ["summary", "releaseNotes", "followUps", "artifact"],
  properties: {
    summary: { type: "string" },
    releaseNotes: { type: "array", items: { type: "string" } },
    followUps: { type: "array", items: { type: "string" } },
    artifact: { type: "string" },
  },
};

function validateDag(nodes) {
  const problems = [];
  const seen = {};
  for (const node of nodes) {
    if (seen[node.id]) problems.push(`duplicate node id "${node.id}"`);
    seen[node.id] = true;
  }
  for (const node of nodes) {
    for (const dep of node.deps || []) {
      if (dep === node.id) problems.push(`node "${node.id}" depends on itself`);
      else if (!seen[dep]) problems.push(`node "${node.id}" depends on unknown node "${dep}"`);
    }
  }
  if (nodes.length > MAX_NODES) problems.push(`plan has ${nodes.length} nodes, over maxNodes=${MAX_NODES}`);
  const remaining = {};
  for (const node of nodes) remaining[node.id] = (node.deps || []).slice();
  let peeled = true;
  while (peeled) {
    peeled = false;
    for (const id of Object.keys(remaining)) {
      const pending = remaining[id].filter((dep) => remaining[dep] !== undefined);
      if (!pending.length) {
        delete remaining[id];
        peeled = true;
      }
    }
  }
  const stuck = Object.keys(remaining);
  if (stuck.length) problems.push(`cycle among nodes: ${stuck.join(", ")}`);
  return problems;
}

const BASE_PREAMBLE = `You are one role inside an agentic harness. Keep your role isolated.\n\nGOAL\n${GOAL}${BACKGROUND ? `\n\nBACKGROUND\n${BACKGROUND}` : ""}`;

function rolePreamble(artifactDir) {
  return `${BASE_PREAMBLE}${artifactDir ? `\n\nRUN ARTIFACT DIRECTORY\n${artifactDir}\nKeep role audit artifacts inside this directory.` : ""}`;
}

function explorerPrompt() {
  return `${BASE_PREAMBLE}\n\nYOUR ROLE: EXPLORER\n\nEstablish facts before anyone plans or implements. Read the repository, relevant docs, tests, configuration, and existing patterns. Do not implement the goal and do not modify source, tests, configuration, or product documentation.\n\nCreate one unique directory under artifacts/runs/ for this execution. Use a readable unique id such as UTC timestamp + short goal slug; if that exact path exists, add a short suffix instead of overwriting another run. The only files you may write are inside that run directory. Write exploration.md there with verified facts, relevant files, constraints, unknowns, and important disproved assumptions.\n\nReturn artifactDir as the exact relative directory you created. Keep facts concrete. A design document describing something is not proof that implementation exists.`;
}

function plannerPrompt(previousAttempt, exploration, artifactDir, replanNumber) {
  return `${rolePreamble(artifactDir)}\n\nYOUR ROLE: PLANNER\n\nThe Explorer already performed broad discovery. Use this as your primary factual input; do not repeat broad repository exploration. You may inspect a specific file only to resolve a narrow ambiguity.\n\nEXPLORATION\n${JSON.stringify(exploration, null, 2)}\n\nBreak the remaining goal into a DAG. Each node should be one coherent unit a competent engineer can finish in one sitting. Dependencies are only for genuine execution order. For each node return id, task, deps, and optional checks. Ceiling: ${MAX_NODES} nodes.\n${previousAttempt ? `\nTHIS IS A REPLAN. Do not redo completed work.\nCompleted:\n${previousAttempt.completed}\n\nWhy the run stalled:\n${previousAttempt.reason}\nPlan from the current workspace state.` : ""}\n\nWrite the accepted proposal to ${artifactDir}/${replanNumber ? `replan-${replanNumber}.md` : "plan.md"}.`;
}

function workerPrompt(node, upstream, depth, artifactDir) {
  return `${rolePreamble(artifactDir)}\n\nYOUR ROLE: WORKER\n\nYOUR NODE: ${node.id}\n${node.task}\n\n${upstream}\n\nDo only this node. Return status done when finished; subnodes only when genuinely distinct discovered work should run separately; missing_info only when a plan assumption is false and cannot be resolved by reading the workspace. You are at depth ${depth}/${MAX_DEPTH}. Report files touched honestly.`;
}

function buildUpstreamContext(node, results) {
  const deps = node.deps || [];
  if (!deps.length) return "This node has no upstream dependencies.";
  const parts = [];
  let used = 0;
  let dropped = 0;
  for (const dep of deps) {
    const result = results[dep];
    if (!result) continue;
    const block = `--- usable result of "${dep}" ---\n${result.summary}`;
    if (used + block.length > CONTEXT_CHARS) {
      dropped++;
      continue;
    }
    parts.push(block);
    used += block.length;
  }
  let text = `RESULTS OF USABLE UPSTREAM NODES:\n\n${parts.join("\n\n")}`;
  if (dropped) text += `\n\n[TRUNCATED: ${dropped} upstream result(s) did not fit the ${CONTEXT_CHARS} character budget. Read the workspace if needed.]`;
  return text;
}

function blockFailedDescendants(nodes, results, trace) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (results[node.id]) continue;
      const blockedBy = (node.deps || []).filter((dep) => {
        const result = results[dep];
        return result && (result.failed || result.blocked);
      });
      if (!blockedBy.length) continue;
      results[node.id] = {
        summary: `BLOCKED: dependency failure prevents execution (${blockedBy.join(", ")})`,
        blocked: true,
        blockedBy,
      };
      trace.push({ node: node.id, status: "blocked", blockedBy });
      log(`node ${node.id} BLOCKED by ${blockedBy.join(", ")}`);
      changed = true;
    }
  }
}

const results = {};
const nodeDepth = {};
const trace = [];
let nodes = [];
let replans = 0;
let stalled = null;

phase("Explore");
const exploration = await roleAgent(explorerPrompt(), "explorer", "Explore", EXPLORER_SCHEMA, "explorer");
const ARTIFACT_DIR = exploration.artifactDir;
log(`exploration complete; artifacts: ${ARTIFACT_DIR}`);

phase("Plan");
let plan = await roleAgent(plannerPrompt(null, exploration, ARTIFACT_DIR, 0), "planner", "Plan", DAG_SCHEMA, "planner");
let problems = validateDag(plan.nodes);
if (problems.length) {
  log(`planner produced invalid DAG: ${problems.join("; ")}; asking once for correction`);
  plan = await roleAgent(`${plannerPrompt(null, exploration, ARTIFACT_DIR, 0)}\n\nGRAPH VALIDATION REJECTED THE PREVIOUS PLAN:\n${problems.map((p) => `- ${p}`).join("\n")}\nReturn a corrected plan and replace plan.md.`, "planner:retry", "Plan", DAG_SCHEMA, "planner");
  problems = validateDag(plan.nodes);
  if (problems.length) throw new Error(`harness: planner could not produce a valid DAG: ${problems.join("; ")}`);
}

nodes = plan.nodes;
for (const node of nodes) nodeDepth[node.id] = 0;
log(`plan accepted: ${nodes.length} nodes`);

phase("Work");
let working = true;
while (working) {
  working = false;
  blockFailedDescendants(nodes, results, trace);

  const ready = nodes.filter((node) => {
    if (results[node.id]) return false;
    for (const dep of node.deps || []) {
      const result = results[dep];
      if (!result || result.failed || result.blocked) return false;
    }
    return true;
  });

  if (!ready.length) {
    const unfinished = nodes.filter((node) => !results[node.id]);
    if (!unfinished.length) break;
    stalled = {
      reason: `No node is runnable but ${unfinished.length} remain: ${unfinished.map((n) => n.id).join(", ")}`,
      completed: Object.keys(results).map((id) => `- ${id}: ${results[id].summary}`).join("\n"),
    };
    break;
  }

  log(`running ${ready.length} node(s): ${ready.map((n) => n.id).join(", ")}`);
  const batch = await parallel(ready.map((node) => () => {
    const depth = nodeDepth[node.id] || 0;
    return roleAgent(workerPrompt(node, buildUpstreamContext(node, results), depth, ARTIFACT_DIR), `work:${node.id}`, "Work", WORKER_SCHEMA, "worker").then((result) => ({ node, result }));
  }));

  let missingInfo = null;
  for (let i = 0; i < batch.length; i++) {
    const entry = batch[i];
    if (!entry) {
      const failedNode = ready[i];
      results[failedNode.id] = { summary: "WORKER FAILED: agent errored and produced no result.", failed: true };
      trace.push({ node: failedNode.id, status: "failed" });
      log(`node ${failedNode.id} FAILED`);
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
        for (const existing of nodes) known[existing.id] = true;
        const added = [];
        for (const child of children) {
          const childId = `${node.id}/${child.id}`;
          if (known[childId]) continue;
          if (nodes.length + added.length + 1 > MAX_NODES) break;
          added.push({ id: childId, task: child.task, deps: [] });
        }
        if (added.length) {
          for (const child of added) {
            nodes.push(child);
            nodeDepth[child.id] = depth + 1;
          }
          node.deps = (node.deps || []).concat(added.map((child) => child.id));
          trace.push({ node: node.id, status: "expanded", children: added.length });
          log(`node ${node.id} opened ${added.length} sub-node(s)`);
          working = true;
          continue;
        }
      }
    }

    results[node.id] = {
      summary: result.summary,
      filesTouched: result.filesTouched || [],
      degraded: result.status !== "done",
    };
    trace.push({ node: node.id, status: result.status });
  }

  blockFailedDescendants(nodes, results, trace);

  if (missingInfo) {
    replans++;
    phase("Plan");
    const completed = Object.keys(results).filter((id) => !results[id].failed && !results[id].blocked).map((id) => `- ${id}: ${results[id].summary}`).join("\n");
    const replan = await roleAgent(plannerPrompt({ completed: completed || "Nothing completed yet.", reason: `Worker "${missingInfo.node}" reported MISSING_INFO: ${missingInfo.detail}` }, exploration, ARTIFACT_DIR, replans), `planner:replan-${replans}`, "Plan", DAG_SCHEMA, "planner");
    const replanProblems = validateDag(replan.nodes);
    if (replanProblems.length) {
      log(`replan ${replans} invalid (${replanProblems.join("; ")}); keeping existing plan`);
    } else {
      nodes = replan.nodes.filter((node) => !results[node.id]);
      for (const node of nodes) if (nodeDepth[node.id] === undefined) nodeDepth[node.id] = 0;
      log(`replan accepted: ${nodes.length} remaining node(s)`);
    }
    phase("Work");
    working = true;
    continue;
  }

  if (nodes.some((node) => !results[node.id])) working = true;
}

const failedNodes = Object.keys(results).filter((id) => results[id].failed);
const blockedNodes = Object.keys(results).filter((id) => results[id].blocked);
const degradedNodes = Object.keys(results).filter((id) => results[id].degraded);
const workSummary = Object.keys(results).map((id) => {
  const label = results[id].failed ? " [FAILED]" : results[id].blocked ? " [BLOCKED]" : results[id].degraded ? " [DEGRADED]" : "";
  return `- ${id}${label}: ${results[id].summary}`;
}).join("\n");

const declaredChecks = CHECKS.concat(nodes.reduce((all, node) => all.concat(node.checks || []), [])).filter((check, index, list) => list.indexOf(check) === index);
let checkResult = null;
if (declaredChecks.length && !failedNodes.length && !blockedNodes.length) {
  phase("Check");
  checkResult = await agent(`${rolePreamble(ARTIFACT_DIR)}\n\nYOUR ROLE: TIER 1 CHECKER\n\nRun each command exactly as written from the workspace root. Do not fix or modify anything. passed=true only if every command exits successfully.\n\n${declaredChecks.map((check, index) => `${index + 1}. ${check}`).join("\n")}`, { label: "tier1-checks", phase: "Check", schema: CHECK_SCHEMA });
  log(`tier 1 checks: ${checkResult.passed ? "PASSED" : "FAILED"}`);
} else if (failedNodes.length || blockedNodes.length) {
  log("tier 1 skipped because execution contains failed or blocked nodes");
} else {
  log("tier 1 skipped: no checks declared");
}

let critique = null;
let criticSkipped = null;
if (checkResult && !checkResult.passed) {
  criticSkipped = "tier 1 checks failed";
} else if (failedNodes.length || blockedNodes.length) {
  criticSkipped = `${failedNodes.length} failed node(s), ${blockedNodes.length} blocked node(s)`;
} else {
  phase("Critique");
  critique = await roleAgent(`${rolePreamble(ARTIFACT_DIR)}\n\nYOUR ROLE: CRITIC\n\nDecide whether the final workspace actually meets the goal. Verify on disk, not from worker summaries. Use Explorer constraints as factual context. Reject false claims, missing work, pieces that do not fit, or material regressions. Taste is not blocking.\n\nEXPLORATION\n${JSON.stringify(exploration, null, 2)}\n\nWORKERS\n${workSummary}\n${checkResult ? `\nCHECKS PASSED\n${checkResult.report}` : "\nNo declared checks ran; you are the only final gate."}\n\nWrite critique.md into ${ARTIFACT_DIR} with verdict and concrete issues.`, "critic", "Critique", CRITIC_SCHEMA, "critic");
  log(`critic verdict: ${critique.verdict}`);
}

let promotion = null;
if (critique && critique.verdict === "accept") {
  phase("Promote");
  promotion = await roleAgent(`${rolePreamble(ARTIFACT_DIR)}\n\nYOUR ROLE: PROMOTER\n\nThe Critic accepted the implementation. Do not modify implementation files. Package the accepted run for handoff: concise summary, concrete release/PR notes, validation evidence that actually ran, and follow-up work. Do not invent checks. Write the durable handoff to ${ARTIFACT_DIR}/promotion.md and return that exact path in artifact.\n\nWORK\n${workSummary}\n\nCHECKS\n${checkResult ? checkResult.report : "No declared checks ran."}\n\nCRITIC\n${critique.summary}`, "promoter", "Promote", PROMOTER_SCHEMA, "promoter");
  log("promotion artifact written");
}

const blocking = critique ? (critique.issues || []).filter((issue) => issue.severity === "blocking") : [];

return {
  goal: GOAL,
  outcome: critique ? (critique.verdict === "accept" ? "accepted" : "rejected") : "unverified",
  artifacts: { dir: ARTIFACT_DIR, exploration: `${ARTIFACT_DIR}/exploration.md`, plan: `${ARTIFACT_DIR}/plan.md`, critique: critique ? `${ARTIFACT_DIR}/critique.md` : null, promotion: promotion ? promotion.artifact : null },
  exploration,
  plan: { nodes: nodes.length, replans, rationale: plan.rationale || null },
  nodes: trace,
  failed: failedNodes,
  blocked: blockedNodes,
  degraded: degradedNodes,
  stalled: stalled ? stalled.reason : null,
  checks: checkResult ? { ran: declaredChecks, passed: checkResult.passed, failures: checkResult.failures || [] } : { ran: [], passed: null, failures: [] },
  critic: critique ? { verdict: critique.verdict, summary: critique.summary, blocking: blocking.length, issues: critique.issues || [] } : null,
  criticSkipped,
  promotion,
  work: workSummary,
};

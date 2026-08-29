## What this is and what problem it solves

`bb-plugin-harness` is a bounded orchestration plugin for BB. It turns one goal into a validated dependency DAG, runs eligible Worker nodes in hidden BB threads, lets a Worker open a bounded child node when execution reveals separable work, and sends the completed evidence through a Critic.

The articles' central point is that model choice is not the durable advantage. The integration layer that plans, schedules, verifies, records, and recovers work is. BB adds the missing runtime primitives: durable plugin SQLite, hidden attributed threads, lifecycle events, typed agent tools, host-routed file access, background services, RPC, and a frontend panel.

## Scope

V1 builds:

- Three extensible roles: `planner`, `worker`, and `critic`.
- One initial Planner DAG per run, plus informed replans only after an explicit Worker `MISSING_INFO` result.
- Parallel Worker scheduling with a durable concurrency reservation.
- Worker-created sub-nodes with parent ownership, an execution dependency barrier, and a required result-delivery continuation.
- Deterministic Tier 1 checks followed by a Critic Tier 2 gate.
- Durable run, plan-revision, node, thread-launch, check, verification, event, and episodic-memory state.
- Crash recovery, cancellation, timeout cleanup, explicit hard-limit failures, and terminal-run archival.
- A CLI, four Worker/status agent tools, typed RPC, realtime invalidation, and a layered DAG panel.

V1 deliberately does not build:

- Explorer or Promoter roles. The role column, prompts, lifecycle records, and cleanup paths are extensible for them later.
- Automatic Critic-to-Planner replanning. A Critic rejection fails the run; only Worker-declared `MISSING_INFO` starts a replan.
- Manual DAG editing, drag-and-drop graph layout, polling in the frontend, custom chat composition, cross-run analytics, or unauthenticated HTTP routes.
- Silent truncation, sampling, skipped checks, skipped Critic review, or coverage reduction when a limit trips.

## Architecture overview

```text
CLI / frontend / Worker tools
          │
          ▼
   RPC and command handlers
          │
          ▼
  Orchestration repository
  SQLite: runs, revisions, nodes,
  launches, checks, events, episodes
          │
          ▼
   Background scheduler service
      │             │
      │             ├── deterministic host checks through bb.hosts
      │             │
      ├── Planner ──┴── hidden BB thread
      ├── Worker ────── hidden BB threads, max concurrent reservations
      └── Critic ────── hidden BB thread after Tier 1 passes
             │
             ▼
     thread.* lifecycle hints
             │
             ▼
    durable CAS harvest/recovery
             │
             ├── bb.realtime.publish invalidation
             └── frontend RPC refetch
```

The plugin factory only registers storage, RPC, CLI, tools, agent configuration, lifecycle listeners, realtime, host client, and one background service. The service is authoritative. `thread.idle`, `thread.failed`, `thread.archived`, and `thread.deleted` are low-latency hints and reconciliation triggers, not a durable queue.

## Data model

### Naming and invariants

The canonical names are `runs`, `plan_versions`, `nodes`, `node_dependencies`, `subnode_links`, `thread_assignments`, `worker_leases`, `role_calls`, `missing_info`, `checks`, `run_checks`, `check_results`, `verifications`, `reports`, `events`, `episodes`, and `run_archives`.

Roles are the lower-case strings `planner`, `worker`, and `critic`. Roles are application-validated, not constrained to this three-item set in SQLite, so Explorer and Promoter do not require a destructive migration.

Node IDs are server-generated UUIDs and are globally unique. Planner-local IDs are stored separately in `planner_id`. A node belongs to exactly one `plan_revision`. A revision's nodes and edges are immutable after insertion. Replanning creates a new revision and never changes an old revision's edges.

All JSON and text limits below are enforced in repository code by UTF-8 byte count before SQL execution. The SQL `length` checks are a second guard, not the only guard.

```ts
export const STORAGE_LIMITS = {
  goalBytes: 64 * 1024,
  promptBytes: 96 * 1024,
  nodeInstructionBytes: 24 * 1024,
  resultBytes: 64 * 1024,
  reportBytes: 256 * 1024,
  errorBytes: 16 * 1024,
  eventPayloadBytes: 32 * 1024,
  episodeFieldBytes: 16 * 1024,
  maxEventsPerRun: 20_000,
} as const;

export type RunStatus =
  | "planning"
  | "executing"
  | "verifying"
  | "stopping"
  | "done"
  | "failed"
  | "cancelled";

export type NodeStatus =
  | "pending"
  | "ready"
  | "launching"
  | "running"
  | "waiting"
  | "missing_info"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";
```

### Migration array

`bb.storage.migrate` identifies migrations by array index. The following statements are the initial release and must never be reordered or edited after shipping. Future changes append statements only.

```ts
export const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    goal TEXT NOT NULL CHECK (length(goal) <= 65536),
    project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    environment_json TEXT NOT NULL CHECK (json_valid(environment_json)),
    config_json TEXT NOT NULL CHECK (json_valid(config_json)),
    limits_json TEXT NOT NULL CHECK (json_valid(limits_json)),
    status TEXT NOT NULL CHECK (status IN (
      'planning', 'executing', 'verifying', 'stopping',
      'done', 'failed', 'cancelled'
    )),
    active_revision INTEGER,
    node_count INTEGER NOT NULL DEFAULT 0 CHECK (node_count >= 0),
    replan_count INTEGER NOT NULL DEFAULT 0 CHECK (replan_count >= 0),
    generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
    created_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    deadline_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER,
    stop_reason_json TEXT CHECK (
      stop_reason_json IS NULL OR
      (json_valid(stop_reason_json) AND length(stop_reason_json) <= 16384)
    ),
    final_report_json TEXT CHECK (
      final_report_json IS NULL OR
      (json_valid(final_report_json) AND length(final_report_json) <= 262144)
    ),
    CHECK ((status = 'planning' AND active_revision IS NULL) OR status <> 'planning')
  );

  CREATE TABLE IF NOT EXISTS plan_versions (
    run_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    summary TEXT NOT NULL CHECK (length(summary) <= 20000),
    report_node_id TEXT NOT NULL,
    planner_call_id TEXT NOT NULL,
    plan_json TEXT NOT NULL CHECK (
      json_valid(plan_json) AND length(plan_json) <= 262144
    ),
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (run_id, revision),
    FOREIGN KEY (run_id) REFERENCES runs(id)
  );

  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    plan_revision INTEGER NOT NULL CHECK (plan_revision >= 0),
    planner_id TEXT NOT NULL,
    order_index INTEGER NOT NULL CHECK (order_index >= 0),
    parent_node_id TEXT,
    supersedes_node_id TEXT,
    reuse_of_node_id TEXT,
    depth INTEGER NOT NULL CHECK (depth >= 0),
    title TEXT NOT NULL CHECK (length(title) <= 400),
    instructions TEXT NOT NULL CHECK (length(instructions) <= 24576),
    input_json TEXT NOT NULL CHECK (json_valid(input_json)),
    role TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 64),
    created_by_role TEXT NOT NULL CHECK (length(created_by_role) BETWEEN 1 AND 64),
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    reasoning_level TEXT NOT NULL,
    service_tier TEXT,
    status TEXT NOT NULL CHECK (status IN (
      'pending', 'ready', 'launching', 'running', 'waiting',
      'missing_info', 'succeeded', 'failed', 'blocked', 'cancelled'
    )),
    declared_checks_json TEXT NOT NULL CHECK (json_valid(declared_checks_json)),
    result_json TEXT CHECK (
      result_json IS NULL OR
      (json_valid(result_json) AND length(result_json) <= 65536)
    ),
    failure_json TEXT CHECK (
      failure_json IS NULL OR
      (json_valid(failure_json) AND length(failure_json) <= 16384)
    ),
    blocked_reason TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    first_started_at_ms INTEGER,
    deadline_at_ms INTEGER,
    finished_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    UNIQUE (run_id, plan_revision, planner_id),
    UNIQUE (run_id, plan_revision, order_index),
    FOREIGN KEY (run_id) REFERENCES runs(id),
    FOREIGN KEY (parent_node_id) REFERENCES nodes(id),
    FOREIGN KEY (supersedes_node_id) REFERENCES nodes(id),
    FOREIGN KEY (reuse_of_node_id) REFERENCES nodes(id)
  );

  CREATE TABLE IF NOT EXISTS node_dependencies (
    run_id TEXT NOT NULL,
    plan_revision INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    depends_on_node_id TEXT NOT NULL,
    PRIMARY KEY (run_id, plan_revision, node_id, depends_on_node_id),
    CHECK (node_id <> depends_on_node_id),
    FOREIGN KEY (node_id) REFERENCES nodes(id),
    FOREIGN KEY (depends_on_node_id) REFERENCES nodes(id)
  );

  CREATE TABLE IF NOT EXISTS role_calls (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    operation_key TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,
    phase TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    status TEXT NOT NULL CHECK (status IN (
      'reserved', 'launching', 'running', 'succeeded', 'failed',
      'cancelled', 'orphaned'
    )),
    input_json TEXT NOT NULL CHECK (json_valid(input_json)),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
    deadline_at_ms INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    started_at_ms INTEGER,
    finished_at_ms INTEGER,
    UNIQUE (run_id, role, phase, attempt),
    FOREIGN KEY (run_id) REFERENCES runs(id)
  );

  CREATE TABLE IF NOT EXISTS thread_assignments (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    node_id TEXT,
    role_call_id TEXT,
    role TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    launch_key TEXT NOT NULL UNIQUE,
    thread_id TEXT UNIQUE,
    state TEXT NOT NULL CHECK (state IN (
      'reserved', 'spawned', 'active', 'idle', 'failed',
      'cancel_requested', 'cleaned', 'orphaned'
    )),
    generation INTEGER NOT NULL,
    deadline_at_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    cleaned_at_ms INTEGER,
    CHECK ((node_id IS NULL) <> (role_call_id IS NULL)),
    FOREIGN KEY (run_id) REFERENCES runs(id),
    FOREIGN KEY (node_id) REFERENCES nodes(id),
    FOREIGN KEY (role_call_id) REFERENCES role_calls(id)
  );

  CREATE TABLE IF NOT EXISTS worker_leases (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    lease_id TEXT NOT NULL UNIQUE,
    released_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (run_id, node_id, attempt),
    FOREIGN KEY (run_id) REFERENCES runs(id),
    FOREIGN KEY (node_id) REFERENCES nodes(id)
  );

  CREATE TABLE IF NOT EXISTS subnode_links (
    parent_node_id TEXT NOT NULL,
    child_node_id TEXT NOT NULL,
    parent_attempt INTEGER NOT NULL CHECK (parent_attempt > 0),
    state TEXT NOT NULL CHECK (state IN (
      'queued', 'running', 'succeeded', 'failed', 'missing_info', 'cancelled'
    )),
    child_result_json TEXT CHECK (
      child_result_json IS NULL OR
      (json_valid(child_result_json) AND length(child_result_json) <= 65536)
    ),
    acknowledged_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (parent_node_id, child_node_id, parent_attempt),
    FOREIGN KEY (parent_node_id) REFERENCES nodes(id),
    FOREIGN KEY (child_node_id) REFERENCES nodes(id)
  );

  CREATE TABLE IF NOT EXISTS missing_info (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK (length(reason) <= 4096),
    needed TEXT NOT NULL CHECK (length(needed) <= 4096),
    checked_json TEXT NOT NULL CHECK (json_valid(checked_json)),
    unblock_request TEXT NOT NULL CHECK (length(unblock_request) <= 4096),
    created_at_ms INTEGER NOT NULL,
    UNIQUE (run_id, node_id, attempt),
    FOREIGN KEY (run_id) REFERENCES runs(id),
    FOREIGN KEY (node_id) REFERENCES nodes(id)
  );

  CREATE TABLE IF NOT EXISTS checks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    plan_revision INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    declaration_json TEXT NOT NULL CHECK (
      json_valid(declaration_json) AND length(declaration_json) <= 16384
    ),
    UNIQUE (run_id, plan_revision, node_id, ordinal),
    FOREIGN KEY (run_id) REFERENCES runs(id),
    FOREIGN KEY (node_id) REFERENCES nodes(id)
  );

  CREATE TABLE IF NOT EXISTS run_checks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    plan_revision INTEGER NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    declaration_json TEXT NOT NULL CHECK (
      json_valid(declaration_json) AND length(declaration_json) <= 16384
    ),
    UNIQUE (run_id, plan_revision, ordinal),
    FOREIGN KEY (run_id) REFERENCES runs(id)
  );

  CREATE TABLE IF NOT EXISTS check_results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    check_id TEXT,
    run_check_id TEXT,
    node_id TEXT,
    plan_revision INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'passed', 'failed', 'error', 'timed_out', 'truncated'
    )),
    observed_json TEXT NOT NULL CHECK (
      json_valid(observed_json) AND length(observed_json) <= 32768
    ),
    created_at_ms INTEGER NOT NULL,
    CHECK ((check_id IS NULL) <> (run_check_id IS NULL)),
    UNIQUE (check_id, attempt),
    UNIQUE (run_check_id, attempt),
    FOREIGN KEY (run_id) REFERENCES runs(id),
    FOREIGN KEY (check_id) REFERENCES checks(id),
    FOREIGN KEY (run_check_id) REFERENCES run_checks(id)
  );

  CREATE TABLE IF NOT EXISTS verifications (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    plan_revision INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    tier1_status TEXT NOT NULL CHECK (tier1_status IN (
      'not_run', 'running', 'passed', 'failed'
    )),
    tier2_status TEXT NOT NULL CHECK (tier2_status IN (
      'not_run', 'running', 'passed', 'failed', 'invalid'
    )),
    verdict_json TEXT CHECK (
      verdict_json IS NULL OR
      (json_valid(verdict_json) AND length(verdict_json) <= 65536)
    ),
    created_at_ms INTEGER NOT NULL,
    UNIQUE (run_id, plan_revision, generation),
    FOREIGN KEY (run_id) REFERENCES runs(id)
  );

  CREATE TABLE IF NOT EXISTS reports (
    run_id TEXT NOT NULL,
    plan_revision INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    report_json TEXT NOT NULL CHECK (
      json_valid(report_json) AND length(report_json) <= 262144
    ),
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (run_id, plan_revision, generation),
    FOREIGN KEY (run_id) REFERENCES runs(id)
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    node_id TEXT,
    thread_id TEXT,
    step_id TEXT NOT NULL,
    event_key TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,
    action TEXT NOT NULL,
    occurred_at_ms INTEGER NOT NULL,
    latency_ms INTEGER,
    verdict_json TEXT CHECK (
      verdict_json IS NULL OR
      (json_valid(verdict_json) AND length(verdict_json) <= 32768)
    ),
    payload_json TEXT NOT NULL CHECK (
      json_valid(payload_json) AND length(payload_json) <= 32768
    ),
    FOREIGN KEY (run_id) REFERENCES runs(id),
    FOREIGN KEY (node_id) REFERENCES nodes(id)
  );

  CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE,
    goal_fingerprint TEXT NOT NULL,
    goal_summary TEXT NOT NULL CHECK (length(goal_summary) <= 16384),
    plan_summary TEXT NOT NULL CHECK (length(plan_summary) <= 20000),
    outcome TEXT NOT NULL CHECK (length(outcome) <= 4096),
    mistakes TEXT NOT NULL CHECK (length(mistakes) <= 16384),
    useful_patterns TEXT NOT NULL CHECK (length(useful_patterns) <= 16384),
    critic_summary TEXT NOT NULL CHECK (length(critic_summary) <= 16384),
    truncated_json TEXT NOT NULL CHECK (json_valid(truncated_json)),
    created_at_ms INTEGER NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(id)
  );

  CREATE TABLE IF NOT EXISTS run_archives (
    run_id TEXT PRIMARY KEY,
    goal TEXT NOT NULL CHECK (length(goal) <= 65536),
    final_status TEXT NOT NULL,
    summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
    archived_at_ms INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_runs_schedulable
    ON runs(status, deadline_at_ms, created_at_ms);
  CREATE INDEX IF NOT EXISTS idx_nodes_schedulable
    ON nodes(run_id, plan_revision, status, order_index, id);
  CREATE INDEX IF NOT EXISTS idx_nodes_parent
    ON nodes(parent_node_id);
  CREATE INDEX IF NOT EXISTS idx_subnode_links_child
    ON subnode_links(child_node_id, state);
  CREATE INDEX IF NOT EXISTS idx_nodes_thread_assignment
    ON thread_assignments(node_id, state);
  CREATE INDEX IF NOT EXISTS idx_assignments_thread
    ON thread_assignments(thread_id);
  CREATE INDEX IF NOT EXISTS idx_assignments_launch
    ON thread_assignments(launch_key, state);
  CREATE INDEX IF NOT EXISTS idx_dependencies_dependency
    ON node_dependencies(run_id, plan_revision, depends_on_node_id, node_id);
  CREATE INDEX IF NOT EXISTS idx_role_calls_run
    ON role_calls(run_id, phase, status, created_at_ms);
  CREATE INDEX IF NOT EXISTS idx_events_run
    ON events(run_id, id);
  CREATE INDEX IF NOT EXISTS idx_events_thread
    ON events(thread_id, id);
  CREATE INDEX IF NOT EXISTS idx_episodes_fingerprint
    ON episodes(goal_fingerprint, created_at_ms DESC);
  `,
  `
  CREATE TRIGGER IF NOT EXISTS nodes_validate_parent
  BEFORE INSERT ON nodes
  WHEN NEW.parent_node_id IS NOT NULL
  BEGIN
    SELECT CASE
      WHEN (SELECT run_id FROM nodes WHERE id = NEW.parent_node_id) IS NULL
        THEN RAISE(ABORT, 'parent node does not exist')
      WHEN (SELECT run_id FROM nodes WHERE id = NEW.parent_node_id) <> NEW.run_id
        THEN RAISE(ABORT, 'parent node belongs to another run')
      WHEN NEW.depth <> (SELECT depth + 1 FROM nodes WHERE id = NEW.parent_node_id)
        THEN RAISE(ABORT, 'invalid parent depth')
    END;
  END;

  CREATE TRIGGER IF NOT EXISTS nodes_validate_revision
  BEFORE INSERT ON nodes
  BEGIN
    SELECT CASE
      WHEN (SELECT run_id FROM plan_versions
            WHERE run_id = NEW.run_id AND revision = NEW.plan_revision) IS NULL
        THEN RAISE(ABORT, 'node revision does not exist')
      WHEN NEW.parent_node_id IS NOT NULL
       AND (SELECT plan_revision FROM nodes WHERE id = NEW.parent_node_id) > NEW.plan_revision
        THEN RAISE(ABORT, 'parent belongs to a later revision')
    END;
  END;

  CREATE TRIGGER IF NOT EXISTS dependencies_validate_revision
  BEFORE INSERT ON node_dependencies
  BEGIN
    SELECT CASE
      WHEN (SELECT run_id FROM nodes WHERE id = NEW.node_id) <> NEW.run_id
        THEN RAISE(ABORT, 'dependent crosses run boundary')
      WHEN (SELECT run_id FROM nodes WHERE id = NEW.depends_on_node_id) <> NEW.run_id
        THEN RAISE(ABORT, 'dependency crosses run boundary')
      WHEN (SELECT plan_revision FROM nodes WHERE id = NEW.node_id) <> NEW.plan_revision
        THEN RAISE(ABORT, 'dependent is not in edge revision')
      WHEN (SELECT plan_revision FROM nodes WHERE id = NEW.depends_on_node_id) <> NEW.plan_revision
        THEN RAISE(ABORT, 'dependency is not in edge revision')
      WHEN EXISTS (
        WITH RECURSIVE reachable(id) AS (
          SELECT NEW.depends_on_node_id
          UNION
          SELECT d.depends_on_node_id
          FROM node_dependencies d
          JOIN reachable r
            ON r.id = d.node_id
           AND d.run_id = NEW.run_id
           AND d.plan_revision = NEW.plan_revision
        )
        SELECT 1 FROM reachable WHERE id = NEW.node_id
      ) THEN RAISE(ABORT, 'node dependency cycle')
    END;
  END;

  CREATE TRIGGER IF NOT EXISTS events_append_only_update
  BEFORE UPDATE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
  END;
  `,
] as const;
```

The factory opens one handle per generation:

```ts
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MIGRATIONS } from "./src/persistence/schema.js";

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  // Register all generation-owned handlers and services here.
}
```

The repository never relies on SQLite cascades for correctness because `PRAGMA foreign_keys` is not assumed. V1 does not delete ordinary rows except through `archiveRun`, which deletes in explicit child-first order inside one transaction. The repository also performs application-level same-run and same-revision checks before every insert.

### Ready-node query

Readiness is persisted for observability but recomputed before every claim. It is never materialized while the run is planning, verifying, stopping, or terminal.

```sql
UPDATE nodes AS n
SET status = 'ready'
WHERE n.run_id = :run_id
  AND n.plan_revision = (
    SELECT active_revision FROM runs WHERE id = :run_id
  )
  AND n.status = 'pending'
  AND EXISTS (
    SELECT 1 FROM runs r
    WHERE r.id = n.run_id
      AND r.status = 'executing'
      AND r.deadline_at_ms > :now_ms
  )
  AND NOT EXISTS (
    SELECT 1
    FROM node_dependencies d
    JOIN nodes dependency ON dependency.id = d.depends_on_node_id
    WHERE d.run_id = n.run_id
      AND d.plan_revision = n.plan_revision
      AND d.node_id = n.id
      AND dependency.status <> 'succeeded'
  );

SELECT n.*
FROM nodes AS n
JOIN runs AS r ON r.id = n.run_id
WHERE n.run_id = :run_id
  AND n.plan_revision = r.active_revision
  AND r.status = 'executing'
  AND r.deadline_at_ms > :now_ms
  AND n.status IN ('pending', 'ready')
  AND NOT EXISTS (
    SELECT 1
    FROM node_dependencies d
    JOIN nodes dependency ON dependency.id = d.depends_on_node_id
    WHERE d.run_id = n.run_id
      AND d.plan_revision = n.plan_revision
      AND d.node_id = n.id
      AND dependency.status <> 'succeeded'
  )
ORDER BY n.order_index, n.created_at_ms, n.id;
```

Nodes with a failed, blocked, or cancelled dependency are transitioned to `blocked` in a guarded transaction. The active revision, not historical revisions, determines execution and required coverage.

## Orchestration engine

### Run lifecycle

1. `createRun` validates the project, environment, host, goal size, role selections, and hard limits. It snapshots the complete validated configuration and model tuples into `runs.config_json` and `runs.limits_json`.
2. The service reserves the unique role call `planner:plan:0`, creates a `thread_assignments` launch intent, and starts the hidden Planner.
3. Planner output is parsed with duplicate-key detection, validated against the strict plan schema, checked for references, acyclicity, deterministic depths, checks, report-node existence, and remaining node capacity. Only a fully valid plan is materialized in one transaction.
4. The run changes to `executing`. The scheduler marks eligible nodes `ready`, claims them with a worker lease, and starts Workers up to `maxConcurrentWorkers`.
5. Worker idle and failed events enqueue a pump. The pump reads the thread output, claims the expected assignment transition with CAS, persists one result for that attempt, runs Tier 1 checks, and cleans the hidden thread in a `finally` path.
6. A Worker `MISSING_INFO` tool call changes only the current attempt to `missing_info`. The scheduler reserves exactly one `planner:replan:<n>` operation in a transaction, then creates a new plan revision. A third replan when the ceiling is two fails the run.
7. A Worker sub-node creates a child node and a dependency edge from the parent to the child. The parent enters `waiting`, releases its worker lease, and receives a continuation containing the child's bounded validated result after the child succeeds. The parent cannot report success until all child links for that attempt are acknowledged.
8. When every node in the active revision, including the report node, is `succeeded` and all node and run checks pass, the run enters `verifying`. The Critic receives the bounded report and evidence.
9. `accept` changes the run to `done`; `reject`, invalid Critic JSON, failed checks, a missing report, or incomplete required coverage changes it to `failed`. No path marks incomplete coverage successful.

### Durable scheduler tick

```ts
export async function schedulerTick(
  ctx: GenerationContext,
  nowMs: number,
): Promise<void> {
  await reconcileLaunchIntents(ctx, nowMs);
  await enforceRunDeadlines(ctx, nowMs);
  await enforceNodeDeadlines(ctx, nowMs);
  await recoverExpiredLeases(ctx, nowMs);
  await retryTransientFailures(ctx, nowMs);

  for (const run of listActiveRuns(ctx.db, nowMs)) {
    await propagateBlockedNodes(ctx.db, run.id, nowMs);
    if (run.status === "planning") await advancePlanning(ctx, run.id, nowMs);
    if (run.status === "executing") {
      await materializeReadyNodes(ctx.db, run.id, nowMs);
      await spawnClaimedWorkers(ctx, run.id, nowMs);
      await maybeStartVerification(ctx, run.id, nowMs);
    }
    if (run.status === "verifying") await advanceCritic(ctx, run.id, nowMs);
    if (run.status === "stopping") await reconcileCancellation(ctx, run.id, nowMs);
  }
}
```

The service uses an owned abort-aware timer. `sleep` is not assumed to be a BB API.

```ts
export function waitForNextTick(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
```

The registration is generation-owned and drains before disposal:

```ts
bb.background.service("scheduler", {
  async start(signal) {
    const generation = createGenerationContext(bb, db, signal);
    await recoverAfterRestart(generation);
    while (!signal.aborted) {
      await schedulerTick(generation, Date.now());
      await waitForNextTick(signal, 1000);
    }
  },
});

bb.onDispose(async () => {
  await generationFence.stopAndDrain();
  await cleanupAllNonterminalAssignments(bb, db);
});
```

`pumpTail` is generation-scoped, tracked, and awaited by `stopAndDrain`. No detached promise may retain an old `bb` handle or database after reload.

### Launch, harvest, and cleanup protocol

Every Planner, Worker, Critic, and sub-node uses the same protocol:

1. In `BEGIN IMMEDIATE`, reserve the role call or node attempt, the cancellation generation, the per-call deadline, the unique `launch_key`, and, for Workers, one `worker_leases` row. Set the node or role call to `launching`.
2. Spawn the hidden thread with the documented fields `projectId`, `environment`, exactly one `prompt` or `input`, `title`, and `visibility: "hidden"`. The title contains the opaque launch key for recovery, and the prompt contains it too.
3. In a CAS transaction, record the returned `thread_id`, change the assignment to `spawned`, and change the node or role call to `running`.
4. Immediately reconcile the returned thread with `threads.get` and `threads.timeline` or `threads.output`. A completion that happened before mapping is harvested through this step.
5. On any post-spawn database failure, call `cleanupHiddenThread` for the returned ID and record the launch failure. If the process dies before recording the ID, startup reconciliation finds a unique attributed launch match; zero matches becomes `ORPHANED_THREAD`, and multiple matches fail the run and clean every match.
6. After result or failure ownership is claimed, archive the hidden thread and then stop it. Both calls are attempted in `finally`; cleanup failures remain durably visible for the next sweep.

```ts
export async function cleanupHiddenThread(
  bb: BbPluginApi,
  threadId: string,
): Promise<{ archived: boolean; stopped: boolean }> {
  let archived = false;
  let stopped = false;
  let cleanupError: unknown = null;
  try {
    await bb.sdk.threads.archive({ threadId });
    archived = true;
  } finally {
    try {
      await bb.sdk.threads.stop({ threadId });
      stopped = true;
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError) throw cleanupError;
  return { archived, stopped };
}
```

`thread.idle`, `thread.failed`, `thread.archived`, and `thread.deleted` handlers only enqueue generation-owned reconciliation. Every effect has an `event_key` or `(run, node, attempt, generation)` uniqueness key. A late event can never overwrite `missing_info`, `waiting`, `cancel_requested`, a timeout result, or a terminal node.

### Node claim and worker capacity

```ts
export interface ClaimWorkerInput {
  runId: string;
  nodeId: string;
  leaseId: string;
  assignmentId: string;
  nowMs: number;
}

export function claimWorker(
  db: PluginDb,
  input: ClaimWorkerInput,
): { claimed: true; attempt: number; deadlineAtMs: number } | { claimed: false };
```

The transaction checks all of the following before changing `ready` to `launching`: active run generation, active revision, deadline, dependency success, `attempt_count < maxAttemptsPerNode`, and `COUNT(worker_leases WHERE released_at_ms IS NULL) < maxConcurrentWorkers`. It increments `attempt_count`, creates the lease, and creates the assignment in the same transaction. Scheduler and sub-node paths call this same repository operation.

`waiting` parents do not hold a worker lease while a child is executing. The child result continuation reacquires a lease before sending the parent continuation. If no slot is available, the parent remains `waiting` and is retried later.

### Replans

`reserveReplan` is one immediate transaction:

```ts
export function reserveReplan(
  db: PluginDb,
  input: { runId: string; generation: number; nowMs: number },
): { revision: number; roleCallId: string } | { limit: "maxReplansPerRun" | "already_owned" };
```

It requires `runs.status = 'executing'`, the supplied generation, one or more durable `missing_info` records, and `replan_count < maxReplansPerRun`. It increments `replan_count`, creates `planner:replan:<n>`, and records a phase owner before any Planner spawn. A second scheduler pass receives `already_owned` and does not create another Planner.

The new revision contains fresh physical node IDs. `reuseOf` must identify a prior physical node ID in the same run, and the repository copies its validated result only when that node is `succeeded`. Every new revision has an explicit report node and explicit required node set: all nodes in that revision are required, including reused nodes. Nodes removed by the new revision remain historical and are not silently treated as completed coverage.

### Error classes and recovery

```ts
export type HarnessErrorClass =
  | "transient"
  | "tool-misuse"
  | "missing-info"
  | "policy"
  | "unknown";
```

- `transient`: only a conservative, plugin-owned classification of known transport or rate-limit conditions. Retry uses exponential backoff while the node attempt ceiling remains available.
- `tool-misuse`: structured schema or tool-result errors are returned to the current Worker when correction is safe.
- `missing-info`: only the durable `harness_declare_missing_info` tool can create it. It starts an informed replan after the Worker attempt is harvested.
- `policy`: halt immediately and cancel all outstanding work.
- `unknown`: fail the node and run. An arbitrary error string is not treated as a retry signal.

`maxAttemptsPerNode` is enforced inside the claim CAS, not by the caller. At exhaustion the run fails with `LIMIT_MAX_ATTEMPTS_PER_NODE`.

### Sub-node protocol

The tool executor derives `runId`, `parentNodeId`, attempt, role, and generation exclusively from its authenticated `threadId`. Model-supplied IDs are not trusted.

```ts
export interface OpenSubnodeInput {
  title: string;
  prompt: string;
  checks: readonly DeterministicCheckDeclaration[];
}

export interface OpenSubnodeAccepted {
  accepted: true;
  nodeId: string;
  parentNodeId: string;
  state: "queued";
}

export interface OpenSubnodeRejected {
  accepted: false;
  code: "run_not_active" | "not_worker" | "limit_exceeded" | "invalid_input";
  message: string;
}

export async function openSubnode(
  input: OpenSubnodeInput,
  caller: { threadId: string; signal: AbortSignal },
): Promise<OpenSubnodeAccepted | OpenSubnodeRejected>;
```

The immediate transaction checks active Worker assignment, parent status, `parent.depth + 1 <= maxSubnodeDepth`, `node_count < maxNodesPerRun`, event and result byte ceilings, and the current generation. It increments `node_count`, inserts the child, checks, dependency edge `parent depends on child`, and `subnode_opened` event atomically. The parent becomes `waiting` and its worker lease is released. On limit failure, a savepoint rolls back child work, then a second guarded transaction fails the run, cancels all nonterminal nodes, and records the limit event. A limit rejection never disappears in a rolled-back transaction.

When the child succeeds, the scheduler records its complete bounded `WorkerResult` in the parent link payload and sends a continuation to the same parent thread. The parent must acknowledge the child in `harness_report_result`. A child failure, missing information, cancellation, or timeout blocks the parent and prevents Critic start. This makes child output part of the required evidence path.

### Run stop, timeout, and crash recovery

All stop causes use `stopRunForReason`:

```ts
export type StopReason = {
  code:
    | "LIMIT_MAX_NODES_PER_RUN"
    | "LIMIT_MAX_SUBNODE_DEPTH"
    | "LIMIT_MAX_REPLANS_PER_RUN"
    | "LIMIT_MAX_ATTEMPTS_PER_NODE"
    | "LIMIT_NODE_WALL_CLOCK"
    | "LIMIT_RUN_WALL_CLOCK"
    | "POLICY_VIOLATION"
    | "ORPHANED_THREAD"
    | "CANCELLED"
    | "INCOMPLETE_COVERAGE";
  message: string;
  nodeId: string | null;
  observed?: number;
  ceiling?: number;
};

export function stopRunForReason(
  db: PluginDb,
  runId: string,
  expectedGeneration: number,
  reason: StopReason,
  nowMs: number,
): string[]; // affected thread IDs
```

The CAS transaction requires an active status and generation, changes the run to `stopping`, increments `generation`, writes the first stop reason, marks every nonterminal node including `planned`/`pending`, `missing_info`, `waiting`, and unresolved launch states as `cancelled`, releases worker leases, and appends one `run.stopped` event. It returns all mapped thread IDs. Cleanup then archives and stops those exact IDs. Subsequent tool calls and lifecycle events fail closed because their generation no longer matches.

The run watchdog compares `deadline_at_ms <= nowMs`; the node watchdog compares each assignment deadline. The node/run state transition and event are committed before thread cleanup. A late Worker cannot turn a timed-out node into success. The watchdog also sweeps role calls, so Planner and Critic calls have the same attempt and timeout protection as Workers.

On service startup:

1. Fence the previous generation and verify the current database handle.
2. Reconcile every non-cleaned assignment by persisted thread ID.
3. For idle or failed threads, harvest immediately. For active threads, restore deadline supervision.
4. Find reserved or launching assignments without thread IDs and reconcile using the unique launch key and BB attribution. Ambiguous matches fail and clean the run.
5. Reset only unspawned launching nodes whose attempt ceiling remains available; mapped launch attempts are never duplicated.
6. List attributed hidden threads page by page, clean unassigned ones, and process `thread.archived`/`thread.deleted` state.
7. Resume the scheduler only after reconciliation completes.

### Cancellation

```sh
bb harness stop run_01JABC
```

`stop` is idempotent. A terminal run returns its existing status. An active run enters the guarded stopping protocol above. A CLI disconnect does not cancel a run unless `stop` is explicitly requested.

## Roles, skills, prompts, model tiering, and memory

### Static skills

```text
skills/harness-planner/SKILL.md
skills/harness-worker/SKILL.md
skills/harness-critic/SKILL.md
```

The Planner skill requires one strict JSON plan with explicit dependencies, one report node, bounded declarative checks, assumptions, and risks. The Worker skill requires one node result, prohibits whole-plan redesign, and explains when to use the two escape-hatch tools. The Critic skill reviews correctness, completeness, evidence, scope, and unnecessary complexity and returns only its verdict schema.

### Contracts

```ts
export interface HarnessPlan {
  schemaVersion: 1;
  summary: string;
  reportNodeId: string;
  nodes: Array<{
    id: string;
    title: string;
    instructions: string;
    dependsOn: string[];
    checks: DeterministicCheckDeclaration[];
    reuseOf: string | null;
  }>;
}

export interface WorkerResult {
  status: "SUCCEEDED" | "MISSING_INFO" | "FAILED";
  summary: string;
  artifacts: Array<{ path: string; description: string }>;
  checkEvidence: Array<{ checkId: string; observed: boolean; evidence: string }>;
  subnodes: Array<{
    nodeId: string;
    status: "SUCCEEDED" | "MISSING_INFO" | "FAILED";
    summary: string;
    artifacts: Array<{ path: string; description: string }>;
    checkEvidence: Array<{ checkId: string; observed: boolean; evidence: string }>;
    blocker?: string;
  }>;
  blocker?: string;
}

export interface CriticVerdict {
  verdict: "accept" | "reject";
  summary: string;
  criteria: Array<{
    criterionId: string;
    satisfied: boolean;
    evidence: string[];
  }>;
  blockingIssues: string[];
  requestedChanges: string[];
}
```

### Agent configuration and role identity

Each role has a validated selection `{ providerId, model, reasoningLevel, serviceTier? }`, persisted in the run snapshot. Provider and model catalogs are checked before a run or replan is spawned. A model identifier without its provider is never considered effective.

The factory registers all four tools once, then configures only plugin-originated non-side-chat sessions. The intended configuration is:

```ts
bb.agents.configure((context) => {
  if (context.sideChat || context.origin.pluginId !== bb.pluginId) {
    return { skills: [], tools: [] };
  }

  const binding = currentBindingForGeneration(context.thread.id);
  if (!binding) return { skills: [], tools: [] };

  if (binding.role === "planner") {
    return { skills: ["harness-planner"], tools: [] };
  }
  if (binding.role === "critic") {
    return { skills: ["harness-critic"], tools: [] };
  }
  return {
    skills: ["harness-worker"],
    tools: [
      "harness_open_subnode",
      "harness_declare_missing_info",
      "harness_report_result",
      "harness_read_status",
    ],
  };
});
```

The callback is synchronous and generation-scoped. It never uses a closed handle. Tool registrations are checked for successful ownership; if a cross-plugin name collision drops one, the plugin enters a configuration error rather than returning an unknown tool ID.

The launch protocol must establish the durable role binding before the provider session resolves `configure`. The available contract does not document an atomic spawn-plus-plugin-binding operation. Therefore the role-specific launch path is a V1 implementation gate, not a guessed post-spawn update sequence.

### Prompts and context bounds

Prompts are plain templates with bounded sections:

```ts
export function assembleWorkerPrompt(
  run: RunRecord,
  plan: PlanVersionRecord,
  node: NodeRecord,
  upstream: readonly UpstreamResult[],
  memory: BoundedMemory,
): string;

export function assemblePlannerPrompt(
  run: RunRecord,
  priorPlan: PlanVersionRecord | null,
  missing: readonly MissingInfoRecord[],
  memory: BoundedMemory,
): string;

export function assembleCriticPrompt(
  run: RunRecord,
  report: ReportRecord,
  checks: readonly CheckResultRecord[],
  outcomes: readonly WorkerResult[],
): string;
```

Each role prompt is checked in UTF-8 bytes before its role call is claimed. `maxContextChars` is a fixed safety ceiling of 60,000 characters in the run snapshot. An oversized prompt produces `LIMIT_CONTEXT_BYTES` and a durable run failure; it does not strand a launching node.

### Memory

- Working memory is normalized run state in SQLite: goal, active revision, plan summary, current node, dependency summaries, limits, and recent outcomes.
- Episodic memory is one bounded `episodes` row per terminal run. Retrieval takes at most 100 recent candidates, tokenizes lower-case words, scores Jaccard overlap against the current goal, then returns the top three under 4,000 characters. Ties use newest `created_at_ms` and ID. Truncation metadata is stored in `truncated_json`.
- Semantic memory is not required for V1 correctness. If the builtin `memory` plugin exposes a supported cross-plugin read contract, the plugin may add a bounded semantic section. Otherwise the run records `semantic_memory: unavailable` in its event payload and continues without pretending semantic retrieval happened.

## Verification gate and runaway limits

### Deterministic checks

```ts
export type DeterministicCheckDeclaration =
  | { id: string; kind: "node_status_is"; expected: "SUCCEEDED" }
  | { id: string; kind: "output_field_present"; field: "summary" | "artifacts" | "checkEvidence" }
  | { id: string; kind: "output_contains"; text: string }
  | { id: string; kind: "artifact_declared"; path: string }
  | { id: string; kind: "command"; command: string; cwd: string; expectedExitCode: number }
  | { id: string; kind: "file_exists"; path: string }
  | { id: string; kind: "file_contains"; path: string; literal: string };

export interface Tier1Result {
  checkId: string;
  status: "passed" | "failed" | "error" | "timed_out" | "truncated";
  observed: Record<string, unknown>;
  createdAtMs: number;
}
```

Command `cwd` and file paths are workspace-relative only. Absolute paths, `..` traversal, empty paths, and symlink escapes are rejected after host-side canonicalization. Checks run on the selected environment host through the plugin's own `bb.host` entry, never through server-local `node:fs`, a throwaway model thread, or an interactive terminal. The host captures bounded stdout/stderr and terminates the complete process tree on timeout.

```ts
export const hostContract = defineRpcContract({
  runCheck: {
    input: z.object({
      rootPath: z.string().min(1),
      check: deterministicCheckSchema,
      timeoutMs: z.number().int().positive(),
    }).strict(),
    output: z.object({
      status: z.enum(["passed", "failed", "error", "timed_out"]),
      exitCode: z.number().int().nullable(),
      exists: z.boolean().nullable(),
      contains: z.boolean().nullable(),
      stdout: z.string(),
      stderr: z.string(),
      outputTruncated: z.boolean(),
      error: z.string().nullable(),
    }).strict(),
  },
});
```

Every node must have at least one check and every plan must have at least one run-scoped check. Tier 2 does not run when any required node, report node, or check has failed, timed out, errored, or been truncated. The run stores the reason as `not_run` rather than silently bypassing the Critic.

### Hard limits

The only user-configurable runaway limits are snapshotted in `runs.limits_json`:

| Name | Default | Enforcement |
|---|---:|---|
| `maxNodesPerRun` | 64 | Atomic `runs.node_count` reservation for initial plan, every replan, and every sub-node. |
| `maxSubnodeDepth` | 3 | Parent depth plus one, checked in the child insertion transaction. |
| `maxReplansPerRun` | 2 | Atomic reservation of `planner:replan:<n>`. |
| `maxAttemptsPerNode` | 2 | Atomic Worker claim predicate. |
| `perNodeWallClockTimeoutMs` | 900000 | Persisted node/assignment deadline, including retries and continuations. |
| `perRunWallClockTimeoutMs` | 3600000 | Persisted run deadline from run start through Critic. |
| `maxConcurrentWorkers` | 5 | Atomic active `worker_leases` reservation. Saturation queues ready nodes; it does not fail a valid run. |

Configuration values are finite safe integers with explicit bounds. Decimal strings are parsed once and rejected if they exceed the configured maximum; they are never silently clamped. A setting change never changes an existing run snapshot.

Limit failures use the exact limit code, observed value, ceiling, phase, affected node, and message. Every limit except normal concurrency saturation invokes the terminal stop transaction and cleanup protocol. No limit silently removes nodes or checks.

### Terminalization race rules

One transaction performs each final decision:

- rechecks run status, generation, deadline, active revision, all required node states, report state, and active launch assignments;
- writes Tier 1 or Tier 2 results;
- changes `verifying` to `done` or `failed`, or changes an active run to `stopping`/`failed` for a limit;
- writes the durable event with a unique effect key.

The same transaction cannot be won by a timeout, cancellation, normal completion, and Critic path simultaneously. Once a terminal run is committed, all event handlers and tools reject further mutation.

## Frontend: the DAG panel

### Files and slots

```text
bb-plugin-harness/
  app.tsx
  contract.ts
  realtime.ts
  components/
    harness-nav-panel.tsx
    harness-run-panel.tsx
    harness-header-action.tsx
    run-count-accessory.tsx
    run-list.tsx
    run-graph.tsx
    run-status.tsx
    worker-conversation.tsx
    graph-error-boundary.tsx
    ui/button.tsx
    ui/badge.tsx
    ui/card.tsx
    ui/dialog.tsx
    ui/alert-dialog.tsx
    ui/skeleton.tsx
```

The app registers one `navPanel` at `runs`, one `threadPanelAction` that opens a selected run in a flush panel, one command-palette action, and one experimental thread-header action. `run-count-accessory.tsx` and `harness-header-action.tsx` are real files, not omitted imports. No `fixedTabs`, settings section, homepage section, or custom composer is used.

### RPC wire rules

RPC method names are `listRuns`, `getRunDetail`, `getNodeDetail`, `cancelRun`, and `retryNode`. The backend contract uses bounded strings for status and role so future values survive the wire. The frontend maps unknown values to a neutral label and never discards the entire response.

```ts
export const rpcContract = defineRpcContract({
  listRuns: {
    input: z.object({
      projectId: z.string().nullable().optional(),
      cursor: z.string().nullable(),
      limit: z.number().int().min(1).max(100),
    }).strict(),
    output: z.object({
      runs: z.array(runSummarySchema),
      nextCursor: z.string().nullable(),
    }).strict(),
  },
  getRunDetail: {
    input: z.object({ runId: z.string().min(1) }).strict(),
    output: runDetailSchema,
  },
  getNodeDetail: {
    input: z.object({ runId: z.string().min(1), nodeId: z.string().min(1) }).strict(),
    output: nodeDetailSchema,
  },
  cancelRun: {
    input: z.object({ runId: z.string().min(1), expectedGeneration: z.number().int().nonnegative() }).strict(),
    output: mutationResultSchema,
  },
  retryNode: {
    input: z.object({ runId: z.string().min(1), nodeId: z.string().min(1), expectedAttempt: z.number().int().nonnegative() }).strict(),
    output: mutationResultSchema,
  },
});
```

Node DTOs expose `order`, `dependsOn`, `childNodeIds`, `topologicalRank`, and bounded previews with `{ text, originalBytes, includedBytes, truncated }`. The server validates every dependency and child reference, and the frontend rejects a malformed graph with an inline error while preserving the last valid data. Full output is a separate paged RPC path, not an unbounded `getRunDetail` field.

The graph rank is calculated with Kahn topological ordering after reference and cycle validation. Supplied ranks are accepted only when every edge satisfies `rank(dependent) > rank(dependency)`; otherwise the server rank is recomputed. Nodes sort by persisted `order`, then ID. Edges use an instance-scoped SVG marker ID.

Realtime sends only `{ changed, runId, nodeId? }` after the SQLite commit. A shared refresh coordinator coalesces bursts, assigns monotonically increasing request sequence numbers, and ignores stale responses. Reconnect to `connected` refetches both list and detail because signals are ephemeral. Cursor pagination is available through `listRuns`; older runs are never silently hidden behind a fixed first page.

The graph is horizontally scrollable CSS grid with one column per rank and an SVG edge overlay. Each node card is an accessible button when a thread exists. `ThreadChat` is used for the conversation drawer with `variant="compact"`, `layout="contained"`, and `permissionPolicy="inherit"`. A local graph error boundary isolates graph failures from list and toolbar rendering.

Cancel and retry buttons are disabled while their mutation is in flight. The backend checks expected generation or attempt in the same transaction, so a stale panel cannot approve a newer state or retry the same attempt twice. V1 has no Critic approval action.

## CLI, settings, and agent tools

### Canonical CLI verbs

The one top-level command is `harness`. Its verbs are `run`, `plan`, `status`, `show`, `nodes`, `logs`, `stop`, `retry`, `roles`, and `archive`.

```sh
bb harness run --goal "Add retry handling to the payment webhook and update its tests"
bb harness plan --goal-file "/absolute/path/goal.md" --project proj_123 --machine host_123
bb harness status run_01JABC --json
bb harness show run_01JABC --section report --limit 20 --json
bb harness nodes run_01JABC --state running --limit 50 --json
bb harness logs run_01JABC --after 120 --limit 100 --json
bb harness stop run_01JABC --json
bb harness retry run_01JABC --node node_01JABC --json
bb harness roles --json
bb harness archive run_01JABC --yes --json
```

`run` creates and asynchronously starts a run, returning its ID. `plan` creates a planning-only run and never starts Workers or a Critic. `show --section report` uses byte-based pagination under `PLUGIN_CLI_OUTPUT_MAX_BYTES`; a single oversized field returns `output_too_large` with a dedicated content-fetch cursor. JSON output always contains `command`, `ok`, and the relevant data or error envelope. The size guard reserves room for the newline and uses `PLUGIN_CLI_OUTPUT_MAX_BYTES` from `@get-bb/plugin-sdk`.

`--goal-file` is absolute and read through `bb.sdk.files.read` on the invoking host. Its size is checked before accepting it. `ctx.cwd` is never used as a server-local interpretation of a remote path. `--machine` is the explicit no-thread host selector.

`archive` requires a terminal run and `--yes`. It copies a bounded summary to `run_archives`, deletes all child rows in explicit order, then deletes the run. It cannot be undone by the plugin. The frontend does not expose this destructive operation.

### Settings

```ts
export function defineSettings(bb: BbPluginApi) {
  return bb.settings.define({
    defaultProject: { type: "project", label: "Default project" },
    roleRouting: {
      type: "string",
      label: "Planner, Worker, and Critic routing JSON",
      experimental_multiline: true,
      default: "{}",
    },
    maxNodesPerRun: { type: "string", label: "Maximum nodes per run", default: "64" },
    maxSubnodeDepth: { type: "string", label: "Maximum sub-node depth", default: "3" },
    maxReplansPerRun: { type: "string", label: "Maximum replans per run", default: "2" },
    maxAttemptsPerNode: { type: "string", label: "Maximum attempts per node", default: "2" },
    perNodeWallClockTimeoutMs: { type: "string", label: "Per-node wall-clock timeout", default: "900000" },
    perRunWallClockTimeoutMs: { type: "string", label: "Per-run wall-clock timeout", default: "3600000" },
    maxConcurrentWorkers: { type: "string", label: "Maximum concurrent workers", default: "5" },
  });
}
```

Example routing JSON uses the live catalog values only as an example and is revalidated at run time:

```json
{
  "planner": { "providerId": "codex", "model": "gpt-5.6-sol", "reasoningLevel": "high" },
  "worker": { "providerId": "codex", "model": "gpt-5.6-luna", "reasoningLevel": "medium" },
  "critic": { "providerId": "codex", "model": "gpt-5.6-sol", "reasoningLevel": "high" }
}
```

Settings are parsed, provider-plus-model validated, and snapshotted at run creation. Invalid configuration marks the plugin `needs-configuration`; it does not crash-loop the service. No setting contains a secret.

### Agent tools

The four static names are `harness_open_subnode`, `harness_declare_missing_info`, `harness_report_result`, and `harness_read_status`. Every executor receives `{ threadId, projectId, signal }`, derives authorization from `thread_assignments`, checks role, generation, attempt, node state, and run status, and returns a bounded structured tool error rather than throwing through the factory.

```ts
export function registerAgentTools(
  bb: BbPluginApi,
  orchestrator: Orchestrator,
): void {
  bb.agents.registerTool({
    name: "harness_open_subnode",
    description: "Queue one bounded child Worker for separable work.",
    parameters: openSubnodeSchema,
    async execute(input, context) {
      return orchestrator.openSubnode(input, context);
    },
  });
  bb.agents.registerTool({
    name: "harness_declare_missing_info",
    description: "Record a concrete information gap that requires an informed replan.",
    parameters: missingInfoSchema,
    async execute(input, context) {
      return orchestrator.declareMissingInfo(input, context);
    },
  });
  bb.agents.registerTool({
    name: "harness_report_result",
    description: "Record one bounded Worker result for the current node attempt.",
    parameters: workerResultSchema,
    async execute(input, context) {
      return orchestrator.reportResult(input, context);
    },
  });
  bb.agents.registerTool({
    name: "harness_read_status",
    description: "Read bounded status for the authorized harness run.",
    parameters: readStatusSchema,
    async execute(input, context) {
      return orchestrator.readStatus(input, context);
    },
  });
}
```

## Packaging, distribution, and file tree

### Manifest

```json
{
  "name": "bb-plugin-harness",
  "version": "0.1.0",
  "type": "module",
  "engines": { "bb": ">=0.40.0", "bbPluginSdk": ">=0.4.3" },
  "scripts": {
    "build": "bb plugin build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^4.0.0" },
  "devDependencies": {
    "@get-bb/plugin-sdk": "0.4.3",
    "bb-app": "^0.40.0",
    "typescript": "^5.8.0",
    "vitest": "^3.2.0"
  },
  "files": ["dist", "server.ts", "app.tsx", "host.ts", "skills", "package.json"],
  "bb": {
    "name": "Harness",
    "description": "Bounded Planner, Worker, and Critic orchestration over BB threads.",
    "branding": { "icon": "Zap" },
    "server": "./server.ts",
    "app": "./app.tsx",
    "host": "./host.ts",
    "skills": ["skills"]
  }
}
```

The final tree is:

```text
bb-plugin-harness/
  package.json
  tsconfig.json
  server.ts
  app.tsx
  host.ts
  contract.ts
  realtime.ts
  src/
    agent-tools.ts
    configuration.ts
    limits.ts
    persistence/schema.ts
    persistence/repository.ts
    orchestration/engine.ts
    orchestration/scheduler.ts
    orchestration/launches.ts
    orchestration/harvesting.ts
    orchestration/recovery.ts
    orchestration/errors.ts
    verification/checks.ts
    verification/host-contract.ts
    memory/episodes.ts
    cli.ts
  components/
    harness-nav-panel.tsx
    harness-run-panel.tsx
    harness-header-action.tsx
    run-count-accessory.tsx
    run-list.tsx
    run-graph.tsx
    run-status.tsx
    worker-conversation.tsx
    graph-error-boundary.tsx
    ui/
      button.tsx
      badge.tsx
      card.tsx
      dialog.tsx
      alert-dialog.tsx
      skeleton.tsx
  skills/
    harness-planner/SKILL.md
    harness-worker/SKILL.md
    harness-critic/SKILL.md
  tests/
    persistence.test.ts
    planner.test.ts
    orchestration.test.ts
    host-checks.test.ts
    cli.test.ts
    agent-tools.test.ts
    app.test.tsx
  eval/fixtures/
    coding-retry.json
    missing-info-replan.json
    subnode-result-barrier.json
    limit-failures.json
```

## Testing and eval plan

Use the official fake host for backend behavior and real better-sqlite3 storage. Use the frontend harness for slot and RPC behavior. Run host-entry checks with the host testing entrypoint and an injected process-tree adapter.

```sh
bb plugin types --check
npx vitest run
bb plugin build
```

Persistence tests cover migration idempotency, same-run and same-revision edge checks, cycle rejection, ready-node recomputation, node reservations across initial plans/replans/sub-nodes, depth limits, claim races, worker-slot races, duplicate result rejection, replan ownership, terminalization races, append-only events, archive deletion order, and foreign-key-off behavior.

Orchestration tests cover early idle before mapping, spawn-success/database-failure compensation, ambiguous launch reconciliation, duplicate lifecycle events, late idle after timeout, stale generation tool calls, role-call timeouts, restart recovery, cancellation during spawn, sub-node result delivery, child failure propagation, and Critic refusal for incomplete coverage.

Host tests cover relative-path confinement, absolute/traversal/symlink rejection, bounded output, process-tree timeout, and explicit truncation results. CLI tests cover strict parsing, goal-file size limits, JSON envelope consistency, byte pagination, cursors, and the `PLUGIN_CLI_OUTPUT_MAX_BYTES` reserve. Frontend tests cover unknown statuses, stable order, rank recomputation, child-reference validation, refresh coalescing, stale response suppression, reconnect refetch, local graph error boundaries, and mutation locking.

Fixed eval fixtures use a mock provider with deterministic Planner, Worker, and Critic outputs. Each fixture records expected plan revisions, node outcomes, check results, replan count, terminal status, stop reason, and cleanup calls. The eval corpus must include at least one plan with parallel roots, one Worker-created child, one missing-information replan, one transient retry, one policy halt, and every hard-limit failure mode.

## Build order

1. **SDK and host contract audit, 0.5 to 1 day, independently shippable as a design/test spike.** Run `bb plugin types --check` in an actual checkout, confirm role-binding and spawn configuration, provider catalog calls, environment DTO fields, thread lifecycle fields, and host-test declarations. Keep the open-question markers until declarations and a live smoke test confirm them.
2. **Manifest, settings, generation lifecycle, and migration 1, 1 to 2 days, independently shippable.** Add load-safe factory wiring, immutable run configuration parsing, generation fencing, and the complete schema.
3. **Repository and plan validator, 2 to 3 days, independently shippable.** Implement strict duplicate-key JSON parsing, DAG validation, revision materialization, atomic node reservations, and repository tests.
4. **Launch and cleanup protocol, 2 to 3 days, independently shippable behind a mock thread SDK.** Implement assignments, CAS mapping, compensation, cleanup, event keys, and recovery sweeps.
5. **Planner and Worker scheduler, 3 to 5 days, independently shippable with mock provider runs.** Add service ticks, leases, concurrency, retries, timeout enforcement, lifecycle harvesting, and cancellation.
6. **Worker tools and sub-node barrier, 2 to 3 days, independently shippable after scheduler.** Add authorization from thread IDs, child insertion, parent waiting, result continuation, and `MISSING_INFO` persistence.
7. **Verification and host checks, 2 to 4 days, independently shippable with the host test harness.** Add Tier 1, bounded host execution, report persistence, Critic gate, and terminalization races.
8. **CLI and archival operation, 1 to 2 days, independently shippable against the repository.** Add the ten canonical verbs, byte pagination, machine routing, and explicit terminal-run archive.
9. **Frontend DAG panel, 3 to 5 days, independently shippable against a fixture RPC server.** Add typed RPC, realtime coordinator, graph layout, bounded detail views, ThreadChat drawer, actions, and error boundaries.
10. **Full eval, packaging, and release verification, 2 to 3 days, independently shippable as a release candidate.** Run `bb plugin types --check`, tests, build, a live loop smoke test, cleanup/reload tests, and package inspection before tagging.

## Risks and open questions

### Design risks

- A Worker-created child consumes scheduler capacity and can expose poor task decomposition. The parent barrier makes the result path explicit, while depth, node, attempt, timeout, and concurrency limits make runaway behavior terminal and visible.
- A model may produce syntactically valid but weak DAGs. Strict graph validation and deterministic checks catch structural failures; the Critic is reserved for subjective correctness and evidence quality.
- Hidden-thread cleanup is an operational dependency. Persisted assignments, startup reconciliation, archive-before-stop cleanup, and disposal draining are required for every role, not just Workers.
- The database can still grow across runs. Per-field and per-run event ceilings bound individual runs; `bb harness archive --yes` is the explicit terminal-run archival operation.

### Open questions and unverified API claims

The following claims must remain marked `NEEDS VERIFICATION` in implementation until `bb plugin types`, bundled declarations, and a live smoke test confirm them:

1. **NEEDS VERIFICATION: atomic role binding before provider-session construction.** The available contract documents `bb.agents.configure` and hidden `threads.spawn`, but does not document a spawn option that atomically carries plugin-owned role metadata. Confirm a supported pre-session association. If none exists, redesign the launch path around a supported creation primitive before V1 implementation. Do not infer role from a mutable title.
2. **NEEDS VERIFICATION: role selection fields on `threads.spawn`.** The authoring contract documents `model` and `reasoningLevel` on `threads.update`, not conclusively on `threads.spawn`. Confirm provider/model/reasoning/service-tier fields and their names. If post-spawn update is the only supported route, prove that it happens before provider-session construction or do not claim per-role routing.
3. **NEEDS VERIFICATION: provider catalog method arguments and DTO.** Confirm the exact `bb.sdk.providers.models` signature, provider-plus-model ownership fields, reasoning-level field, service-tier field, and host/environment routing needed to validate a snapshot.
4. **NEEDS VERIFICATION: environment and thread DTO fields used for host recovery.** Confirm the exact `bb.sdk.environments.get` response fields for `hostId` and root path, the `threads.get` lifecycle field used for idle/failed detection, and the complete pagination contract for `threads.list`. Recovery must page until exhaustion and must not assume a 500-row maximum.
5. **NEEDS VERIFICATION: cross-plugin semantic-memory read contract.** Confirm a supported RPC for the builtin `memory` plugin. Until confirmed, semantic retrieval is explicitly unavailable and is not represented as empty successful context.

These five items are implementation gates. No other BB API claim in this document should be treated as permission to invent a method or field; use the bundled declarations and the official testing harness before removing a marker.

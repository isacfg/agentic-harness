# Run artifacts

The harness keeps durable, human-readable state for each execution under `artifacts/runs/`.

The Explorer creates a unique run directory and returns its relative path. Every later role receives that same path, so the run can be audited without reconstructing context from chat history or worker summaries.

Typical accepted run:

```text
artifacts/runs/<run-id>/
├── exploration.md
├── plan.md
├── critique.md
└── promotion.md
```

Replans may add `replan-1.md`, `replan-2.md`, and so on.

## Purpose

- `exploration.md` records verified repository facts, relevant files, constraints, and unknowns before planning.
- `plan.md` records the accepted DAG and rationale.
- `replan-N.md` records a replacement plan after `missing_info` stalls execution.
- `critique.md` records the final verification verdict and concrete issues.
- `promotion.md` records the accepted handoff: what changed, validation evidence, release/PR notes, and follow-ups.

## Source control

`artifacts/runs/` is intentionally ignored by Git. Artifacts persist in the workspace but are not product source and should not create repository noise. This README stays tracked as the contract.

---
name: pi-subagents
description: Delegate work to builtin or custom Pi subagents through single-child, parallel, scripted, async, forked-context, scheduled, mission-backed, and coordinated workflows. Use when one parent should remain in control while specialized agents explore, plan, implement, review, or validate.
---

# Pi Subagents

This skill is for the parent orchestrator only. Do not inject it into ordinary children or let them orchestrate. A delegated fanout child may use `subagent` only when its resolved tools include it and only for the assigned fanout.

Use `workflowScript` for every execution. For one child, use `return runs.run("main", { agent, task })`; for coordinated work, use `runs.all([...])` or ordinary JavaScript for sequence, branching, retries, gates, and aggregation. Workflows start asynchronously by default; use `async:false` only for small foreground work.

## Progressive Disclosure

Before acting, use `read` to load only the references needed for the current operation. Resolve paths relative to this skill.

| Need | Reference |
| --- | --- |
| Delegation decisions, roles, prompting, tool vs slash-command choice | `references/prompting-and-roles.md` |
| Execution, async, resume/steer/stop, schedules, missions, fork, watchdog, oracle, intercom | `references/execution-controls.md` |
| Agent/chain management, authoring, prompt templates, extension RPC | `references/management-authoring-rpc.md` |
| Safety constraints, error handling, and standard recipes | `references/constraints-and-recipes.md` |

For broad workflows, read prompting/roles and execution controls first, then constraints/recipes before launch.

## Always-On Invariants

- The parent owns orchestration, decisions, integration, and final verification.
- Keep writes non-conflicting: one writer per overlapping file set. Parallel writers in the same cwd/worktree are allowed when the parent assigns disjoint writable files and the lanes will not collide (no shared generated/lock files, no concurrent git commit/push). Use isolated worktrees when the write sets cannot be partitioned.
- For cross-repository work, specify the target repo, `cwd`, authority boundary, and output. Never assume the child shares the parent's cwd.
- Give every child a lane-specific, self-contained task. Parallel prompts must differ in source seam, evidence, scope, and decision—not only issue number or file glob. Launch fanout as one async `workflowScript` with stable keys and aggregate output.
- Prefer fresh-context review and validation, then synthesize in the parent. Preserve tool restrictions, capability ceilings, and allowed-agent limits.
- Use background execution when useful and event-driven waiting rather than polling. Escalate product, architecture, authority, release, merge, and safety decisions to the parent.
- Treat receipts, CI, review bots, and external-run records as evidence, never authority to merge, close, publish, or release.
- As a conservative orchestration policy, do not pass `turnBudget`, a hard `toolBudget`, or a tight `usageBudget` to mutation-capable workers. The default tool budget blocks read/search tools rather than mutation tools. If interrupted, checkpoint after the current tool returns with changed files, build/test state, and commit or PR state.

## Async and Context Semantics

- Outer `subagent({ async:true, workflowScript })` backgrounds the workflow; children without explicit `async:true` remain awaited and return completed output.
- Awaited children inherit an existing workflow absolute deadline and otherwise receive no invented standalone 30-minute default. Explicit limits may only shorten the deadline.
- Explicit child `async:true` detaches it, does not inherit the workflow deadline, and returns a launch receipt. Supervise it with status or `subagent_wait`.
- Fresh context excludes parent transcript. Fork copies the persisted parent history and may overflow before the first request; later compaction cannot repair that initial snapshot. Use fresh context plus a compact handoff for large parents or oversized children.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_FOREGROUND_TIMEOUT_MS,
	prepareWorkflowLaunchParams,
	resolveWorkflowChildDeadline,
	resolveWorkflowChildExecution,
} from "../../src/runs/foreground/subagent-executor.ts";

describe("workflow launch params", () => {
	it("keeps omitted workflow child async foreground", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ agent: "worker", task: "Run" },
				"workflow-run",
				"run",
			),
			{
				agent: "worker",
				task: "Run",
				async: false,
				workflowParentRunId: "workflow-run",
				workflowKey: "run",
			},
		);
	});

	it("carries the parent deadline into every child launch", () => {
		assert.equal(
			prepareWorkflowLaunchParams(
				{ workflowParentDeadlineAt: 123_456 },
				{ agent: "worker", task: "Run", workflowParentDeadlineAt: 999_999 },
				"workflow-run",
				"run",
			).workflowParentDeadlineAt,
			123_456,
		);
	});

	it("does not inherit a workflow deadline for explicit detached children", () => {
		const launch = prepareWorkflowLaunchParams(
			{ workflowParentDeadlineAt: 123_456 },
			{ agent: "worker", task: "Run", async: true, workflowParentDeadlineAt: 999_999 },
			"workflow-run",
			"run",
		);
		assert.equal(launch.async, true);
		assert.equal(launch.workflowParentDeadlineAt, undefined);
	});

	it("preserves detached mode and omits a workflow deadline for retained resumes", () => {
		const launch = prepareWorkflowLaunchParams(
			{ workflowParentDeadlineAt: 123_456 },
			{ resume: "retained-run", task: "Continue", async: true },
			"workflow-run",
			"resume",
		);
		assert.equal(launch.async, true);
		assert.equal(launch.workflowParentDeadlineAt, undefined);
	});

	it("places workflow child gates inside managed worktree tasks", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{},
				{ agent: "worker", task: "Implement", worktree: true, gate: "npm test" },
				"workflow-run",
				"gated",
			),
			{
				worktree: true,
				async: false,
				workflowParentRunId: "workflow-run",
				workflowKey: "gated",
				tasks: [{
					agent: "worker",
					task: "Implement",
					acceptance: { level: "verified", verify: [{ id: "gate", command: "npm test" }] },
				}],
			},
		);
	});

	it("rejects gate defaults on retained resume items", () => {
		assert.throws(
			() => prepareWorkflowLaunchParams(
				{ gate: "npm test" },
				{ resume: "retained-run", task: "Continue" },
				"workflow-run",
				"continue",
			),
			/gate is not supported with retained resume/,
		);
		assert.throws(
			() => prepareWorkflowLaunchParams(
				{},
				{ resume: "retained-run", task: "Continue", gate: "npm test" },
				"workflow-run",
				"continue",
			),
			/gate is not supported with retained resume/,
		);
	});

	it("inherits one absolute parent deadline without inventing a default", () => {
		const now = 1_000;
		assert.deepEqual(resolveWorkflowChildDeadline({ workflowParentDeadlineAt: 1_120 }, undefined, now), { timeoutMs: 120, deadlineAt: 1_120 });
		assert.deepEqual(resolveWorkflowChildDeadline({}, undefined, now), {});
		assert.deepEqual(resolveWorkflowChildDeadline({ workflowParentDeadlineAt: 1_120 }, 10_000, now), { timeoutMs: 120, deadlineAt: 1_120 });
		assert.deepEqual(resolveWorkflowChildDeadline({ workflowParentDeadlineAt: 1_120 }, 50, now), { timeoutMs: 50, deadlineAt: 1_050 });
	});

	it("observes effective timeout/deadline at the executor boundary for every workflow launch shape", () => {
		const now = 1_000;
		const parentDefaults = { workflowParentDeadlineAt: 1_120 };
		const prepare = (childParams: Record<string, unknown>, key: string) => prepareWorkflowLaunchParams(parentDefaults, childParams, "workflow-run", key);
		const effective = (params: Parameters<typeof resolveWorkflowChildExecution>[0]) => resolveWorkflowChildExecution(params, params.async === true, DEFAULT_FOREGROUND_TIMEOUT_MS, now);

		assert.deepEqual(
			resolveWorkflowChildExecution({ agent: "worker", task: "Run", async: false }, false, DEFAULT_FOREGROUND_TIMEOUT_MS, now),
			{ timeoutMs: DEFAULT_FOREGROUND_TIMEOUT_MS },
		);
		assert.deepEqual(
			resolveWorkflowChildExecution(prepareWorkflowLaunchParams({}, { agent: "worker", task: "Await without parent deadline" }, "workflow-run", "no-parent"), false, DEFAULT_FOREGROUND_TIMEOUT_MS, now),
			{},
		);

		const parallel = [prepare({ agent: "worker", task: "One" }, "parallel-one"), prepare({ agent: "worker", task: "Two" }, "parallel-two")];
		assert.deepEqual(parallel.map(effective), [
			{ timeoutMs: 120, deadlineAt: 1_120 },
			{ timeoutMs: 120, deadlineAt: 1_120 },
		]);

		const sequential = [prepare({ agent: "worker", task: "First" }, "sequential-first"), prepare({ agent: "worker", task: "Second" }, "sequential-second")];
		assert.deepEqual(sequential.map(effective), [
			{ timeoutMs: 120, deadlineAt: 1_120 },
			{ timeoutMs: 120, deadlineAt: 1_120 },
		]);

		const resumed = prepare({ resume: "retained-run", task: "Continue" }, "resume");
		assert.deepEqual(effective(resumed), { timeoutMs: 120, deadlineAt: 1_120 });

		const capped = prepare({ agent: "worker", task: "Capped", timeoutMs: 50 }, "capped");
		assert.deepEqual(effective(capped), { timeoutMs: 50, deadlineAt: 1_050 });

		const detached = prepare({ agent: "worker", task: "Detached", async: true }, "detached");
		assert.deepEqual(effective(detached), {});
		const detachedCapped = prepare({ agent: "worker", task: "Detached", async: true, timeoutMs: 50 }, "detached-capped");
		assert.deepEqual(effective(detachedCapped), { timeoutMs: 50 });
	});

	it("preserves execution limits when routing retained resume items", () => {
		assert.deepEqual(
			prepareWorkflowLaunchParams(
				{ turnBudget: { maxTurns: 8 }, toolBudget: { hard: 12, block: ["read"] } },
				{
					resume: " retained-run ",
					task: "Continue carefully",
					maxRuntimeMs: 5_000,
					turnBudget: { maxTurns: 3, graceTurns: 1 },
					toolBudget: { soft: 2, hard: 4, block: "*" },
				},
				"workflow-run",
				"continue",
				{ missionDetached: true },
			),
			{
				action: "resume",
				id: "retained-run",
				message: "Continue carefully",
				workflowParentRunId: "workflow-run",
				workflowKey: "continue",
				mission: false,
				timeoutMs: 5_000,
				turnBudget: { maxTurns: 3, graceTurns: 1 },
				toolBudget: { soft: 2, hard: 4, block: "*" },
			},
		);
	});
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { SubagentState } from "../../src/shared/types.ts";
import { createAsyncJobTracker } from "../../src/runs/background/async-job-tracker.ts";
import { updateActiveRunIndex } from "../../src/runs/background/active-run-index.ts";
import { createActivityPublisher, projectActivitySnapshot } from "../../src/integrations/activity-snapshot.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";

function state(): SubagentState {
	return { baseCwd: ".", currentSessionId: "s", asyncJobs: new Map(), fleetJobs: new Map(), foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear: () => {} } };
}

test("session load retains genuine paused status and stale PID reconciliation without scanning transcripts", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "activity-native-"));
	const s = state();
	const tracker = createAsyncJobTracker({ events: { emit: () => {} } } as never, s, root, { resultsDir: path.join(root, "results"), kill: () => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); }, now: () => 100 });
	try {
		for (const [id, status, mode] of [["paused", "paused", "single"], ["stale", "running", "single"], ["workflow", "paused", "workflow"]] as const) {
			const dir = path.join(root, id);
			fs.mkdirSync(dir);
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ runId: id, sessionId: "s", mode, state: status, pid: 12345, startedAt: 10, lastActivityAt: 15, lastUpdate: 20, ...(mode === "workflow" ? { steps: [] } : { steps: [{ agent: id, status: "running", startedAt: 10, lastActivityAt: 15 }] }) }));
			fs.writeFileSync(path.join(dir, "events.jsonl"), "not an event\n");
			if (status === "running") updateActiveRunIndex(dir, status);
		}
		tracker.restoreActiveJobs(undefined, true);
		const snapshot = projectActivitySnapshot(s, 1000, tracker.activityAvailable());
		assert.equal(snapshot.available, true);
		assert.equal(snapshot.entries.find(e => e.agent === "paused")!.state, "paused");
		assert.equal(snapshot.entries.find(e => e.agent === "paused")!.lastActivityAt, 15);
		assert.equal(snapshot.entries.find(e => e.agent === "stale")!.state, "failed");
		assert.equal(snapshot.pausedWorkflows, 1);
	} finally {
		tracker.resetJobs();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("native read failures publish unavailable rather than all-completed; terminal callbacks publish immediately", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "activity-unavailable-"));
	const s = state();
	const emitter = new EventEmitter();
	const events = { emit: (name: string, data: unknown) => { emitter.emit(name, data); }, on: (name: string, fn: (data: unknown) => void) => { emitter.on(name, fn); return () => { emitter.off(name, fn); }; } };
	let publisher: ReturnType<typeof createActivityPublisher> | undefined;
	const tracker = createAsyncJobTracker({ events } as never, s, root, { resultsDir: path.join(root, "results"), onActivityChange: () => publisher?.publish() });
	publisher = createActivityPublisher({ events, state: s, available: tracker.activityAvailable });
	let latest: ReturnType<typeof projectActivitySnapshot> | undefined;
	emitter.on("subagent:activity-snapshot", snapshot => { latest = snapshot; });
	publisher.start({ hasUI: false } as never);
	try {
		const runDir = path.join(root, "a");
		fs.mkdirSync(runDir);
		tracker.handleStarted({ id: "a", sessionId: "s", asyncDir: runDir, agent: "worker" });
		assert.equal(latest!.entries[0]!.state, "pending");
		tracker.handleComplete({ id: "a", sessionId: "s", state: "stopped" });
		assert.equal(latest!.entries[0]!.state, "stopped");
		const badRoot = path.join(root, "bad");
		fs.writeFileSync(badRoot, "not a directory");
		const bad = createAsyncJobTracker({ events } as never, s, badRoot);
		try {
			bad.restoreActiveJobs(undefined, true);
			assert.equal(bad.activityAvailable(), false);
			assert.equal(projectActivitySnapshot(s, 100, bad.activityAvailable()).available, false);
		} finally { bad.resetJobs(); }
	} finally {
		publisher.dispose();
		tracker.resetJobs();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("reload retains current-session paused agents/workflows independently of foreign and terminal histories", async t => {
	for (const foreign of [true, false]) await t.test(foreign ? "newer foreign histories" : "newer same-session completions", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "activity-paused-history-"));
		const s = state();
		const tracker = createAsyncJobTracker({ events: { emit: () => {} } } as never, s, root);
		const write = (id: string, sessionId: string, state: string, mode: string, time: number) => {
			const dir = path.join(root, id);
			fs.mkdirSync(dir);
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ runId: id, sessionId, state, mode, startedAt: time, lastUpdate: time, steps: mode === "workflow" ? [] : [{ agent: id, status: state, startedAt: time }] }));
			fs.utimesSync(path.join(dir, "status.json"), time, time);
		};
		try {
			write("paused-agent", "s", "paused", "single", 1);
			write("paused-workflow", "s", "paused", "workflow", 2);
			write("local-completed", "s", "complete", "single", 3);
			for (let i = 0; i < 25; i++) write(`history-${i}`, foreign ? "foreign" : "s", "complete", "single", 10 + i);
			tracker.restoreActiveJobs(undefined, true);
			let snapshot = projectActivitySnapshot(s, 100000);
			assert.equal(snapshot.entries.find(e => e.agent === "paused-agent")?.state, "paused");
			assert.equal(snapshot.pausedWorkflows, 1);
			assert.equal(snapshot.entries.filter(e => e.state === "completed").length, foreign ? 1 : 20);
			assert.equal([...s.fleetJobs!.values()].filter(j => j.status === "complete").length, foreign ? 1 : 20);
			assert.ok([...s.fleetJobs!.values()].every(j => j.sessionId === "s"));
			for (let i = 0; i < 25; i++) {
				const id = `later-${i}`;
				tracker.handleStarted({ id, sessionId: "s", agent: id });
				tracker.handleComplete({ id, sessionId: "s", state: "complete" });
			}
			for (const timer of s.cleanupTimers.values()) clearTimeout(timer);
			s.asyncJobs.clear();
			snapshot = projectActivitySnapshot(s, 100001);
			assert.equal(snapshot.entries.find(e => e.agent === "paused-agent")?.state, "paused", "runtime terminal retention also preserves paused history");
			assert.equal(snapshot.pausedWorkflows, 1);
		} finally { tracker.resetJobs(); fs.rmSync(root, { recursive: true, force: true }); }
	});
});

test("reload tracks terminal roots with live detached descendants until nested completion", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "activity-detached-reload-"));
	const s = state();
	const id = path.basename(root);
	const route = createNestedRoute(id);
	const runDir = path.join(root, id);
	fs.mkdirSync(runDir);
	fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({ runId: id, sessionId: "s", mode: "single", state: "complete", startedAt: 1, endedAt: 2, steps: [{ agent: "root-agent", status: "complete" }] }));
	const child = { id: "detached-child", parentRunId: id, parentStepIndex: 0, depth: 1, path: [{ runId: id, stepIndex: 0 }], mode: "single" as const, state: "running" as const, agent: "detached-worker", startedAt: 3, lastActivityAt: 4 };
	writeNestedEvent(route, { type: "subagent.nested.started", ts: 3, parentRunId: id, parentStepIndex: 0, child });
	// Even a root older than the terminal-history window must keep its live child.
	for (let i = 0; i < 25; i++) {
		const dir = path.join(root, `newer-completed-${i}`);
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ runId: `newer-completed-${i}`, sessionId: "s", state: "complete", mode: "single", startedAt: 10 + i, lastUpdate: 10 + i, steps: [{ agent: `done-${i}`, status: "complete" }] }));
	}
	const tracker = createAsyncJobTracker({ events: { emit: () => {} } } as never, s, root, { pollIntervalMs: 60000, completionRetentionMs: 30 });
	try {
		tracker.restoreActiveJobs(undefined, true);
		assert.equal(projectActivitySnapshot(s, 10).entries.find(e => e.agent === "detached-worker")?.state, "running");
		assert.ok(s.asyncJobs.has(id), "terminal root with a live child must remain watched");
		assert.ok(s.poller);
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.ok(s.asyncJobs.has(id), "root must outlive normal completion retention");
		assert.ok(s.fleetJobs!.has(id), "live descendant root is not evicted by 25 newer terminal roots");
		writeNestedEvent(route, { type: "subagent.nested.updated", ts: 4, parentRunId: id, parentStepIndex: 0, child: { ...child, currentTool: "read", lastActivityAt: 5 } });
		const wait = async (check: () => boolean) => {
			const until = Date.now() + 2000;
			while (!check()) { assert.ok(Date.now() < until, "nested event watcher did not refresh"); await new Promise(resolve => setTimeout(resolve, 10)); }
		};
		await wait(() => projectActivitySnapshot(s, 20).entries.some(e => e.agent === "detached-worker" && e.currentTool === "read"));
		writeNestedEvent(route, { type: "subagent.nested.completed", ts: 5, parentRunId: id, parentStepIndex: 0, child: { ...child, state: "complete", endedAt: 6 } });
		await wait(() => s.asyncJobs.get(id)?.nestedChildren?.[0]?.state === "complete" || !s.asyncJobs.has(id));
		await wait(() => !s.asyncJobs.has(id));
		assert.ok(projectActivitySnapshot(s, 40).entries.every(e => e.state === "completed"), "completed descendant no longer keeps background work active");
	} finally { tracker.resetJobs(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true }); }
});

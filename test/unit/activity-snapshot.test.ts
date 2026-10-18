import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "../../src/shared/types.ts";
import { projectActivitySnapshot, createActivityPublisher } from "../../src/integrations/activity-snapshot.ts";
import type { ActivitySnapshot } from '../../src/integrations/activity-snapshot.ts';

function state(): SubagentState {
	return { baseCwd: ".", currentSessionId: "s", asyncJobs: new Map(), fleetJobs: new Map(), foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear: () => {} } };
}

test("native concrete children are session scoped, stable, and workflow containers are not counted", () => {
	const s = state();
	s.asyncJobs.set("workflow", { asyncId: "workflow", asyncDir: ".", sessionId: "s", mode: "workflow", status: "running", startedAt: 10 });
	s.asyncJobs.set("async", { asyncId: "async", asyncDir: ".", sessionId: "s", mode: "parallel", status: "running", startedAt: 12, steps: [{ agent: "a", status: "running", index: 0, lastActivityAt: 15 }, { agent: "b", status: "pending", index: 1 }] });
	s.foregroundControls.set("fg", { runId: "fg", sessionId: "s", parentWorkflowRunId: "workflow", mode: "single", startedAt: 11, updatedAt: 99, activeChildren: new Map([[0, { index: 0, agent: "c", startedAt: 11, updatedAt: 99, lastActivityAt: 20 }]]) });
	s.fleetJobs!.set("async", s.asyncJobs.get("async")!);
	s.asyncJobs.set("foreign", { asyncId: "foreign", asyncDir: ".", sessionId: "other", status: "running", agents: ["foreign"] });
	const first = projectActivitySnapshot(s, 100);
	assert.deepEqual(first.entries.map(e => e.agent).sort(), ["a", "b", "c"]);
	assert.equal(first.pendingWorkflows, 0);
	assert.equal(first.entries.find(e => e.agent === "b")!.lastActivityAt, undefined);
	assert.deepEqual(projectActivitySnapshot(s, 200).entries, first.entries);
	s.foregroundControls.clear();
	assert.equal(projectActivitySnapshot(s, 300).pendingWorkflows, 1);
	s.asyncJobs.get("workflow")!.status = "paused";
	assert.equal(projectActivitySnapshot(s, 400).pausedWorkflows, 1);
});

test("terminal lifecycle overrides stale running steps, paused remains attention, and history is bounded", () => {
	const s = state();
	for (let i = 0; i < 30; i++) s.fleetJobs!.set(`${i}`, { asyncId: `${i}`, asyncDir: ".", sessionId: "s", mode: "single", status: "complete", startedAt: i, endedAt: i + 1, steps: [{ agent: `done${i}`, status: "running" }] });
	s.fleetJobs!.set("paused", { asyncId: "paused", asyncDir: ".", sessionId: "s", mode: "single", status: "paused", startedAt: 1, steps: [{ agent: "paused", status: "running" }] });
	const snapshot = projectActivitySnapshot(s, 100);
	assert.equal(snapshot.entries.filter(e => e.state === "completed").length, 20);
	assert.equal(snapshot.entries.find(e => e.agent === "paused")!.state, "paused");
	assert.equal(snapshot.entries.find(e => e.agent === "done29")!.endedAt, 30);
	assert.equal(projectActivitySnapshot(s, 101, false).available, false);
});

test("publisher handles requests, heartbeat, footer, session switching and disposal", t => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const s = state();
	const emitter = new EventEmitter();
	const events = { emit: (name: string, data: unknown) => { emitter.emit(name, data); }, on: (name: string, fn: (data: unknown) => void) => { emitter.on(name, fn); return () => { emitter.off(name, fn); }; } };
	const received: ReturnType<typeof projectActivitySnapshot>[] = [];
	emitter.on("subagent:activity-snapshot", data => received.push(data));
	const statuses: (string | undefined)[] = [];
	const ctx = { hasUI: true, ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text) } } as unknown as ExtensionContext;
	const publisher = createActivityPublisher({ events, state: s });
	publisher.start(ctx);
	assert.equal(received.length, 1);
	events.emit("subagent:activity-request", { sessionId: "foreign" });
	assert.equal(received.length, 1);
	s.asyncJobs.set("a", { asyncId: "a", asyncDir: ".", sessionId: "s", status: "running", agents: ["a"], startedAt: 1 });
	t.mock.timers.tick(1000);
	assert.match(statuses.at(-1)!, /1 running/);
	events.emit("subagent:activity-request", { sessionId: "s" });
	assert.equal(received.at(-1)!.entries.length, 1);
	s.currentSessionId = "new";
	publisher.start(ctx);
	assert.equal(received.at(-1)!.entries.length, 0);
	assert.equal(received.at(-1)!.sessionId, "new");
	publisher.dispose();
	assert.equal(received.at(-1)!.available, false);
	assert.equal(statuses.at(-1), undefined);
	const count = received.length;
	t.mock.timers.tick(5000);
	events.emit("subagent:activity-request", {});
	assert.equal(received.length, count);
});

test("nested agents deduplicate by native run/step identity and never count workflow shells", () => {
	const s = state();
	const nested = { id: "nested", parentRunId: "workflow", depth: 1, path: [], mode: "single" as const, state: "running" as const, agent: "nested-agent", startedAt: 10, lastActivityAt: 12 };
	s.asyncJobs.set("workflow", { asyncId: "workflow", asyncDir: ".", sessionId: "s", mode: "workflow", status: "running", nestedChildren: [nested] });
	s.asyncJobs.set("nested", { asyncId: "nested", asyncDir: ".", sessionId: "s", mode: "single", status: "running", agents: ["nested-agent"], startedAt: 10, lastActivityAt: 12, parentWorkflowRunId: "workflow" });
	const snapshot = projectActivitySnapshot(s, 1000);
	assert.equal(snapshot.entries.length, 1);
	assert.equal(snapshot.entries[0]!.id, "nested:0");
	assert.equal(snapshot.entries[0]!.lastActivityAt, 12);
	assert.equal(snapshot.pendingWorkflows, 0);
	s.asyncJobs.get("nested")!.status = "complete";
	s.asyncJobs.get("workflow")!.nestedChildren = [{ ...nested, state: "complete" }];
	assert.equal(projectActivitySnapshot(s, 2000).pendingWorkflows, 1, "finished children do not hide a still-active workflow");
});

test("footer ages real child activity and keeps missing timestamps unknown across heartbeats", t => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 10000 });
	const s = state();
	const emitter = new EventEmitter();
	const events = { emit: (name: string, data: unknown) => { emitter.emit(name, data); }, on: (name: string, fn: (data: unknown) => void) => { emitter.on(name, fn); return () => { emitter.off(name, fn); }; } };
	const statuses: (string | undefined)[] = [];
	const ctx = { hasUI: true, ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text) } } as unknown as ExtensionContext;
	s.asyncJobs.set("a", { asyncId: "a", asyncDir: ".", sessionId: "s", status: "running", agents: ["a"], startedAt: 1, lastActivityAt: 8000 });
	const publisher = createActivityPublisher({ events, state: s });
	try {
		publisher.start(ctx);
		assert.match(statuses.at(-1)!, /activity.*2\.0s ago/);
		s.fleetJobs!.set("done", { asyncId: "done", asyncDir: ".", sessionId: "s", status: "complete", agents: ["done"], startedAt: 1, lastActivityAt: 10000 });
		s.asyncJobs.set("unknown", { asyncId: "unknown", asyncDir: ".", sessionId: "s", status: "running", agents: ["unknown"] });
		publisher.publish();
		assert.match(statuses.at(-1)!, /activity latest 2\.0s ago.*1 activity unknown/);
		s.asyncJobs.delete("unknown");
		t.mock.timers.tick(1000);
		assert.match(statuses.at(-1)!, /activity.*3\.0s ago/);
		assert.equal(s.asyncJobs.get("a")!.lastActivityAt, 8000);
		s.asyncJobs.get("a")!.lastActivityAt = undefined;
		publisher.publish();
		assert.match(statuses.at(-1)!, /activity unknown/);
		t.mock.timers.tick(2000);
		assert.match(statuses.at(-1)!, /activity unknown/);
		assert.doesNotMatch(statuses.at(-1)!, /0s ago/);
	} finally { publisher.dispose(); }
});

test("identifiable paused children represent paused workflows without double counting", () => {
	const s = state();
	const workflow = { asyncId: "workflow", asyncDir: ".", sessionId: "s", mode: "workflow" as const, status: "paused" as const };
	s.asyncJobs.set("workflow", { ...workflow, nestedChildren: [{ id: "child", parentRunId: "workflow", depth: 1, path: [], agent: "worker", mode: "single", state: "paused" }] });
	let snapshot = projectActivitySnapshot(s, 100);
	assert.equal(snapshot.entries.filter(e => e.state === "paused").length, 1);
	assert.equal(snapshot.pausedWorkflows, 0);
	s.asyncJobs.set("workflow", workflow);
	s.asyncJobs.set("child", { asyncId: "child", asyncDir: ".", sessionId: "s", mode: "single", status: "paused", parentWorkflowRunId: "workflow", steps: [{ agent: "worker", status: "running" }] });
	snapshot = projectActivitySnapshot(s, 200);
	assert.equal(snapshot.entries.filter(e => e.state === "paused").length, 1);
	assert.equal(snapshot.pausedWorkflows, 0);
	s.asyncJobs.delete("child");
	assert.equal(projectActivitySnapshot(s, 300).pausedWorkflows, 1);
});

test('Pilo projection uses the header UUID without changing native file ownership, and rejects switched contexts',()=>{
 const previous=process.env.PILO_RPC_UI;process.env.PILO_RPC_UI='1';const s=state();s.currentSessionId='/parent.jsonl';s.asyncJobs.set('job',{asyncId:'job',asyncDir:'.',sessionId:'/parent.jsonl',mode:'single',status:'running',agents:['worker'],startedAt:1});let file='/parent.jsonl';let id='header-uuid';const widgets:string[][]=[];const emitter=new EventEmitter();const native:ActivitySnapshot[]=[];emitter.on('subagent:activity-snapshot',v=>native.push(v));const events={emit:(name:string,v:unknown)=>emitter.emit(name,v),on:(name:string,fn:(v:unknown)=>void)=>{emitter.on(name,fn);return()=>emitter.off(name,fn);}} as any;const ctx={mode:'rpc',hasUI:false,sessionManager:{getSessionId:()=>id,getSessionFile:()=>file},ui:{setWidget:(_key:string,lines:string[])=>widgets.push(lines)}} as unknown as ExtensionContext;const publisher=createActivityPublisher({events,state:s});try{publisher.start(ctx);assert.equal(JSON.parse(widgets[0][0]).sessionId,'header-uuid');assert.equal(native[0].sessionId,'/parent.jsonl');file='/other.jsonl';id='other-uuid';publisher.publish();assert.equal(widgets.length,1);}finally{publisher.dispose();if(previous===undefined)delete process.env.PILO_RPC_UI;else process.env.PILO_RPC_UI=previous;}
});

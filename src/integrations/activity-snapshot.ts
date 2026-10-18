import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AsyncJobStep, NestedRunSummary, SubagentState } from "../shared/types.ts";
import { formatDuration } from "../shared/formatters.ts";
import { createPiloActivityWriter } from "./pilo-activity.ts";

export interface ActivityEntry {
	id: string;
	agent: string;
	state: "running" | "pending" | "completed" | "failed" | "paused" | "stopped";
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	lastActivityAt?: number;
	currentTool?: string;
	toolCount?: number;
	turns?: number;
	tokens?: number;
	description?: string;
	model?: string;
}

export interface ActivitySnapshot {
	version: 1;
	sessionId: string;
	observedAt: number;
	available: boolean;
	entries: ActivityEntry[];
	pendingWorkflows?: number;
	pausedWorkflows?: number;
}

function activityState(value: string): ActivityEntry["state"] {
	if (value === "queued" || value === "pending") return "pending";
	if (value === "complete" || value === "completed") return "completed";
	if (value === "detached") return "paused";
	if (value === "running" || value === "paused" || value === "stopped") return value;
	return "failed";
}

function activityFields(value: { lastActivityAt?: number; currentTool?: string; toolCount?: number; turnCount?: number; description?: string; model?: string }) {
	return {
		...(value.lastActivityAt !== undefined ? { lastActivityAt: value.lastActivityAt } : {}),
		...(value.description ? {description:value.description.slice(0,180)}:{}),
		...(value.model ? {model:value.model}:{}),
		...(value.currentTool ? { currentTool: value.currentTool } : {}),
		...(value.toolCount !== undefined ? { toolCount: value.toolCount } : {}),
		...(value.turnCount !== undefined ? { turns: value.turnCount } : {}),
	};
}

// This projection only reads already-loaded native state; reconciliation remains with the tracker.
export function projectActivitySnapshot(state: SubagentState, observedAt: number, available = true): ActivitySnapshot {
	const entries = new Map<string, ActivityEntry>();
	const representedWorkflows = new Set<string>();
	const workflows = new Map<string, string>();
	const addNested = (children: NestedRunSummary[] | undefined): void => {
		for (const child of children ?? []) {
			if (child.mode === "workflow") {
				workflows.set(child.id, child.state);
			} else if (child.steps?.length) {
				for (const [index, step] of child.steps.entries()) {
					const id = `${child.id}:${index}`;
					const terminal = child.state !== "running" && child.state !== "queued";
					const status = terminal && (step.status === "running" || step.status === "pending") ? child.state : step.status;
					if (!entries.has(id)) entries.set(id, {
						id, agent: step.agent, state: activityState(status), startedAt: step.startedAt ?? child.startedAt ?? 0,
						...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}), ...activityFields(step),
					});
					addNested(step.children);
				}
			} else if (child.agent || child.agents?.length === 1) {
				const id = `${child.id}:0`;
				if (!entries.has(id)) entries.set(id, { id, agent: child.agent ?? child.agents![0]!, state: activityState(child.state), startedAt: child.startedAt ?? 0, ...(child.endedAt !== undefined ? { endedAt: child.endedAt } : {}), ...activityFields(child) });
			}
			if (child.parentRunId && (child.agent || child.agents?.length === 1 || child.steps?.length) && (child.state === "running" || child.state === "queued" || child.state === "paused") && child.mode !== "workflow") representedWorkflows.add(child.parentRunId);
			addNested(child.children);
		}
	};
	for (const control of state.foregroundControls.values()) {
		if (control.sessionId !== state.currentSessionId) continue;
		const children = control.activeChildren ? [...control.activeChildren.values()] : control.currentAgent ? [{ ...control, agent: control.currentAgent, index: control.currentIndex ?? 0 }] : [];
		for (const child of children) {
			const id = `${control.runId}:${child.index}`;
			entries.set(id, { id, agent: child.agent, state: "running", startedAt: child.startedAt, ...activityFields(child), ...(child.tokens !== undefined ? { tokens: child.tokens } : {}) });
		}
		if (children.length && control.parentWorkflowRunId) representedWorkflows.add(control.parentWorkflowRunId);
		addNested(control.nestedChildren);
	}
	const jobs = new Map([...(state.fleetJobs ?? []), ...state.asyncJobs]);
	for (const job of jobs.values()) {
		if (job.sessionId !== state.currentSessionId) continue;
		if (job.mode === "workflow") {
			workflows.set(job.asyncId, job.status);
			addNested(job.nestedChildren);
			continue;
		}
		const steps: AsyncJobStep[] | undefined = job.steps?.length ? job.steps : job.agents?.map((agent, index) => ({ agent, index, status: job.status === "queued" || (job.mode === "chain" && index !== (job.currentStep ?? 0)) ? "pending" : job.status }));
		for (const [offset, step] of (steps ?? []).entries()) {
			const id = `${job.asyncId}:${step.index ?? offset}`;
			const terminal = job.status !== "running" && job.status !== "queued";
			const status = terminal && (step.status === "running" || step.status === "pending") ? job.status : step.status;
			entries.set(id, {
				id, agent: step.agent, state: activityState(status), startedAt: step.startedAt ?? job.startedAt ?? 0,
				...((step.endedAt ?? job.endedAt) !== undefined ? { endedAt: step.endedAt ?? job.endedAt } : {}),
				...activityFields(steps?.length === 1 ? { ...job, ...step } : step),
				...(step.tokens ? { tokens: step.tokens.total } : {}),
			});
			addNested(step.children);
		}
		if (steps?.some(step => step.status === "running" || step.status === "pending" || step.status === "paused") && (job.status === "running" || job.status === "queued" || job.status === "paused") && job.parentWorkflowRunId) representedWorkflows.add(job.parentWorkflowRunId);
		addNested(job.nestedChildren);
	}
	for (const run of state.foregroundRuns?.values() ?? []) {
		if (run.sessionId !== state.currentSessionId) continue;
		for (const child of run.children) {
			const id = `${run.runId}:${child.index}`;
			if (entries.has(id)) continue;
			// Legacy foreground history has no start timestamp; zero means unknown, not a heartbeat.
			entries.set(id, { id, agent: child.agent, state: activityState(child.status), startedAt: 0, ...(child.durationMs !== undefined ? { durationMs: child.durationMs } : {}), ...activityFields(child), ...(child.tokens !== undefined ? { tokens: child.tokens } : {}) });
		}
	}
	const all = [...entries.values()];
	const active = all.filter(e => e.state === "running" || e.state === "pending" || e.state === "paused");
	const recent = all.filter(e => e.state === "completed" || e.state === "failed" || e.state === "stopped").sort((a, b) => (b.endedAt ?? b.lastActivityAt ?? b.startedAt) - (a.endedAt ?? a.lastActivityAt ?? a.startedAt)).slice(0, 20);
	const unrepresented = [...workflows].filter(([id]) => !representedWorkflows.has(id));
	return { version: 1, sessionId: state.currentSessionId ?? "", observedAt, available, entries: [...active, ...recent].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)), pendingWorkflows: unrepresented.filter(([, status]) => status === "running" || status === "queued").length, pausedWorkflows: unrepresented.filter(([, status]) => status === "paused").length };
}

function summary(snapshot: ActivitySnapshot): string | undefined {
	if (!snapshot.available) return "Subagents: unavailable";
	const parts: string[] = [];
	for (const state of ["running", "pending", "paused", "failed", "stopped", "completed"] as const) {
		const count = snapshot.entries.filter(e => e.state === state).length;
		if (count) parts.push(`${count} ${state}`);
	}
	if (snapshot.pendingWorkflows) parts.push(`${snapshot.pendingWorkflows} workflow waiting`);
	if (snapshot.pausedWorkflows) parts.push(`${snapshot.pausedWorkflows} workflow paused`);
	if (!parts.length) return undefined;
	const active = snapshot.entries.filter(e => e.state === "running" || e.state === "pending" || e.state === "paused");
	const activity = active.length || snapshot.pendingWorkflows || snapshot.pausedWorkflows ? active : snapshot.entries;
	const timestamps = activity.map(e => e.lastActivityAt).filter((value): value is number => value !== undefined && Number.isFinite(value));
	// Observation time ages a real timestamp; it is never evidence of child activity.
	parts.push(timestamps.length ? `activity latest ${formatDuration(Math.max(0, snapshot.observedAt - Math.max(...timestamps)))} ago` : "activity unknown");
	const unknown = activity.length - timestamps.length;
	if (timestamps.length && unknown) parts.push(`${unknown} activity unknown`);
	return `Subagents: ${parts.join(" · ")}`;
}

export function createActivityPublisher(options: { events: ExtensionAPI["events"]; state: SubagentState; available?: () => boolean }) {
	let ctx: ExtensionContext | undefined;
	const writeSnapshot=createPiloActivityWriter();
 const deliver=(snapshot:ActivitySnapshot)=>{
  options.events.emit('subagent:activity-snapshot',snapshot);
  if(!ctx)return;
  // Native run ownership uses sessionFile; Pilo indexes the Pi header UUID.
  // Keep the internal event contract unchanged and normalize only at this boundary.
  const sessionId=ctx.sessionManager?.getSessionId?.();
  if(!sessionId)return;
  if(snapshot.sessionId!==ctx.sessionManager?.getSessionFile?.()&&snapshot.sessionId!==sessionId)return;
  const projection={...snapshot,sessionId};
  writeSnapshot(projection,ctx);
  if(ctx.mode==='rpc'&&process.env.PILO_RPC_UI==='1'){
   try{ctx.ui.setWidget('pilo-subagents',[JSON.stringify(projection)]);}catch{/* RPC may close during reload. */}
  }
 };
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastStatus: string | undefined;
	const publish = () => {
		if (!ctx || !options.state.currentSessionId) return;
		const snapshot = projectActivitySnapshot(options.state, Date.now(), options.available?.() ?? true);
		deliver(snapshot);
		const text = summary(snapshot);
		if (ctx.hasUI && text !== lastStatus) {
			try { ctx.ui.setStatus("subagent-activity", text); } catch { /* A stale UI context must not stop event delivery. */ }
			lastStatus = text;
		}
	};
	const unsubscribe = options.events.on("subagent:activity-request", (payload: unknown) => {
		const requested = (payload as { sessionId?: string } | undefined)?.sessionId;
		if (requested !== undefined && requested !== options.state.currentSessionId) return;
		publish();
	});
	return {
		publish,
		start(context: ExtensionContext) {
			if (timer) clearInterval(timer);
			ctx = context;
			lastStatus = undefined;
			if (ctx.hasUI) { try { ctx.ui.setStatus("subagent-activity", undefined); } catch { /* Context may already be stale. */ } }
			publish();
			timer = setInterval(publish, 1000);
			timer.unref?.();
		},
		dispose() {
			if (timer) clearInterval(timer);
			timer = undefined;
			if (ctx && options.state.currentSessionId) deliver(projectActivitySnapshot(options.state, Date.now(), false));
			if (ctx?.hasUI) { try { ctx.ui.setStatus("subagent-activity", undefined); } catch { /* Context may already be stale on reload. */ } }
			ctx = undefined;
			unsubscribe();
		},
	};
}

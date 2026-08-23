import * as fs from "node:fs";
import * as path from "node:path";

export const CURSOR_ACTIVITY_LOG_ENV = "PI_CURSOR_ACTIVITY_LOG";
export const CURSOR_ACTIVITY_LOG_FILENAME = "cursor-activity.jsonl";

export type CursorActivityEventType = "cursor.tool.started" | "cursor.tool.completed";

export interface CursorActivityRecord {
	version: 1;
	type: CursorActivityEventType;
	ts: string;
	tool: string;
	title: string;
	summary: string;
	mutates: boolean;
	identity?: string;
}

export function cursorActivityLogPathForSessionFile(sessionFile: string): string {
	return path.join(path.dirname(sessionFile), CURSOR_ACTIVITY_LOG_FILENAME);
}

export function cursorActivityLogPathForAsyncStep(asyncDir: string, index: number): string {
	return path.join(asyncDir, `cursor-activity-${index}.jsonl`);
}

export function resolveChildCursorActivityLogPath(input: {
	sessionFile?: string;
	fallbackDir: string;
	index: number;
}): string {
	return input.sessionFile
		? cursorActivityLogPathForSessionFile(input.sessionFile)
		: cursorActivityLogPathForAsyncStep(input.fallbackDir, input.index);
}

export function formatCursorActivityOutputLine(record: CursorActivityRecord): string {
	const phase = record.type === "cursor.tool.started" ? "start" : "done";
	return `cursor ${phase} ${record.title}: ${record.summary}`;
}

export function parseCursorActivityLine(line: string): CursorActivityRecord | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	if (record.version !== 1) return undefined;
	if (record.type !== "cursor.tool.started" && record.type !== "cursor.tool.completed") return undefined;
	if (typeof record.tool !== "string" || typeof record.title !== "string" || typeof record.summary !== "string") return undefined;
	if (typeof record.ts !== "string" || typeof record.mutates !== "boolean") return undefined;
	return {
		version: 1,
		type: record.type,
		ts: record.ts,
		tool: record.tool,
		title: record.title,
		summary: record.summary,
		mutates: record.mutates,
		...(typeof record.identity === "string" ? { identity: record.identity } : {}),
	};
}

export function readCursorActivityRecords(logPath: string): CursorActivityRecord[] {
	try {
		const text = fs.readFileSync(logPath, "utf-8");
		return text.split(/\r?\n/).flatMap((line) => {
			const record = parseCursorActivityLine(line);
			return record ? [record] : [];
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return [];
	}
}

export function hasMutatingCursorActivity(logPath: string | undefined): boolean {
	if (!logPath) return false;
	return readCursorActivityRecords(logPath).some((record) => record.type === "cursor.tool.completed" && record.mutates);
}

export function createCursorActivityLogTailer(logPath: string): {
	path: string;
	countedIdentities: Set<string>;
	consume(): CursorActivityRecord[];
} {
	let offset = 0;
	let pending = "";
	const countedIdentities = new Set<string>();
	return {
		path: logPath,
		countedIdentities,
		consume(): CursorActivityRecord[] {
			let fd: number | undefined;
			try {
				fd = fs.openSync(logPath, "r");
				const stat = fs.fstatSync(fd);
				if (stat.size < offset) {
					offset = 0;
					pending = "";
				}
				if (stat.size === offset) return [];
				const length = stat.size - offset;
				const buffer = Buffer.alloc(length);
				fs.readSync(fd, buffer, 0, length, offset);
				offset = stat.size;
				pending += buffer.toString("utf-8");
				const lines = pending.split(/\r?\n/);
				pending = lines.pop() ?? "";
				return lines.flatMap((line) => {
					const record = parseCursorActivityLine(line);
					return record ? [record] : [];
				});
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					// Best-effort observability; a missing or unreadable sidecar is not a run failure.
				}
				return [];
			} finally {
				if (fd !== undefined) fs.closeSync(fd);
			}
		},
	};
}

export function appendCursorActivityOutputLines(outputPath: string, records: CursorActivityRecord[]): void {
	if (records.length === 0) return;
	const text = `${records.map(formatCursorActivityOutputLine).join("\n")}\n`;
	try {
		fs.mkdirSync(path.dirname(outputPath), { recursive: true });
		fs.appendFileSync(outputPath, text);
	} catch {
		// Output-log mirroring is best-effort.
	}
}

export function cursorActivityTimestampMs(record: CursorActivityRecord, fallback = Date.now()): number {
	const parsed = Date.parse(record.ts);
	return Number.isFinite(parsed) ? parsed : fallback;
}

const CURSOR_PROGRESS_TOOL_PREFIX = "cursor:";

function cursorActivityCountKey(record: CursorActivityRecord): string {
	return record.identity ?? `${record.tool}:${record.summary}`;
}

export function applyCursorActivityRecords(input: {
	records: CursorActivityRecord[];
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	lastActivityAt: number;
	now?: number;
	countedIdentities?: Set<string>;
}): {
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	lastActivityAt: number;
	addedToolCount: number;
	changed: boolean;
} {
	if (input.records.length === 0) {
		return {
			recentTools: input.recentTools,
			currentTool: input.currentTool,
			currentToolArgs: input.currentToolArgs,
			currentToolStartedAt: input.currentToolStartedAt,
			lastActivityAt: input.lastActivityAt,
			addedToolCount: 0,
			changed: false,
		};
	}
	const now = input.now ?? Date.now();
	let lastActivityAt = input.lastActivityAt;
	let currentTool = input.currentTool;
	let currentToolArgs = input.currentToolArgs;
	let currentToolStartedAt = input.currentToolStartedAt;
	const recentTools = [...input.recentTools];
	const countedIdentities = input.countedIdentities ?? new Set<string>();
	let addedToolCount = 0;
	const canClaimCurrentTool = !currentTool || currentTool.startsWith(CURSOR_PROGRESS_TOOL_PREFIX);
	for (const record of input.records) {
		const endMs = cursorActivityTimestampMs(record, now);
		lastActivityAt = Math.max(lastActivityAt, endMs);
		const tool = `${CURSOR_PROGRESS_TOOL_PREFIX}${record.tool}`;
		const countKey = cursorActivityCountKey(record);
		if (!countedIdentities.has(countKey)) {
			countedIdentities.add(countKey);
			addedToolCount += 1;
		}
		if (record.type === "cursor.tool.started") {
			if (canClaimCurrentTool || currentTool?.startsWith(CURSOR_PROGRESS_TOOL_PREFIX)) {
				currentTool = tool;
				currentToolArgs = record.summary;
				currentToolStartedAt = endMs;
			}
		} else {
			recentTools.push({ tool, args: record.summary, endMs });
			if (currentTool === tool) {
				currentTool = undefined;
				currentToolArgs = undefined;
				currentToolStartedAt = undefined;
			}
		}
	}
	return {
		recentTools: recentTools.slice(-32),
		currentTool,
		currentToolArgs,
		currentToolStartedAt,
		lastActivityAt,
		addedToolCount,
		changed: true,
	};
}


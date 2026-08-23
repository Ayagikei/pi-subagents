import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	CURSOR_ACTIVITY_LOG_ENV,
	appendCursorActivityOutputLines,
	applyCursorActivityRecords,
	createCursorActivityLogTailer,
	formatCursorActivityOutputLine,
	hasMutatingCursorActivity,
	parseCursorActivityLine,
	resolveChildCursorActivityLogPath,
	type CursorActivityRecord,
} from "../../src/runs/shared/cursor-activity-log.ts";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-activity-"));
	tempRoots.push(dir);
	return dir;
}

function record(overrides: Partial<CursorActivityRecord> & Pick<CursorActivityRecord, "type" | "tool" | "title" | "summary" | "mutates">): CursorActivityRecord {
	return {
		version: 1,
		ts: overrides.ts ?? "2026-08-23T00:00:00.000Z",
		...overrides,
	};
}

describe("cursor activity sidecar", () => {
	it("resolves session sibling vs async-step fallback paths", () => {
		assert.equal(
			resolveChildCursorActivityLogPath({
				sessionFile: "/tmp/session/child.jsonl",
				fallbackDir: "/tmp/async",
				index: 3,
			}),
			path.join("/tmp/session", "cursor-activity.jsonl"),
		);
		assert.equal(
			resolveChildCursorActivityLogPath({
				fallbackDir: "/tmp/async",
				index: 3,
			}),
			path.join("/tmp/async", "cursor-activity-3.jsonl"),
		);
	});

	it("buildPiArgs forwards PI_CURSOR_ACTIVITY_LOG", () => {
		const logPath = path.join(tempDir(), "cursor-activity.jsonl");
		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			cursorActivityLogPath: logPath,
		});
		assert.equal(env[CURSOR_ACTIVITY_LOG_ENV], logPath);
	});

	it("counts each Cursor tool once in toolCount without charging the pi tool budget", () => {
		const dir = tempDir();
		const logPath = path.join(dir, "cursor-activity.jsonl");
		const outputPath = path.join(dir, "output-0.log");
		const started = record({
			type: "cursor.tool.started",
			tool: "edit",
			title: "Cursor edit",
			summary: "src/foo.ts",
			mutates: true,
			identity: "call-1",
		});
		const completed = record({
			type: "cursor.tool.completed",
			tool: "edit",
			title: "Cursor edit",
			summary: "src/foo.ts",
			mutates: true,
			identity: "call-1",
			ts: "2026-08-23T00:00:01.000Z",
		});
		fs.writeFileSync(logPath, `${JSON.stringify(started)}\n`);
		const tailer = createCursorActivityLogTailer(logPath);
		assert.deepEqual(tailer.consume(), [started]);
		assert.deepEqual(tailer.consume(), []);
		fs.appendFileSync(logPath, `${JSON.stringify(completed)}\n`);
		assert.deepEqual(tailer.consume(), [completed]);

		const first = applyCursorActivityRecords({
			records: [started],
			recentTools: [],
			currentTool: "contact_supervisor",
			currentToolArgs: "need a decision",
			currentToolStartedAt: 1,
			lastActivityAt: 0,
			now: Date.parse(started.ts),
			countedIdentities: tailer.countedIdentities,
		});
		assert.equal(first.addedToolCount, 1);
		assert.equal(first.currentTool, "contact_supervisor");
		const second = applyCursorActivityRecords({
			records: [completed],
			recentTools: first.recentTools,
			currentTool: first.currentTool,
			currentToolArgs: first.currentToolArgs,
			currentToolStartedAt: first.currentToolStartedAt,
			lastActivityAt: first.lastActivityAt,
			now: Date.parse(completed.ts),
			countedIdentities: tailer.countedIdentities,
		});
		assert.equal(second.addedToolCount, 0);
		assert.equal(second.currentTool, "contact_supervisor");
		assert.deepEqual(second.recentTools, [{
			tool: "cursor:edit",
			args: "src/foo.ts",
			endMs: Date.parse(completed.ts),
		}]);
		assert.equal(second.lastActivityAt, Date.parse(completed.ts));

		appendCursorActivityOutputLines(outputPath, [completed]);
		assert.equal(fs.readFileSync(outputPath, "utf8"), `${formatCursorActivityOutputLine(completed)}\n`);
		assert.match(fs.readFileSync(outputPath, "utf8"), /^cursor done Cursor edit: src\/foo.ts\n$/);
	});

	it("claims currentTool only when no pi tool is in flight", () => {
		const started = record({
			type: "cursor.tool.started",
			tool: "read",
			title: "Cursor read",
			summary: "README.md",
			mutates: false,
		});
		const applied = applyCursorActivityRecords({
			records: [started],
			recentTools: [],
			lastActivityAt: 0,
			now: Date.parse(started.ts),
		});
		assert.equal(applied.currentTool, "cursor:read");
		assert.equal(applied.currentToolArgs, "README.md");
		assert.equal(applied.addedToolCount, 1);
	});

	it("treats completed mutating sidecar rows as mutation evidence", () => {
		const dir = tempDir();
		const logPath = path.join(dir, "cursor-activity.jsonl");
		fs.writeFileSync(logPath, `${JSON.stringify(record({
			type: "cursor.tool.completed",
			tool: "edit",
			title: "Cursor edit",
			summary: "src/foo.ts",
			mutates: true,
		}))}\n${JSON.stringify(record({
			type: "cursor.tool.started",
			tool: "edit",
			title: "Cursor edit",
			summary: "src/bar.ts",
			mutates: true,
		}))}\n`);
		assert.equal(hasMutatingCursorActivity(logPath), true);
		assert.equal(hasMutatingCursorActivity(path.join(dir, "missing.jsonl")), false);
		assert.equal(parseCursorActivityLine("not-json"), undefined);
	});
});

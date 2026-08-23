import type { Message } from "@earendil-works/pi-ai";
import { isMutatingTool } from "./long-running-guard.ts";
import { expectsImplementationMutation } from "./task-intent.ts";
import { hasMutatingCursorActivity } from "./cursor-activity-log.ts";

export { expectsImplementationMutation };

const READ_ONLY_BUILTIN_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"web_search",
	"fetch_content",
	"get_search_content",
	"intercom",
	"contact_supervisor",
]);

// Cursor native edit/write often land as thinking traces (inactive_trace /
// transcript_trace) rather than toolCall parts when native tool replay is off
// or the tool is inactive in context. Match pi-cursor-sdk display labels.
// Those traces only help when they actually reached the child transcript;
// a hung live-run drain never records them. Cursor-backed children without
// transcript evidence are `unavailable`, not a false "no edits" failure.
// This guard does not inspect the worktree. Completed Cursor edit/write/delete
// rows in the activity sidecar count as attempted mutation evidence.
const CURSOR_FILE_MUTATION_THINKING =
	/(?:^|\n)\s*Cursor (?:edit|write)\s*:/i;

export const CURSOR_MUTATION_UNAVAILABLE_MESSAGE =
	"Cursor native file mutations are not visible in the child transcript. Completion guard cannot verify edits; inspect the worktree.";

export type MutationEvidence = "observed" | "absent" | "unavailable";

interface CompletionMutationGuardInput {
	agent: string;
	task: string;
	messages: Message[];
	tools?: string[];
	mcpDirectTools?: string[];
	model?: string;
	activityLogPath?: string;
}

interface CompletionMutationGuardResult {
	expectedMutation: boolean;
	attemptedMutation: boolean;
	triggered: boolean;
	evidence: MutationEvidence;
}

export function hasMutationToolCapability(tools: string[] | undefined, mcpDirectTools: string[] | undefined): boolean {
	if ((mcpDirectTools?.length ?? 0) > 0) return true;
	if (tools === undefined) return true;
	return !tools.every((tool) => READ_ONLY_BUILTIN_TOOLS.has(tool));
}

export function isCursorBackedModel(model: string | undefined): boolean {
	if (!model) return false;
	const normalized = model.trim().toLowerCase();
	return normalized === "cursor" || normalized.startsWith("cursor/") || normalized.startsWith("cursor-");
}

function messageLooksCursorBacked(message: Message): boolean {
	const record = message as unknown as { model?: unknown; customType?: unknown; provider?: unknown };
	if (record.customType === "cursor-sdk-agent-lineage") return true;
	if (typeof record.provider === "string" && record.provider.trim().toLowerCase() === "cursor") return true;
	return typeof record.model === "string" && isCursorBackedModel(record.model);
}

function hasCursorMutationBlindSpot(input: CompletionMutationGuardInput): boolean {
	if (isCursorBackedModel(input.model)) return true;
	return input.messages.some(messageLooksCursorBacked);
}

function hasCheckpointMutationEvidence(message: Message): boolean {
	const record = message as unknown as {
		role?: string;
		type?: string;
		customType?: unknown;
		data?: unknown;
		details?: unknown;
	};
	if ((record.role !== "custom" && record.type !== "custom") || record.customType !== "pi-checkpoint") return false;
	const details = typeof record.details === "object" && record.details !== null && !Array.isArray(record.details)
		? record.details as Record<string, unknown>
		: undefined;
	const data = typeof record.data === "object" && record.data !== null && !Array.isArray(record.data)
		? record.data as Record<string, unknown>
		: typeof details?.beforeCommit === "string" || typeof details?.afterCommit === "string"
			? details
			: details?.data && typeof details.data === "object" && !Array.isArray(details.data)
				? details.data as Record<string, unknown>
				: undefined;
	return typeof data?.beforeCommit === "string"
		&& typeof data.afterCommit === "string"
		&& data.beforeCommit !== data.afterCommit;
}

export function hasMutationToolCall(messages: Message[]): boolean {
	for (const message of messages) {
		if (hasCheckpointMutationEvidence(message)) return true;
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "thinking" && CURSOR_FILE_MUTATION_THINKING.test(part.thinking)) return true;
			if (part.type !== "toolCall") continue;
			const args = typeof part.arguments === "object" && part.arguments !== null && !Array.isArray(part.arguments)
				? part.arguments as Record<string, unknown>
				: {};
			if (isMutatingTool(part.name, args)) return true;
		}
	}
	return false;
}

export function evaluateCompletionMutationGuard(input: CompletionMutationGuardInput): CompletionMutationGuardResult {
	const expectedMutation = hasMutationToolCapability(input.tools, input.mcpDirectTools)
		? expectsImplementationMutation(input.agent, input.task)
		: false;
	const attemptedMutation = hasMutationToolCall(input.messages) || hasMutatingCursorActivity(input.activityLogPath);
	const unavailable = expectedMutation && !attemptedMutation && hasCursorMutationBlindSpot(input);
	return {
		expectedMutation,
		attemptedMutation,
		triggered: expectedMutation && !attemptedMutation && !unavailable,
		evidence: attemptedMutation ? "observed" : unavailable ? "unavailable" : "absent",
	};
}

export function fileMutationEffectStatus(input: {
	expectedMutation: boolean;
	triggered: boolean;
	evidence: MutationEvidence;
	arbiterRescued?: boolean;
}): "not-applicable" | "observed" | "missing" | "unavailable" {
	if (!input.expectedMutation || input.arbiterRescued) return "not-applicable";
	if (input.triggered) return "missing";
	if (input.evidence === "unavailable") return "unavailable";
	return "observed";
}

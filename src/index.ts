import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { completeSimple } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	convertToLlm,
	estimateTokens as estimateMessageTokens,
	getAgentDir,
	serializeConversation,
} from "@mariozechner/pi-coding-agent";

// ============================================================================
// Config
// ============================================================================

interface Config {
	observationThreshold: number;
	reflectionThreshold: number;
}

const DEFAULTS: Config = {
	observationThreshold: 50_000,
	reflectionThreshold: 30_000,
};

function loadConfig(cwd: string): Config {
	const globalPath = join(getAgentDir(), "observational-memory.json");
	const projectPath = join(cwd, ".pi", "observational-memory.json");

	let globalConfig: Partial<Config> = {};
	let projectConfig: Partial<Config> = {};

	if (existsSync(globalPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalPath, "utf-8"));
		} catch {}
	}

	if (existsSync(projectPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectPath, "utf-8"));
		} catch {}
	}

	return { ...DEFAULTS, ...globalConfig, ...projectConfig };
}

// ============================================================================
// Types
// ============================================================================

interface MemoryState {
	observations: string;
	reflections: string;
}

interface MemoryDetails {
	type: "observational-memory";
	version: 1;
	observations: string;
	reflections: string;
}

// ============================================================================
// Helpers
// ============================================================================

function isMemoryDetails(d: unknown): d is MemoryDetails {
	return !!d && typeof d === "object" && (d as Record<string, unknown>).type === "observational-memory";
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function estimateRawTailTokens(
	entries: Array<{ type: string; message?: unknown; content?: unknown; firstKeptEntryId?: string; id?: string }>,
): number {
	let startIndex = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			const keptId = entries[i].firstKeptEntryId;
			if (keptId) {
				for (let j = 0; j < entries.length; j++) {
					if (entries[j].id === keptId) {
						startIndex = j;
						break;
					}
				}
			} else {
				startIndex = i + 1;
			}
			break;
		}
	}

	let tokens = 0;
	for (let i = startIndex; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type === "message" && entry.message) {
			tokens += estimateMessageTokens(entry.message as Parameters<typeof estimateMessageTokens>[0]);
		} else if (entry.type === "custom_message" && entry.content) {
			const content = entry.content;
			if (typeof content === "string") {
				tokens += Math.ceil(content.length / 4);
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) tokens += Math.ceil(block.text.length / 4);
				}
			}
		}
	}
	return tokens;
}

function extractText(response: { content: Array<{ type: string; text?: string }> }): string {
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

// ============================================================================
// Prompts
// ============================================================================

const OBSERVER_SYSTEM = `You are an observation agent for a coding assistant. Compress conversation messages into concise, timestamped observations.

Format as a date-grouped log:

Date: YYYY-MM-DD
- 🔴 HH:MM Observation text
  - 🔴 HH:MM Sub-observation
  - 🟡 HH:MM Sub-observation
- 🟢 HH:MM Another observation

Priority levels:
- 🔴 Important: user goals, constraints, decisions, names, deadlines, architectural choices, bugs, errors
- 🟡 Maybe important: questions asked, preferences, approaches considered, configuration details
- 🟢 Info only: routine operations, minor details

Rules:
- Group observations by date, with timestamps inline.
- Use the three-date model when relevant: note the observation date, the referenced date (if the event refers to a different day), and a relative date (e.g. "2 days ago").
- Nest related sub-observations under a parent observation.
- Preserve exact file paths, function names, error messages, and technical details.
- Focus on WHAT happened and WHY, not routine tool calls.
- Each observation should be one concise line.
- Do NOT wrap output in code blocks or markdown fences.`;

const REFLECTOR_SYSTEM = `You are a reflection agent for a coding assistant. Garbage-collect observations and distill stable long-term reflections.

You will receive current reflections (long-term facts) and accumulated observations.

Your task:
1. PROMOTE observations to reflections when they represent stable, long-lived facts:
   - User identity, role, preferences
   - Project goals and architecture decisions
   - Permanent constraints and requirements
   - Key technical decisions and their rationale
2. PRUNE observations that are:
   - Completed tasks no longer relevant
   - Routine operations already captured in reflections
   - Outdated or superseded by newer information
   - 🟢 info-only items that have aged out
3. KEEP observations that are still active but not yet stable enough for reflections.

Output EXACTLY two sections with these tags:

<reflections>
[Updated long-term reflections — stable facts, one per line]
</reflections>

<observations>
[Surviving observations in the same date-grouped log format]
</observations>

Do NOT wrap output in code blocks or markdown fences.`;

// ============================================================================
// Extension
// ============================================================================

export default function observationalMemory(pi: ExtensionAPI) {
	let config: Config = { ...DEFAULTS };
	let state: MemoryState = { observations: "", reflections: "" };
	let compactInFlight = false;

	// ---- Restore state from last compaction entry ----

	pi.on("session_start", (_event, ctx) => {
		config = loadConfig(ctx.cwd);
		state = { observations: "", reflections: "" };
		compactInFlight = false;

		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "compaction" && isMemoryDetails(entry.details)) {
				state.observations = entry.details.observations;
				state.reflections = entry.details.reflections;
				break;
			}
		}
	});

	// ---- Trigger compaction when raw tail exceeds threshold ----

	pi.on("agent_end", (_event, ctx) => {
		if (compactInFlight) return;

		const entries = ctx.sessionManager.getBranch();
		const tokens = estimateRawTailTokens(entries);
		if (tokens < config.observationThreshold) return;

		compactInFlight = true;
		setTimeout(() => {
			if (!ctx.isIdle()) {
				compactInFlight = false;
				return;
			}
			ctx.compact({
				onComplete: () => {
					compactInFlight = false;
					if (ctx.hasUI) ctx.ui.notify("Observational memory: compaction complete", "info");
				},
				onError: (error) => {
					compactInFlight = false;
					if (ctx.hasUI) ctx.ui.notify(`Observational memory: ${error.message}`, "error");
				},
			});
		}, 0);
	});

	// ---- Custom compaction: observer + reflector ----

	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, firstKeptEntryId, tokensBefore } = preparation;

		const model = ctx.model;
		if (!model) return;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return;

		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
		if (allMessages.length === 0) return;

		const conversationText = serializeConversation(convertToLlm(allMessages));
		const now = new Date();
		const dateStr = now.toISOString().split("T")[0];
		const timeStr = now.toTimeString().slice(0, 5);

		// ---- Run observer ----

		ctx.ui.notify("Observational memory: running observer...", "info");

		try {
			const observerOptions = model.reasoning
				? { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 4096, signal, reasoning: "high" as const }
				: { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 4096, signal };

			const observerResponse = await completeSimple(
				model,
				{
					systemPrompt: OBSERVER_SYSTEM,
					messages: [
						{
							role: "user" as const,
							content: [
								{
									type: "text" as const,
									text: `Today is ${dateStr}, current time is ${timeStr}.\n\nCompress the following conversation into observations:\n\n<conversation>\n${conversationText}\n</conversation>`,
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				observerOptions,
			);

			const newObservations = extractText(observerResponse);
			if (!newObservations.trim()) return;

			state.observations = state.observations
				? `${state.observations}\n\n${newObservations}`
				: newObservations;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`Observer failed: ${msg}`, "error");
			return;
		}

		// ---- Run reflector if observations are too large ----

		if (estimateTokens(state.observations) > config.reflectionThreshold) {
			ctx.ui.notify("Observational memory: running reflector...", "info");

			try {
				const reflectorOptions = model.reasoning
					? { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 8192, signal, reasoning: "high" as const }
					: { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 8192, signal };

				const reflectorResponse = await completeSimple(
					model,
					{
						systemPrompt: REFLECTOR_SYSTEM,
						messages: [
							{
								role: "user" as const,
								content: [
									{
										type: "text" as const,
										text: `Today is ${dateStr}.\n\n<current-reflections>\n${state.reflections || "(none yet)"}\n</current-reflections>\n\n<current-observations>\n${state.observations}\n</current-observations>\n\nGarbage-collect these observations. Promote long-lived facts to reflections, prune what's no longer needed, keep what's still active.`,
									},
								],
								timestamp: Date.now(),
							},
						],
					},
					reflectorOptions,
				);

				const output = extractText(reflectorResponse);
				const reflectionsMatch = output.match(/<reflections>\n?([\s\S]*?)\n?<\/reflections>/);
				const observationsMatch = output.match(/<observations>\n?([\s\S]*?)\n?<\/observations>/);

				if (reflectionsMatch) state.reflections = reflectionsMatch[1].trim();
				if (observationsMatch) state.observations = observationsMatch[1].trim();
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Reflector failed: ${msg}`, "warning");
			}
		}

		// ---- Build summary ----

		let summary = "";
		if (state.reflections) {
			summary += `<reflections>\n${state.reflections}\n</reflections>\n\n`;
		}
		if (state.observations) {
			summary += `<observations>\n${state.observations}\n</observations>`;
		}

		if (!summary.trim()) return;

		const details: MemoryDetails = {
			type: "observational-memory",
			version: 1,
			observations: state.observations,
			reflections: state.reflections,
		};

		return {
			compaction: {
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
			},
		};
	});

	// ---- /om-status command ----

	pi.registerCommand("om-status", {
		description: "Show observational memory status",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getBranch();
			const rawTokens = estimateRawTailTokens(entries);
			const obsTokens = estimateTokens(state.observations);
			const refTokens = estimateTokens(state.reflections);

			const lines = [
				"── Observational Memory ──",
				`Raw messages:  ~${rawTokens.toLocaleString()} tokens`,
				`Observations:  ~${obsTokens.toLocaleString()} tokens`,
				`Reflections:   ~${refTokens.toLocaleString()} tokens`,
				"",
				"── Parameters ──",
				`Observation threshold: ${config.observationThreshold.toLocaleString()}`,
				`Reflection threshold:  ${config.reflectionThreshold.toLocaleString()}`,
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

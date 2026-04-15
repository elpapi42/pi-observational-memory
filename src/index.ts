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
	compactionModel?: { provider: string; id: string };
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
- ✅ Completed: a task, question, subtask, or issue is concretely resolved

CRITICAL — DISTINGUISH USER ASSERTIONS FROM QUESTIONS:

When the user TELLS you something about themselves, mark it as an assertion:
- "I have two kids" → 🔴 User stated has two kids
- "I work at Acme Corp" → 🔴 User stated works at Acme Corp

When the user ASKS about something, mark it as a question/request:
- "Can you help me with X?" → 🔴 User asked help with X
- "What's the best way to do Y?" → 🟡 User asked best way to do Y

Distinguish between QUESTIONS and STATEMENTS OF INTENT:
- "Can you recommend..." → Question (extract as "User asked...")
- "I'm looking forward to doing X" → Statement of intent (extract as "User stated they will do X (include date if mentioned)")
- "I need to do X" → Statement of intent (extract as "User stated they need to do X")

USER ASSERTIONS ARE AUTHORITATIVE. The user is the source of truth about their own life. If a user previously stated something and later asks a question about the same topic, the assertion is the answer — the question doesn't invalidate what they already told you.

Rules:
- Group observations by date, with timestamps inline.
- Use the three-date model when relevant: note the observation date, the referenced date (if the event refers to a different day), and a relative date (e.g. "2 days ago").
- Nest related sub-observations under a parent observation.
- Preserve exact file paths, function names, error messages, and technical details.
- Focus on WHAT happened and WHY, not routine tool calls.
- Each observation should be one concise line.

CONTENT PRESERVATION:

User message capture:
- Short and medium-length user messages: capture nearly verbatim.
- Very long user messages: summarize but quote key phrases that carry specific intent or meaning.
- This is critical — when the conversation window shrinks, observations are the only record of what the user said.

Preserve unusual phrasing — quote the user's exact words when non-standard:
- BAD: User exercised.
- GOOD: User stated they did a "movement session" (their term for exercise).

Use precise action verbs — replace vague verbs with specific ones:
- BAD: User is getting X.
- GOOD: User subscribed to X. (if context confirms recurring delivery)
- GOOD: User purchased X. (if context confirms one-time acquisition)
Common: "getting regularly" → "subscribed to"; "got" → "purchased"/"received"/"was given"; "stopped getting" → "canceled"/"unsubscribed from"
If the assistant confirms or clarifies the user's vague language, prefer the assistant's more precise terminology.

Preserve distinguishing details in assistant-generated content:
- BAD: Assistant recommended 5 hotels.
- GOOD: Assistant recommended hotels: Hotel A (near station), Hotel B (budget-friendly), Hotel C (rooftop pool).
- BAD: Assistant provided social media accounts.
- GOOD: Assistant provided accounts: @user_one (portraits), @user_two (landscapes).

Preserve specific technical/numerical values:
- BAD: Assistant explained the performance improvements.
- GOOD: Optimization achieved 43.7% faster load times, memory dropped from 2.8GB to 940MB.

Preserve role/participation when user mentions their involvement:
- BAD: User attended the company event.
- GOOD: User was a presenter at the company event.

Code context — always preserve: exact file paths with line numbers, error messages verbatim, function/variable names, architectural decisions and rationale.

STATE CHANGES AND UPDATES:
When a user indicates they are changing something, frame it as a state change that supersedes previous information:
- "I'm going to start doing X instead of Y" → "User will start doing X (changing from Y)"
- "I'm switching from A to B" → "User is switching from A to B"
- "I moved my stuff to the new place" → "User moved to the new place (no longer at previous location)"

If the new state contradicts or updates previous information, make that explicit:
- BAD: User plans to use the new method.
- GOOD: User will use the new method (replacing the old approach).
- Do NOT repeat information already captured in existing reflections or observations.
- Do NOT wrap output in code blocks or markdown fences.

AVOIDING REPETITIVE OBSERVATIONS:
- Do NOT repeat the same observation across multiple turns if there is no new information.
- When the agent performs repeated similar actions (e.g., browsing files, running the same tool type multiple times), group them into a single parent observation with sub-bullets for each new result.

BAD (repetitive):
- 🟡 14:30 Agent used view tool on src/auth.ts
- 🟡 14:31 Agent used view tool on src/users.ts
- 🟡 14:32 Agent used view tool on src/routes.ts

GOOD (grouped):
- 🟡 14:30 Agent investigated auth flow
  - -> viewed src/auth.ts — found token validation logic
  - -> viewed src/users.ts — found user lookup by email
  - -> viewed src/routes.ts — found middleware chain

Only add a new observation for a repeated action if the NEW result changes the picture.

COMPLETION TRACKING:
✅ markers are explicit memory signals telling the assistant that work is finished and should not be repeated.

Use ✅ when:
- The user explicitly confirms something worked ("thanks, that fixed it", "got it", "perfect")
- The assistant provided a definitive answer and the user moved on
- A multi-step task reached its stated goal
- The user acknowledged receipt of requested information
- A concrete subtask or implementation step completed during ongoing work

Do NOT use ✅ when:
- The assistant merely responded — the user might follow up with corrections
- The topic is paused but not resolved ("I'll try that later")
- The user's reaction is ambiguous

Two formats:
As a sub-bullet under a parent observation:
- 🔴 HH:MM User asked how to configure auth middleware
  - -> Agent explained JWT setup with code example
  - ✅ User confirmed auth is working

Or standalone when closing a broader task:
- ✅ HH:MM Auth configuration completed — user confirmed middleware is working

Completion observations should be terse but specific about WHAT was completed. Prefer concrete resolved outcomes over abstract workflow status.`;

const REFLECTOR_SYSTEM = `You are a reflection agent for a coding assistant. Your job is to maintain long-term reflections while preserving as many observations as possible.

You will receive current reflections (long-term facts) and accumulated observations.

Your task:
1. PROMOTE observations to reflections ONLY when they are clearly stable, long-lived facts:
   - User identity, role, preferences
   - Project goals and architecture decisions
   - Permanent constraints and requirements
   - Key technical decisions and their rationale
   After promoting, KEEP the original observation — do not remove it.
2. PRUNE observations ONLY when you are certain they are dead:
   - Tasks explicitly completed AND no longer referenced
   - Information directly contradicted or superseded by a newer observation
   - Exact duplicates of other observations
   When in doubt, KEEP the observation.
   IMPORTANT: Preserve ✅ completion markers — they tell the assistant what is already resolved and prevent repeated work. Preserve the concrete resolved outcome captured by ✅ markers. When pruning detailed steps of a completed task, keep the ✅ outcome line.
   USER ASSERTIONS vs QUESTIONS: "User stated: X" = authoritative assertion. "User asked: X" = question/request. When consolidating, USER ASSERTIONS TAKE PRECEDENCE. If you see both "User stated: has two kids" and later "User asked: how many kids?", keep the assertion — the question doesn't invalidate what they told you.
3. KEEP everything else. Most observations should survive. An observation being old or low-priority (🟢) is NOT a reason to remove it.
4. UPDATE reflections: merge new promoted facts into existing reflections. Remove reflections only if directly contradicted by observations.

Output EXACTLY two sections with these tags:

<reflections>
[Updated long-term reflections — stable facts, one per line]
</reflections>

<observations>
[Surviving observations in the same date-grouped log format — most should be preserved]
</observations>

Do NOT wrap output in code blocks or markdown fences.`;

const CONTEXT_USAGE_INSTRUCTIONS = `KNOWLEDGE UPDATES: When observations contain conflicting information, prefer the MOST RECENT observation (check dates). Look for state-change phrases like "will start", "is switching", "changed to", "replacing" as indicators that older information has been superseded.

PLANNED ACTIONS: If an observation says the user planned to do something and the date is now in the past, assume they completed the action unless there's evidence they didn't.

USER ASSERTIONS: When observations contain both "User stated: X" and "User asked: X" about the same topic, the assertion is authoritative — the user is the source of truth about their own life.

COMPLETION MARKERS: Observations marked with ✅ indicate completed work. Do not re-do or re-investigate tasks marked as complete unless the user explicitly asks to revisit them.`;

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

		let model = ctx.model;
		if (config.compactionModel) {
			const configured = ctx.modelRegistry.find(config.compactionModel.provider, config.compactionModel.id);
			if (configured) {
				model = configured;
			} else if (ctx.hasUI) {
				ctx.ui.notify(
					`Observational memory: configured model ${config.compactionModel.provider}/${config.compactionModel.id} not found, using session model`,
					"warning",
				);
			}
		}
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
									text: `Today is ${dateStr}, current time is ${timeStr}.\n\n<current-reflections>\n${state.reflections || "(none yet)"}\n</current-reflections>\n\n<current-observations>\n${state.observations || "(none yet)"}\n</current-observations>\n\nCompress the following conversation into new observations:\n\n<conversation>\n${conversationText}\n</conversation>`,
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

		summary += `\n\n${CONTEXT_USAGE_INSTRUCTIONS}`;

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

	// ---- /om-view command ----

	pi.registerCommand("om-view", {
		description: "Print full observational memory contents (--full to include raw messages)",
		handler: async (args, ctx) => {
			const full = args.includes("--full");
			const sections: string[] = [];

			sections.push("── Reflections ──");
			sections.push(state.reflections || "(none)");
			sections.push("");
			sections.push("── Observations ──");
			sections.push(state.observations || "(none)");

			if (full) {
				const entries = ctx.sessionManager.getBranch();
				let startIndex = 0;
				for (let i = entries.length - 1; i >= 0; i--) {
					const entry = entries[i];
					if (entry.type === "compaction") {
						const keptId = entry.firstKeptEntryId;
						let found = false;
						for (let j = 0; j < entries.length; j++) {
							if (entries[j].id === keptId) {
								startIndex = j;
								found = true;
								break;
							}
						}
						if (!found) startIndex = i + 1;
						break;
					}
				}

				const rawMessages = entries
					.slice(startIndex)
					.filter((e): e is typeof e & { type: "message"; message: unknown } => e.type === "message")
					.map((e) => e.message);

				sections.push("");
				sections.push("── Raw Messages ──");
				if (rawMessages.length > 0) {
					sections.push(serializeConversation(convertToLlm(rawMessages)));
				} else {
					sections.push("(none)");
				}
			}

			ctx.ui.notify(sections.join("\n"), "info");
		},
	});
}

import { completeSimple, type Message, type TextContent, type ToolCall, type ToolResultMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm, SettingsManager } from "@mariozechner/pi-coding-agent";
import { DEFAULTS, loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { CONTEXT_USAGE_INSTRUCTIONS, OBSERVER_SYSTEM, REFLECTOR_SYSTEM } from "./prompts.js";
import { estimateRawTailTokens, estimateTokens, extractText } from "./tokens.js";
import type { MemoryDetails, MemoryState } from "./types.js";
import { isMemoryDetails } from "./types.js";

function utcDate(epochMs: number): string {
	if (!Number.isFinite(epochMs)) return "????-??-??";
	return new Date(epochMs).toISOString().slice(0, 10);
}

function utcTime(epochMs: number): string {
	if (!Number.isFinite(epochMs)) return "??:??";
	return new Date(epochMs).toISOString().slice(11, 16);
}

function serializeWithTimestamps(messages: Message[]): string {
	return messages
		.map((msg): string | null => {
			const time = utcTime(msg.timestamp);
			if (msg.role === "user") {
				const text =
					typeof msg.content === "string"
						? msg.content
						: msg.content
							.filter((b): b is TextContent => b.type === "text")
							.map((b) => b.text)
							.join("\n");
				return `[User @ ${time} UTC]: ${text}`;
			}
			if (msg.role === "assistant") {
				const parts = msg.content.map((b) => {
					if (b.type === "text") return b.text;
					if (b.type === "thinking") return b.redacted ? "" : `[thinking: ${b.thinking}]`;
					if (b.type === "toolCall") return `[${b.name}(${JSON.stringify(b.arguments)})]`;
					return "";
				});
				const body = parts.filter(Boolean).join("\n");
				if (!body) return null;
				return `[Assistant @ ${time} UTC]: ${body}`;
			}
			// toolResult
			const text = msg.content
				.filter((b): b is TextContent => b.type === "text")
				.map((b) => b.text)
				.join("\n");
			return `[Tool result for ${(msg as ToolResultMessage).toolName} @ ${time} UTC]: ${text}`;
		})
		.filter((line): line is string => line !== null)
		.join("\n\n");
}

export default function observationalMemory(pi: ExtensionAPI) {
	let config: Config = { ...DEFAULTS };
	let state: MemoryState = { observations: "", reflections: "" };
	let compactInFlight = false;

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
			try {
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
			} catch (error) {
				compactInFlight = false;
				const msg = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) ctx.ui.notify(`Observational memory: compact threw: ${msg}`, "error");
			}
		}, 0);
	});

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

		const now = new Date();
		const dateStr = utcDate(now.getTime());
		const timeStr = utcTime(now.getTime());

		const llmMessages = convertToLlm(allMessages);
		const conversationText = serializeWithTimestamps(llmMessages);

		let dateRangeNote = "";
		if (llmMessages.length > 0) {
			const timestamps = llmMessages.map((m) => m.timestamp);
			const firstTs = timestamps.reduce((a, b) => Math.min(a, b));
			const lastTs = timestamps.reduce((a, b) => Math.max(a, b));
			const firstMsgDate = utcDate(firstTs);
			const lastMsgDate = utcDate(lastTs);
			dateRangeNote =
				firstMsgDate === lastMsgDate
					? ` Messages in this batch are from ${firstMsgDate} (UTC).`
					: ` Messages in this batch span ${firstMsgDate} to ${lastMsgDate} (UTC).`;
		}

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
									text: `Today is ${dateStr}, current time is ${timeStr} UTC.${dateRangeNote}\n\n<current-reflections>\n${state.reflections || "(none yet)"}\n</current-reflections>\n\n<current-observations>\n${state.observations || "(none yet)"}\n</current-observations>\n\nCompress the following conversation into new observations:\n\n<conversation>\n${conversationText}\n</conversation>`,
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
										text: `Today is ${dateStr} (UTC).\n\n<current-reflections>\n${state.reflections || "(none yet)"}\n</current-reflections>\n\n<current-observations>\n${state.observations}\n</current-observations>\n\nGarbage-collect these observations. Promote long-lived facts to reflections, prune what's no longer needed, keep what's still active.`,
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

	pi.registerCommand("om-status", {
		description: "Show observational memory status",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getBranch();
			const rawTokens = estimateRawTailTokens(entries);
			const obsTokens = estimateTokens(state.observations);
			const refTokens = estimateTokens(state.reflections);
			const keepRecentTokens = SettingsManager.create(ctx.cwd).getCompactionKeepRecentTokens();

			const lines = [
				"── Observational Memory ──",
				`Raw messages:  ~${rawTokens.toLocaleString()} tokens`,
				`Observations:  ~${obsTokens.toLocaleString()} tokens`,
				`Reflections:   ~${refTokens.toLocaleString()} tokens`,
				"",
				"── Parameters ──",
				`Observation threshold: ${config.observationThreshold.toLocaleString()}`,
				`Reflection threshold:  ${config.reflectionThreshold.toLocaleString()} (interpreted as observations token budget)`,
				`Keep recent tokens:    ${keepRecentTokens.toLocaleString()} (pi compaction, how many tokens in raw messages)`,
			];

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

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
					sections.push(serializeWithTimestamps(convertToLlm(rawMessages)));
				} else {
					sections.push("(none)");
				}
			}

			ctx.ui.notify(sections.join("\n"), "info");
		},
	});
}

#!/usr/bin/env node
// One-off reconciliation: re-score "unscored" drop-score rows against a now-working
// endpoint, using the exact pool each historical dropper run actually saw.
//
// Usage: npx tsx scripts/backfill-drop-scores.mjs \
//   <sessionJsonlPath> <dropScoresNdjsonPath> <endpoint> <model>

import { readFileSync, writeFileSync } from "node:fs";
import { scoreObservations } from "../src/agents/dropper/system-one/agent.js";

const [sessionPath, scoresPath, endpoint, model] = process.argv.slice(2);
if (!sessionPath || !scoresPath || !endpoint || !model) {
	console.error("usage: backfill-drop-scores.mjs <session.jsonl> <scores.ndjson> <endpoint> <model>");
	process.exit(1);
}

const VETO_THRESHOLD = 0.15;
const DROP_THRESHOLD = 0.75;
const MAX_QUESTIONS_PER_REQUEST = 250;

/**
 * The script runs outside pi, so it cannot use ctx.modelRegistry. It speaks the
 * same classifier contract directly, mapping pi's `bool` questions to the wire's
 * `noul` and back.
 */
function httpRegistry(url, model) {
	const endpoint = `${url.replace(/\/+$/, "")}/v1/systemone`;
	return {
		getModelsOfType: (type, provider) => (type === "classifier" && provider === "local-jev" ? [{ provider, id: model }] : []),
		classify: async (_model, context, options) => {
			const questions = Object.fromEntries(
				Object.entries(context.questions).map(([id, question]) =>
					[id, question.type === "bool" ? { ...question, type: "noul" } : question]),
			);
			const response = await fetch(endpoint, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ state: context.state, model, questions }),
				signal: options?.signal,
			});
			if (!response.ok) throw new Error(`System One request to ${endpoint} failed with ${response.status}`);
			const payload = await response.json();
			const answers = {};
			for (const [id, answer] of Object.entries(payload.answers ?? {})) {
				answers[id] = answer.type === "noul" ? { type: "bool", probability: answer.noul } : answer;
			}
			return { answers, stopReason: "stop", usage: { input: payload.usage?.input_tokens, output: payload.usage?.output_tokens } };
		},
	};
}

function dropProbability(signals) {
	return Math.max(signals.redundant, signals.superseded, signals.lowSignal) * signals.safety;
}

// Replay the ledger to find, for every real om.observations.dropped event, the
// active pool (recorded minus dropped-so-far) and reflections-so-far immediately
// before that event was applied. That is exactly the input a dropper run saw.
function replayRuns(sessionPath) {
	const recorded = new Map();
	const dropped = new Set();
	const reflections = new Map();
	const runs = [];

	for (const line of readFileSync(sessionPath, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "custom") continue;
		const data = entry.data ?? {};
		if (entry.customType === "om.observations.recorded") {
			for (const o of data.observations ?? []) recorded.set(o.id, o);
		} else if (entry.customType === "om.reflections.recorded") {
			for (const r of data.reflections ?? []) reflections.set(r.id, r);
		} else if (entry.customType === "om.observations.dropped") {
			const activeBefore = [...recorded.values()].filter((o) => !dropped.has(o.id));
			runs.push({
				droppedIds: data.observationIds ?? [],
				observations: activeBefore,
				reflections: [...reflections.values()],
			});
			for (const id of data.observationIds ?? []) dropped.add(id);
		}
	}
	return runs;
}

function groupByTs(rows) {
	const order = [];
	const byTs = new Map();
	for (const row of rows) {
		if (!byTs.has(row.ts)) {
			byTs.set(row.ts, []);
			order.push(row.ts);
		}
		byTs.get(row.ts).push(row);
	}
	return order.map((ts) => ({ ts, rows: byTs.get(ts) }));
}

const rawLines = readFileSync(scoresPath, "utf-8").split("\n").filter((l) => l.trim());
const rows = rawLines.map((l) => JSON.parse(l));
const runGroups = groupByTs(rows);
const ledgerRuns = replayRuns(sessionPath);

// Match run groups to ledger events from the tail: shadow mode was enabled partway
// through these sessions' history, so only the last N ledger drop events correspond
// to the N run groups actually present in the score log.
const matched = ledgerRuns.slice(-runGroups.length);
if (matched.length !== runGroups.length) {
	console.error(`could not align ${runGroups.length} run group(s) with ${ledgerRuns.length} ledger drop event(s)`);
	process.exit(1);
}

for (let i = 0; i < runGroups.length; i++) {
	const group = runGroups[i];
	const ledgerRun = matched[i];
	const groupIds = new Set(group.rows.map((r) => r.observationId));
	const poolIds = new Set(ledgerRun.observations.map((o) => o.id));
	const missing = [...groupIds].filter((id) => !poolIds.has(id));
	if (missing.length > 0) {
		console.error(`run ${i} (${group.ts}): ${missing.length} scored id(s) not in reconstructed pool, alignment is wrong`);
		process.exit(1);
	}
	console.error(`run ${i} (${group.ts}): reconstructed pool ok, ${ledgerRun.observations.length} observations, ${ledgerRun.reflections.length} reflections`);
}

const updatedByKey = new Map(); // `${ts}:${observationId}` -> patch fields

for (let i = 0; i < runGroups.length; i++) {
	const group = runGroups[i];
	const ledgerRun = matched[i];
	const unscored = group.rows.filter((r) => r.systemOneDecision === "unscored");
	if (unscored.length === 0) {
		console.error(`run ${i} (${group.ts}): nothing to backfill`);
		continue;
	}

	console.error(`run ${i} (${group.ts}): scoring ${unscored.length} observation(s) against ${endpoint} ...`);
	const t0 = Date.now();
	const { signalsById } = await scoreObservations({
		config: {
			mode: "primary",
			provider: "local-jev",
			model,
			vetoThreshold: VETO_THRESHOLD,
			dropThreshold: DROP_THRESHOLD,
			maxQuestionsPerRequest: MAX_QUESTIONS_PER_REQUEST,
			requestTimeoutMs: 300000,
		},
		registry: httpRegistry(endpoint, model),
		reflections: ledgerRun.reflections,
		observations: ledgerRun.observations,
		targetTokens: 0,
	});
	console.error(`run ${i}: scored in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${signalsById.size} usable signal sets`);

	for (const row of unscored) {
		const signals = signalsById.get(row.observationId);
		if (!signals) continue;
		const probability = dropProbability(signals);
		const systemOneDecision =
			signals.floor >= VETO_THRESHOLD ? "vetoed" : probability >= DROP_THRESHOLD ? "drop" : "keep";
		updatedByKey.set(`${row.ts}:${row.observationId}`, { signals, dropProbability: probability, systemOneDecision });
	}
}

const patchedRows = rows.map((row) => {
	const patch = updatedByKey.get(`${row.ts}:${row.observationId}`);
	return patch ? { ...row, ...patch } : row;
});

writeFileSync(scoresPath, patchedRows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
console.error(`wrote ${patchedRows.length} rows (${updatedByKey.size} backfilled) to ${scoresPath}`);

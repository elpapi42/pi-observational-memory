import { describe, expect, it, vi } from "vitest";

import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import {
	compactionEntry,
	memoryDetails,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2CompactionDetails,
	oldV2ObservationEntry,
	reflection,
	reflectionsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

function setup(args: {
	entries: TestEntry[];
	observationsPoolMaxTokens?: number;
	compactHookInFlight?: boolean;
	enabled?: boolean;
	passive?: boolean;
}) {
	let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
	const pi = {
		on: vi.fn((eventName: string, cb: typeof handler) => {
			expect(eventName).toBe("session_before_compact");
			handler = cb;
		}),
		appendEntry: vi.fn(),
	};
	const runtime = {
		enabled: args.enabled ?? true,
		config: {
			passive: args.passive ?? false,
			observationsPoolMaxTokens: args.observationsPoolMaxTokens ?? 20_000,
		},
		compactHookInFlight: args.compactHookInFlight ?? false,
		observerPromise: new Promise(() => {}),
		resolveModel: vi.fn(() => {
			throw new Error("resolveModel must not be called");
		}),
		ensureConfig: vi.fn(),
	};
	registerCompactionHook(pi as any, runtime as any);
	if (!handler) throw new Error("compaction handler was not registered");
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		sessionManager: { getBranch: vi.fn(() => args.entries) },
	};
	const run = (firstKeptEntryId = args.entries.at(-1)?.id ?? "missing") => handler!({
		preparation: { firstKeptEntryId, tokensBefore: 123 },
		branchEntries: args.entries,
		signal: undefined,
	}, ctx);
	return { pi, runtime, ctx, run };
}

describe("V3 compaction hook", () => {
	it("delegates to native compaction when there is no V3 memory", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, runtime, pi } = setup({ entries });

		const result = await run("raw-1");

		expect(result).toBeUndefined();
		expect(runtime.resolveModel).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(runtime.compactHookInFlight).toBe(false);
	});

	it("first normal compaction writes covered observations without orphan reflections", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
		];
		const { run } = setup({ entries, observationsPoolMaxTokens: 100 });

		const result = await run("raw-1") as any;

		expect(result.compaction.details.fullFold).toBe(false);
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(result.compaction.details.reflections).toEqual([]);
		expect(result.compaction.summary).toContain("## Observations");
		expect(result.compaction.summary).not.toContain("## Reflections");
	});

	it("writes a normal V3 projection without applying new reflections or drops", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 5 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }) }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-ffffffffffff", { reflections: [ref2], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-2", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-2" }),
		];
		const { run } = setup({ entries, observationsPoolMaxTokens: 100 });

		const result = await run("raw-2") as any;

		expect(result.compaction.details).toMatchObject({ type: "om.folded", version: 1, fullFold: false });
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		expect(result.compaction.details.reflections.map((ref: any) => ref.id)).toEqual(["eeeeeeeeeeee"]);
		expect(result.compaction.summary).toContain("## Reflections\n[eeeeeeeeeeee]");
		expect(result.compaction.summary).toContain("## Observations");
	});

	it("writes a full V3 projection when observation pool pressure reaches the threshold", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 80 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 30 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }) }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-ffffffffffff", { reflections: [ref2], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-2", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-2" }),
		];
		const { run } = setup({ entries, observationsPoolMaxTokens: 100 });

		const result = await run("raw-2") as any;

		expect(result.compaction.details.fullFold).toBe(true);
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(result.compaction.details.reflections.map((ref: any) => ref.id)).toEqual(["eeeeeeeeeeee", "ffffffffffff"]);
	});

	it("delegates to native compaction when only old V2 memory exists", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			oldV2ObservationEntry("v2-obs"),
			compactionEntry("cmp-v2", { firstKeptEntryId: "raw-1", details: oldV2CompactionDetails() }),
		];
		const { run } = setup({ entries });

		const result = await run("cmp-v2");

		expect(result).toBeUndefined();
	});

	it("does not wait for worker promises or call model resolution", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, runtime } = setup({ entries });

		const result = await Promise.race([
			run("raw-1"),
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 50)),
		]);

		expect(result).toBeUndefined();
		expect(runtime.resolveModel).not.toHaveBeenCalled();
	});

	it("cancels duplicate in-flight compaction and notifies the UI", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, ctx } = setup({ entries, compactHookInFlight: true });

		await expect(run("raw-1")).resolves.toEqual({ cancel: true });
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: another compaction is already in progress; cancelling duplicate",
			"warning",
		);
	});
});

describe("V3 compaction hook activation gate (#13)", () => {
	it("disabled runtime delegates natively before the duplicate guard, config load, or state mutation", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
		];
		const { run, runtime, ctx, pi } = setup({ entries, enabled: false, compactHookInFlight: true });

		const result = await run("raw-1");

		expect(result).toBeUndefined();
		expect(runtime.ensureConfig).not.toHaveBeenCalled();
		expect(runtime.resolveModel).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		// The pre-existing in-flight flag was never inspected or cleared: disabled
		// delegation returns before the duplicate guard runs at all.
		expect(runtime.compactHookInFlight).toBe(true);
	});

	it("passive runtime delegates natively even with prior observational ledger entries, without entering the duplicate guard", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
		];
		const { run, runtime, ctx, pi } = setup({ entries, enabled: true, passive: true, compactHookInFlight: true });

		const result = await run("raw-1");

		expect(result).toBeUndefined();
		expect(runtime.ensureConfig).toHaveBeenCalled();
		expect(runtime.resolveModel).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(runtime.compactHookInFlight).toBe(true);
	});

	it("enabled non-empty projection preserves observational compaction ownership", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
		];
		const { run, runtime } = setup({ entries, enabled: true, passive: false });

		const result = await run("raw-1") as any;

		expect(runtime.ensureConfig).toHaveBeenCalled();
		expect(result.compaction.summary).toContain("## Observations");
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toEqual(["aaaaaaaaaaaa"]);
	});

	it("enabled empty projection delegates to native compaction rather than replacing context", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, runtime } = setup({ entries, enabled: true, passive: false });

		const result = await run("raw-1");

		expect(runtime.ensureConfig).toHaveBeenCalled();
		expect(result).toBeUndefined();
		expect(runtime.compactHookInFlight).toBe(false);
	});

	it("enabled non-passive duplicate compaction still cancels and notifies", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, ctx } = setup({ entries, enabled: true, passive: false, compactHookInFlight: true });

		await expect(run("raw-1")).resolves.toEqual({ cancel: true });
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: another compaction is already in progress; cancelling duplicate",
			"warning",
		);
	});
});

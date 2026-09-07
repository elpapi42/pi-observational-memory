import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function seedLedger(pi: ExtensionAPI): void {
	pi.registerCommand("smoke_seed_om", {
		description: "Seed observational-memory ledger data for smoke verification",
		handler: async (_args, ctx) => {
			pi.appendEntry("om.observations.recorded", {
				observations: [{
					id: "smoke-old-observation",
					content: "Existing observational memory must not activate passive compaction.",
					timestamp: "2026-09-07T12:00:00.000Z",
					relevance: "high",
					sourceEntryIds: ["smoke-seed-source"],
					tokenCount: 10,
				}],
				coversUpToId: "smoke-seed-source",
			});
			ctx.ui.notify("Smoke observational-memory ledger seeded.", "info");
		},
	});
}

import { describe, expect, it, vi } from "vitest";

import { Runtime } from "../src/runtime.js";
import { gateRecallTool, restoreRecallTool } from "../src/tool-gate.js";

function fakePi(activeTools: string[]) {
	let current = [...activeTools];
	return {
		pi: {
			getActiveTools: vi.fn(() => current),
			setActiveTools: vi.fn((names: string[]) => {
				current = [...names];
			}),
		},
		getActiveTools: () => current,
	};
}

describe("gateRecallTool (#12)", () => {
	it("removes recall from the allowlist and records that it was active", () => {
		const { pi, getActiveTools } = fakePi(["read", "recall", "bash"]);
		const runtime = new Runtime();

		gateRecallTool(pi as any, runtime);

		expect(getActiveTools()).toEqual(["read", "bash"]);
		expect(runtime.recallActiveBeforeGate).toBe(true);
	});

	it("leaves the allowlist untouched and records recall as inactive when it was already absent", () => {
		const { pi, getActiveTools } = fakePi(["read", "bash"]);
		const runtime = new Runtime();

		gateRecallTool(pi as any, runtime);

		expect(getActiveTools()).toEqual(["read", "bash"]);
		expect(runtime.recallActiveBeforeGate).toBe(false);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("restoreRecallTool (#12)", () => {
	it("adds recall back only when the gate recorded it as previously active", () => {
		const { pi, getActiveTools } = fakePi(["read", "bash"]);
		const runtime = new Runtime();
		runtime.recallActiveBeforeGate = true;

		restoreRecallTool(pi as any, runtime);

		expect(getActiveTools()).toEqual(["read", "bash", "recall"]);
	});

	it("is a no-op when the gate recorded recall as previously inactive", () => {
		const { pi, getActiveTools } = fakePi(["read", "bash"]);
		const runtime = new Runtime();
		runtime.recallActiveBeforeGate = false;

		restoreRecallTool(pi as any, runtime);

		expect(getActiveTools()).toEqual(["read", "bash"]);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});

	it("is a no-op when the gate has never run", () => {
		const { pi, getActiveTools } = fakePi(["read", "bash"]);
		const runtime = new Runtime();

		restoreRecallTool(pi as any, runtime);

		expect(getActiveTools()).toEqual(["read", "bash"]);
		expect(pi.getActiveTools).not.toHaveBeenCalled();
	});

	it("does not duplicate recall when it is already active", () => {
		const { pi, getActiveTools } = fakePi(["read", "recall", "bash"]);
		const runtime = new Runtime();
		runtime.recallActiveBeforeGate = true;

		restoreRecallTool(pi as any, runtime);

		expect(getActiveTools()).toEqual(["read", "recall", "bash"]);
		expect(pi.setActiveTools).not.toHaveBeenCalled();
	});
});

describe("gate then restore round trip (#12)", () => {
	it("restores the exact prior allowlist membership after a gate/restore cycle", () => {
		const { pi, getActiveTools } = fakePi(["read", "recall", "bash", "edit"]);
		const runtime = new Runtime();

		gateRecallTool(pi as any, runtime);
		expect(getActiveTools()).toEqual(["read", "bash", "edit"]);

		restoreRecallTool(pi as any, runtime);
		expect(getActiveTools()).toEqual(["read", "bash", "edit", "recall"]);
	});
});

import { describe, expect, it } from "vitest";
import { getOpenCodeSessionHeaders, isOpenCodeModel } from "../src/session-headers.js";

describe("isOpenCodeModel", () => {
	it("matches the opencode and opencode-go providers", () => {
		expect(isOpenCodeModel({ provider: "opencode", id: "x" })).toBe(true);
		expect(isOpenCodeModel({ provider: "opencode-go", id: "mimo-v2.5" })).toBe(true);
	});

	it("matches any model served from the opencode.ai host", () => {
		expect(isOpenCodeModel({ provider: "custom", baseUrl: "https://opencode.ai/zen/go/v1" })).toBe(true);
	});

	it("rejects other providers, malformed urls, and non-objects", () => {
		expect(isOpenCodeModel({ provider: "anthropic", id: "claude" })).toBe(false);
		expect(isOpenCodeModel({ provider: "custom", baseUrl: "https://api.example.com/v1" })).toBe(false);
		expect(isOpenCodeModel({ provider: "custom", baseUrl: "not a url" })).toBe(false);
		expect(isOpenCodeModel({ provider: "custom" })).toBe(false);
		expect(isOpenCodeModel(undefined)).toBe(false);
		expect(isOpenCodeModel(null)).toBe(false);
		expect(isOpenCodeModel("opencode-go")).toBe(false);
	});
});

describe("getOpenCodeSessionHeaders", () => {
	it("returns the session routing headers for OpenCode models", () => {
		expect(getOpenCodeSessionHeaders({ provider: "opencode-go", id: "mimo-v2.5" }, "session-1")).toEqual({
			"x-opencode-session": "session-1",
			"x-opencode-client": "pi",
		});
	});

	it("returns undefined without a session id or for other providers", () => {
		expect(getOpenCodeSessionHeaders({ provider: "opencode-go" }, undefined)).toBeUndefined();
		expect(getOpenCodeSessionHeaders({ provider: "opencode-go" }, "")).toBeUndefined();
		expect(getOpenCodeSessionHeaders({ provider: "anthropic" }, "session-1")).toBeUndefined();
	});
});

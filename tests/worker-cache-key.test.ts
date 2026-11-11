import { describe, expect, it } from "vitest";

import { sessionCacheId, workerCacheKey } from "../src/agents/cache-key.js";

describe("workerCacheKey", () => {
	it("scopes the session id by worker stage", () => {
		const sessionId = "01a1cbb9-f19f-7030-8fba-1a7aced18b15";

		expect(workerCacheKey("observer", sessionId)).toBe(`om:observer:${sessionId}`);
		expect(workerCacheKey("reflector", sessionId)).toBe(`om:reflector:${sessionId}`);
		expect(workerCacheKey("dropper", sessionId)).toBe(`om:dropper:${sessionId}`);
	});

	it("is stable for the same stage and session", () => {
		expect(workerCacheKey("observer", "session-1")).toBe(workerCacheKey("observer", "session-1"));
	});

	it("returns undefined when there is no usable session id", () => {
		expect(workerCacheKey("observer", undefined)).toBeUndefined();
		expect(workerCacheKey("observer", "")).toBeUndefined();
		expect(workerCacheKey("observer", "   ")).toBeUndefined();
	});

	it("trims the session id", () => {
		expect(workerCacheKey("observer", "  session-1  ")).toBe("om:observer:session-1");
	});

	it("stays within OpenAI's 64-character prompt_cache_key limit without losing session entropy", () => {
		const longA = "session-".repeat(20) + "a";
		const longB = "session-".repeat(20) + "b";
		const keyA = workerCacheKey("reflector", longA);
		const keyB = workerCacheKey("reflector", longB);

		expect(keyA!.length).toBeLessThanOrEqual(64);
		expect(keyA!.startsWith("om:reflector:")).toBe(true);
		expect(keyA).not.toBe(keyB);
		expect(workerCacheKey("reflector", longA)).toBe(keyA);
	});

	it("keeps short session ids readable instead of hashing them", () => {
		const key = workerCacheKey("dropper", "abc");

		expect(key).toBe("om:dropper:abc");
	});
});

describe("sessionCacheId", () => {
	it("reads the session id from the session manager", () => {
		expect(sessionCacheId({ sessionManager: { getSessionId: () => "session-1" } })).toBe("session-1");
	});

	it("returns undefined when the session manager exposes no id", () => {
		expect(sessionCacheId(undefined)).toBeUndefined();
		expect(sessionCacheId({})).toBeUndefined();
		expect(sessionCacheId({ sessionManager: {} })).toBeUndefined();
	});

	it("swallows stale-context failures from getSessionId", () => {
		const throwing = {
			sessionManager: {
				getSessionId: () => {
					throw new Error("stale context");
				},
			},
		};

		expect(sessionCacheId(throwing)).toBeUndefined();
	});
});

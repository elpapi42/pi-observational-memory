export interface TomConfig {
	S: number;
	T: number;
	R: number;
	observerModel: { provider: string; id: string };
	reflectorModel: { provider: string; id: string };
	debounceMs: number;
	observerMaxTokens: number;
	reflectorMaxTokens: number;
}

export const DEFAULT_CONFIG: TomConfig = {
	S: 10_000,
	T: 50_000,
	R: 30_000,
	observerModel: { provider: "google", id: "gemini-2.5-flash" },
	reflectorModel: { provider: "google", id: "gemini-2.5-flash" },
	debounceMs: 2_000,
	observerMaxTokens: 2_048,
	reflectorMaxTokens: 4_096,
};

export function batchSize(cfg: TomConfig): number {
	return cfg.T - cfg.S;
}

// Runs the embedding model off the main thread: onnxruntime blocks the thread that calls it for
// the whole batch, which would freeze Pi's TUI. Plain JavaScript because worker threads load
// this file with Node directly, outside Pi's TypeScript loader.
import { parentPort, workerData } from "node:worker_threads";

const { model, pooling, cacheDir } = workerData;

try {
	const transformers = await import("@huggingface/transformers");
	transformers.env.cacheDir = cacheDir;
	const extract = await transformers.pipeline("feature-extraction", model, { dtype: "q8" });
	parentPort.on("message", async ({ id, texts }) => {
		try {
			const output = await extract(texts, { pooling, normalize: true });
			const [count, dims] = output.dims;
			const data = output.data;
			const vectors = Array.from({ length: count }, (_, i) => data.slice(i * dims, (i + 1) * dims));
			parentPort.postMessage({ id, vectors }, vectors.map((vector) => vector.buffer));
		} catch (error) {
			parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
		}
	});
	parentPort.postMessage({ ready: true });
} catch (error) {
	parentPort.postMessage({ ready: false, error: error instanceof Error ? error.message : String(error) });
}

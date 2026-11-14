import { createEngine, type ResultMsg, type WorkerIn } from "./engine";

// A Web Worker runs on its own thread, so a long search never freezes the map.
const ctx = self as unknown as {
  postMessage(msg: ResultMsg): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};
const handle = createEngine();
ctx.onmessage = (e) => {
  const out = handle(e.data);
  if (out) ctx.postMessage(out);
};

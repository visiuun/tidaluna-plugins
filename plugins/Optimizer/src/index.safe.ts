import { Tracer, type LunaUnload } from "@luna/core";

// Here rather than in index.ts, so the plugin's other files can import them without a cycle
export const unloads = new Set<LunaUnload>();
export const { trace } = Tracer("[Optimizer]");

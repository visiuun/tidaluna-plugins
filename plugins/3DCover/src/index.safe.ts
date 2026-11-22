// The plugin's unloads and tracer, in a module of their own so any file can import them without a cycle through index.ts
import { Tracer, type LunaUnload } from "@luna/core";

export const unloads = new Set<LunaUnload>();
export const { trace } = Tracer("[3DCover]");

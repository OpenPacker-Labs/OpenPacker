/** The process the run commands execute in; tests replace parts of it (ADR 0047). */
import { processHost, type ChildHost } from './run-child.js';
import type { BinProbe } from './run-paths.js';

export interface RunContext {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  host: ChildHost;
  probe?: ((file: string) => Promise<BinProbe>) | undefined;
}

export function processContext(): RunContext {
  return { env: process.env, platform: process.platform, host: processHost };
}

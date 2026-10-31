/** The process the run commands execute in; tests replace parts of it (ADR 0047). */
import { processHost, type ChildHost } from './run-child.js';
import type { PackageFile } from './run-package.js';
import type { BinProbe, RunShims } from './run-paths.js';
import { packageShims } from './run-shims.js';

export interface RunContext {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  host: ChildHost;
  probe?: ((file: string) => Promise<BinProbe>) | undefined;
  /** The Node that runs `opm`; what `opm exec node` starts. */
  execPath?: string | undefined;
  /** Processors available, for the default number of members run at once. */
  parallelism?: number | undefined;
  /**
   * Reads a workspace member's `package.json` by path (default:
   * `readMemberPackage`, which refuses links). A test replaces it to make a
   * link appear after discovery, which no real directory can do on demand.
   */
  readMember?:
    | ((root: string, dir: string) => Promise<PackageFile | undefined>)
    | undefined;
  /**
   * The `npm`, `pnpm` and `yarn` put first on a child's PATH (ADR 0061). The
   * process's context has opm's own; absent, PATH is the `.bin` directories
   * and what was inherited, as before.
   */
  shims?: RunShims | undefined;
}

export function processContext(): RunContext {
  return {
    env: process.env,
    platform: process.platform,
    host: processHost,
    shims: packageShims(),
  };
}

/** Minimal surface for optional @microsoft/mxc-sdk/v1 (types-only when optional install is skipped). */
declare module '@microsoft/mxc-sdk/v1' {
  export interface MxcPolicyInput {
    version: string;
    filesystem: { readonlyPaths: string[]; readwritePaths: string[] };
    network: { allowOutbound: boolean };
    timeoutMs?: number;
  }

  export interface MxcSandboxConfig {
    process?: { commandLine?: string; cwd?: string; env?: string[] };
  }

  export function getPlatformSupport(): { isSupported: boolean };
  export function getTemporaryFilesPolicy(): { readwritePaths: string[] };
  export function createConfigFromPolicy(
    config: MxcPolicyInput,
  ): MxcSandboxConfig;
  export function spawnSandboxFromConfig(
    config: MxcSandboxConfig,
    options: { usePty: boolean },
  ): {
    stdout?: NodeJS.ReadableStream | null;
    stderr?: NodeJS.ReadableStream | null;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    kill?: (signal?: NodeJS.Signals) => void;
  };
}

export {};

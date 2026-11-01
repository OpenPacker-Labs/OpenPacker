/** Minimal surface for optional @microsoft/mxc-sdk/v1 (types-only when optional install is skipped). */
declare module '@microsoft/mxc-sdk/v1' {
  export function getPlatformSupport(): { isSupported: boolean };
  export function getTemporaryFilesPolicy(): { readwritePaths: string[] };
  export function createConfigFromPolicy(config: unknown): {
    process?: { commandLine?: string; cwd?: string; env?: string[] };
  };
  export function spawnSandboxFromConfig(
    config: unknown,
    options: { usePty: boolean },
  ): {
    stdout?: NodeJS.ReadableStream | null;
    stderr?: NodeJS.ReadableStream | null;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    kill?: (signal?: NodeJS.Signals) => void;
  };
}

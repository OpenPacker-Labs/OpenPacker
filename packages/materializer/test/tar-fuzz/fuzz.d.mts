/** Types for src/tar-fuzz.test.ts, the bounded run of the fuzz in the suite. */

export interface Archive {
  label: string;
  blocks: Uint8Array[];
}

export interface Readers {
  judge(bytes: Uint8Array): Promise<{ verdict: string; detail?: string }>;
  close(): Promise<number>;
  versions: string[];
}

export function openReaders(options: {
  opm: {
    inspectArchive: unknown;
    DEFAULT_MATERIALIZATION_LIMITS: unknown;
  };
  nodeTar6: string;
  nodeTar7?: string | undefined;
  pnpm: string;
  pacote?: boolean;
}): Readers;

export function runFamily(
  readers: Readers,
  archives: Iterable<Archive>,
): Promise<{
  total: number;
  histogram: Map<string, number>;
  samples: Map<
    string,
    Array<{ label: string; detail?: string; base64: string }>
  >;
  unsafe: number;
}>;

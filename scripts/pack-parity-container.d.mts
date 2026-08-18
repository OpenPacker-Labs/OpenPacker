export interface ParityContainerInput {
  runtime: string;
  image: string;
  artifactDirectory: string;
  command: string[];
  name: string;
  platform?: 'linux' | 'windows';
}

export function parityContainerCommand(input: ParityContainerInput): {
  executable: 'docker' | 'podman';
  arguments: string[];
  name: string;
};

export function runParityContainer(
  plan: ReturnType<typeof parityContainerCommand>,
  execute?: typeof import('node:child_process').spawnSync,
): import('node:child_process').SpawnSyncReturns<Buffer>;

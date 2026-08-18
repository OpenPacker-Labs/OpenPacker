export interface ParityContainerInput {
  runtime: string;
  image: string;
  artifactDirectory: string;
  command: string[];
  platform?: 'linux' | 'windows';
}

export function parityContainerCommand(input: ParityContainerInput): {
  executable: 'docker' | 'podman';
  arguments: string[];
};

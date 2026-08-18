import { isAbsolute, resolve } from 'node:path';

const DIGEST_IMAGE = /^[-./:@a-zA-Z0-9_]+@sha256:[a-f0-9]{64}$/u;
const RUNTIMES = new Set(['docker', 'podman']);

export function parityContainerCommand({
  runtime,
  image,
  artifactDirectory,
  command,
}) {
  if (!RUNTIMES.has(runtime))
    throw new Error('container runtime must be docker or podman');
  if (!DIGEST_IMAGE.test(image))
    throw new Error('parity image must be pinned by sha256 digest');
  if (
    !isAbsolute(artifactDirectory) ||
    artifactDirectory.includes(',') ||
    /[\0\r\n]/u.test(artifactDirectory)
  )
    throw new Error('artifact directory must be an absolute safe mount path');
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some(
      (argument) => typeof argument !== 'string' || /[\0\r\n]/u.test(argument),
    )
  )
    throw new Error('container command must be non-empty safe argv');

  const source = resolve(artifactDirectory);
  return {
    executable: runtime,
    arguments: [
      'run',
      '--rm',
      '--pull=never',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=128',
      '--memory=512m',
      '--cpus=1',
      '--user=65532:65532',
      '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m',
      '--tmpfs=/work:rw,nosuid,nodev,size=256m',
      '--workdir=/work',
      '--env=HOME=/work',
      '--mount',
      `type=bind,source=${source},target=/input,readonly`,
      image,
      ...command,
    ],
  };
}

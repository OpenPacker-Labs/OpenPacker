import { isAbsolute, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const DIGEST_IMAGE = /^[-./:@a-zA-Z0-9_]+@sha256:[a-f0-9]{64}$/u;
const RUNTIMES = new Set(['docker', 'podman']);

export function parityContainerCommand({
  runtime,
  image,
  artifactDirectory,
  command,
  platform = 'linux',
}) {
  if (!RUNTIMES.has(runtime))
    throw new Error('container runtime must be docker or podman');
  if (!['linux', 'windows'].includes(platform))
    throw new Error('container platform must be linux or windows');
  if (platform === 'windows' && runtime !== 'docker')
    throw new Error('Windows parity requires Docker Hyper-V isolation');
  if (!DIGEST_IMAGE.test(image))
    throw new Error('parity image must be pinned by sha256 digest');
  const absolute =
    platform === 'windows'
      ? win32.isAbsolute(artifactDirectory)
      : isAbsolute(artifactDirectory);
  if (
    !absolute ||
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

  const source =
    platform === 'windows'
      ? win32.normalize(artifactDirectory)
      : resolve(artifactDirectory);
  const target = platform === 'windows' ? 'C:\\input' : '/input';
  const isolation =
    platform === 'windows'
      ? [
          '--isolation=hyperv',
          '--user=ContainerUser',
          '--read-only',
          '--network=none',
          '--memory=1g',
          '--cpus=1',
          '--mount=type=volume,target=C:\\work',
          '--workdir=C:\\work',
          '--env=TEMP=C:\\work',
          '--env=TMP=C:\\work',
        ]
      : [
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
        ];
  return {
    executable: runtime,
    arguments: [
      'run',
      '--rm',
      '--pull=never',
      ...isolation,
      '--mount',
      `type=bind,source=${source},target=${target},readonly`,
      image,
      ...command,
    ],
  };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const mode = process.env.OPENPACKER_NATIVE_PACK_PARITY;
  if (!['linux', 'windows'].includes(mode ?? '')) {
    console.error(
      'set OPENPACKER_NATIVE_PACK_PARITY=linux or windows before running native parity',
    );
    process.exit(2);
  }
  const result = spawnSync(
    'npm',
    [
      'exec',
      '--',
      'vitest',
      'run',
      'packages/adapters-default/src/standard-pack.native.test.ts',
    ],
    { stdio: 'inherit', shell: false },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

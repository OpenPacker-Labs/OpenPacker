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
  name,
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
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/u.test(name))
    throw new Error('parity container name is required and must be safe');
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
          '--network=none',
          '--memory=1g',
          '--cpus=1',
          '--storage-opt=size=20G',
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
    name,
    arguments: [
      'run',
      '--rm',
      `--name=${name}`,
      '--pull=never',
      '--log-driver=none',
      ...isolation,
      '--mount',
      `type=bind,source=${source},target=${target},readonly`,
      image,
      ...command,
    ],
  };
}

export function runParityContainer(plan, execute = spawnSync) {
  const result = execute(plan.executable, plan.arguments, {
    stdio: 'inherit',
    shell: false,
    timeout: 120_000,
  });
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0
  )
    execute(plan.executable, ['rm', '--force', plan.name], {
      stdio: 'ignore',
      shell: false,
      timeout: 10_000,
    });
  return result;
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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parityContainerCommand } from '../../scripts/pack-parity-container.mjs';

const image = `registry.example.invalid/tool@sha256:${'a'.repeat(64)}`;

test('native parity uses a locked-down, offline container', () => {
  const plan = parityContainerCommand({
    runtime: 'podman',
    image,
    artifactDirectory: '/tmp/openpacker-parity',
    command: ['tool', 'verify', '/input/package'],
  });
  assert.equal(plan.executable, 'podman');
  assert.deepEqual(plan.arguments.slice(0, 22), [
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
    'type=bind,source=/tmp/openpacker-parity,target=/input,readonly',
    image,
    'tool',
    'verify',
    '/input/package',
  ]);
  assert.doesNotMatch(plan.arguments.join(' '), /privileged|docker\.sock/u);
});

test('native parity rejects ambient execution and mutable image selection', () => {
  for (const runtime of ['sh', 'nix', 'winget'])
    assert.throws(
      () =>
        parityContainerCommand({
          runtime,
          image,
          artifactDirectory: '/tmp/openpacker-parity',
          command: ['true'],
        }),
      /docker or podman/u,
    );
  for (const mutableImage of ['node:latest', 'node@sha256:nope'])
    assert.throws(
      () =>
        parityContainerCommand({
          runtime: 'docker',
          image: mutableImage,
          artifactDirectory: '/tmp/openpacker-parity',
          command: ['true'],
        }),
      /pinned/u,
    );
  assert.throws(
    () =>
      parityContainerCommand({
        runtime: 'docker',
        image,
        artifactDirectory: '/tmp/unsafe,path',
        command: ['true'],
      }),
    /safe mount/u,
  );
});

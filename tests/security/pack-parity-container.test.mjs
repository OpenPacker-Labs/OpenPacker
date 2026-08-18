import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  parityContainerCommand,
  runParityContainer,
} from '../../scripts/pack-parity-container.mjs';

const image = `registry.example.invalid/tool@sha256:${'a'.repeat(64)}`;

test('native parity uses a locked-down, offline container', () => {
  const plan = parityContainerCommand({
    runtime: 'podman',
    name: 'openpacker-parity-npm',
    image,
    artifactDirectory: '/tmp/openpacker-parity',
    command: ['tool', 'verify', '/input/package'],
  });
  assert.equal(plan.executable, 'podman');
  assert.deepEqual(plan.arguments, [
    'run',
    '--rm',
    '--name=openpacker-parity-npm',
    '--pull=never',
    '--log-driver=none',
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
          name: 'openpacker-parity-test',
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
          name: 'openpacker-parity-test',
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
        name: 'openpacker-parity-test',
        image,
        artifactDirectory: '/tmp/unsafe,path',
        command: ['true'],
      }),
    /safe mount/u,
  );
});

test('Windows manager parity requires Hyper-V isolation', () => {
  const plan = parityContainerCommand({
    runtime: 'docker',
    name: 'openpacker-parity-winget',
    platform: 'windows',
    image,
    artifactDirectory: 'C:\\openpacker-parity',
    command: ['winget', 'validate', '--manifest', 'C:\\input'],
  });
  assert.ok(plan.arguments.includes('--isolation=hyperv'));
  assert.ok(plan.arguments.includes('--user=ContainerUser'));
  assert.ok(plan.arguments.includes('--network=none'));
  assert.ok(plan.arguments.includes('--storage-opt=size=20G'));
  assert.throws(
    () =>
      parityContainerCommand({
        runtime: 'podman',
        name: 'openpacker-parity-winget',
        platform: 'windows',
        image,
        artifactDirectory: 'C:\\openpacker-parity',
        command: ['winget', '--version'],
      }),
    /Docker Hyper-V/u,
  );
});

test('native parity forcibly removes a timed-out container', () => {
  const plan = parityContainerCommand({
    runtime: 'docker',
    name: 'openpacker-parity-timeout',
    image,
    artifactDirectory: '/tmp/openpacker-parity',
    command: ['tool', 'verify', '/input/package'],
  });
  const calls = [];
  const execute = (executable, args) => {
    calls.push([executable, args]);
    return calls.length === 1
      ? { error: new Error('timed out'), signal: 'SIGTERM', status: null }
      : { signal: null, status: 0 };
  };
  runParityContainer(plan, execute);
  assert.deepEqual(calls[1], [
    'docker',
    ['rm', '--force', 'openpacker-parity-timeout'],
  ]);
});

test('native parity command refuses a silent skipped run', () => {
  const env = { ...process.env };
  delete env.OPENPACKER_NATIVE_PACK_PARITY;
  const result = spawnSync(
    process.execPath,
    ['scripts/pack-parity-container.mjs'],
    { cwd: process.cwd(), env, encoding: 'utf8' },
  );
  assert.equal(result.status, 2);
});

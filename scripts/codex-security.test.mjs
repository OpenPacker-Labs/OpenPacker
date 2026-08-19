import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('pins identity and denies scan-policy overrides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openpacker-codex-security-'));
  const cli = join(directory, 'codex-security.js');
  const capture = join(directory, 'args.json');
  const manifest = join(directory, 'package.json');
  await writeFile(
    manifest,
    JSON.stringify({ name: '@openai/codex-security', dependencies: {} }),
  );
  await writeFile(
    cli,
    `const { writeFileSync } = require('node:fs');
if (process.argv[2] === 'info') {
  console.log('{"cliVersion":"0.1.14","sdkVersion":"0.1.14","bundledPluginVersion":"0.1.20","codexVersion":"0.148.0-alpha.8"}');
} else {
  writeFileSync(${JSON.stringify(capture)}, process.argv.slice(2).join('\\n'));
}
`,
  );

  try {
    const environment = { ...process.env, CODEX_SECURITY_BIN: cli };
    const accepted = spawnSync(
      process.execPath,
      ['scripts/codex-security.mjs', '--dry-run'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: environment,
      },
    );
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
    const args = await readFile(capture, 'utf8');
    assert.match(args, /approval_policy="on-request"/u);
    assert.match(args, /--mode\ndeep/u);
    assert.match(args, /--auth\nchatgpt/u);
    assert.match(args, /--fail-on-severity\nlow/u);

    for (const override of [
      '--codex=model="other"',
      '--plugin-path=plugin.zip',
      '--auth=api-key',
      '--fail-on-severity=critical',
      '--path=packages/contracts',
    ]) {
      const denied = spawnSync(
        process.execPath,
        ['scripts/codex-security.mjs', override],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: environment,
        },
      );
      assert.notEqual(denied.status, 0);
    }

    await rm(capture);
    await writeFile(
      manifest,
      JSON.stringify({
        name: '@openai/codex-security',
        dependencies: { 'extract-zip': '2.0.1' },
      }),
    );
    const vulnerable = spawnSync(
      process.execPath,
      ['scripts/codex-security.mjs', '--dry-run'],
      { cwd: process.cwd(), encoding: 'utf8', env: environment },
    );
    assert.notEqual(vulnerable.status, 0);
    assert.match(
      vulnerable.stderr,
      /must not depend on vulnerable extract-zip/u,
    );
    await assert.rejects(readFile(capture, 'utf8'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

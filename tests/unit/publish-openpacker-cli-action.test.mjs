import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const action = readFileSync(
  join(root, '.github/actions/publish-openpacker-cli/action.yml'),
  'utf8',
);

/** First composite step script, with the YAML block indent removed. */
function installScript(source) {
  const marker = '      run: |\n';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1);
  const body = source.slice(start + marker.length);
  const end = body.search(/\n {4}- name: /u);
  assert.notEqual(end, -1);
  return body
    .slice(0, end)
    .split('\n')
    .map((line) => (line.startsWith('        ') ? line.slice(8) : line))
    .join('\n');
}

test('publish action installs npm 11.21.1 without the bundled self-upgrade', () => {
  const script = installScript(action);
  assert.equal(script.includes('npm install -g'), false);
  assert.equal(script.includes('npm install --global'), false);
  assert.match(script, /npm_version="11\.21\.1"/u);
  assert.match(
    script,
    /registry\.npmjs\.org\/npm\/-\/npm-\$\{npm_version\}\.tgz/u,
  );
  assert.match(
    script,
    /sha512-YTzL6QBEJXyHcTu0JiUc7RKMp\+mzlJtl7rGLmERaXUQeFHIMc9atdr6G9M9C8vDWbv40epoTQAzNL2\/PtZVDhQ==/u,
  );
  assert.match(script, /test "\$\(npm --version\)" = "11\.21\.1"/u);
  const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('publish action keeps the OIDC npmrc and does not store the token', () => {
  assert.match(
    action,
    /\/\/registry\.npmjs\.org\/:_authToken=\$\{NODE_AUTH_TOKEN\}/u,
  );
  assert.match(
    action,
    /printf '%s\\n' 'registry=https:\/\/registry\.npmjs\.org\/' > "\$npmrc"/u,
  );
  assert.match(action, /unset NPM_TOKEN_INPUT/u);
  assert.match(
    action,
    /echo "NPM_CONFIG_USERCONFIG=\$\{npmrc\}" >> "\$GITHUB_ENV"/u,
  );
  assert.equal(action.includes('NPM_TOKEN_INPUT" >> "$GITHUB_ENV"'), false);
  assert.equal(action.includes('NODE_AUTH_TOKEN" >> "$GITHUB_ENV"'), false);
});

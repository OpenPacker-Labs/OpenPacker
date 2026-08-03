import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('mise backend pins its contract and all required hooks', async () => {
  const [metadata, manifest, list, install, environment, library] =
    await Promise.all([
      read('metadata.lua'),
      read('mise.plugin.toml'),
      read('hooks/backend_list_versions.lua'),
      read('hooks/backend_install.lua'),
      read('hooks/backend_exec_env.lua'),
      read('lib/openpacker.lua'),
    ]);
  assert.match(metadata, /name = "openpacker"/);
  assert.match(manifest, /min_mise_version = "2026\.7\.13"/);
  assert.match(list, /BackendListVersions/);
  assert.match(list, /"enumerate"/);
  assert.match(install, /BackendInstall/);
  assert.match(install, /"materialize"/);
  assert.doesNotMatch(install, /--target/);
  assert.match(environment, /BackendExecEnv/);
  assert.doesNotMatch(library, /archiver\.decompress/);
  assert.match(install, /--install-prefix/);
  assert.match(library, /safe materialization manifest/);
  assert.match(library, /lifecycleScriptsExecuted = false/);
  assert.doesNotMatch(
    [list, install, environment, library].join('\n'),
    /npm install|cargo install|dotnet tool install/,
  );
});

#!/usr/bin/env node
/**
 * Print the one line that puts this checkout's `opm` and `opmx` on PATH.
 *
 * Printed rather than written: this edits a shell rc file, which belongs to the
 * user and not to a build script.
 */
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve(import.meta.dirname, '..');
const hook = join(root, 'tools/shell/openpacker-env.sh');
const binDir = join(root, 'tools/dev-bin');
const shell = process.env.SHELL ?? '';
const rc = shell.endsWith('zsh') ? '~/.zshrc' : '~/.bashrc';

if (!existsSync(hook)) {
  console.error(`missing ${hook}`);
  process.exit(1);
}

console.log(`
opm and opmx from this checkout: ${binDir}

Add this to ${rc}, then open a new terminal:

  source ${hook}

They are then on PATH whenever the shell is inside ${root},
and off it again elsewhere. Each run rebuilds first if any workspace source is
newer than the built CLI, so you always get the current tree.

Prefer direnv? Make your own .envrc — it is gitignored, because .envrc is a
common home for secrets and agent:check refuses to stage anything matching
.env*:

  echo 'PATH_add tools/dev-bin' > .envrc && direnv allow

One-off, without any setup:

  ${join(binDir, 'opm')} --help

Escape hatches:

  OPENPACKER_DEV_NO_BUILD=1 opm ...   run whatever is built, skip the check
  npm run build                        build everything by hand
`);

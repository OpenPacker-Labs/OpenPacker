#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadTools, removeScratch } from './tools.mjs';

const USAGE = `Usage: node generate.mjs <oracle|all> --pnpm <dir> --npm <dir> [--write | --check]
  <oracle>      the <name> of an oracle-<name>.mjs file beside this one (README.md lists them), or all
  --pnpm <dir>  the unpacked pnpm 10.28.0 package (has bin/pnpm.cjs)
  --npm <dir>   the unpacked npm 10.9.4 package (has node_modules/@npmcli/map-workspaces)
  --check       regenerate and fail if the committed file differs (the default)
  --write       regenerate and replace the committed file`;

function optionValue(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

/** Every oracle module beside this script: each exports `oracle = { name, file, generate }`. */
async function oracles() {
  const names = readdirSync(import.meta.dirname)
    .filter((entry) => /^oracle-.+\.mjs$/u.test(entry))
    .sort();
  return Promise.all(
    names.map(async (entry) => (await import(`./${entry}`)).oracle),
  );
}

async function main(args) {
  const pnpm = optionValue(args, '--pnpm');
  const npm = optionValue(args, '--npm');
  const known = await oracles();
  const wanted =
    args[0] === 'all'
      ? known
      : known.filter((oracle) => oracle.name === args[0]);
  if (pnpm === undefined || npm === undefined || wanted.length === 0) {
    console.error(USAGE);
    return 2;
  }
  const write = args.includes('--write');
  const tools = loadTools(resolve(pnpm), resolve(npm));
  let status = 0;
  for (const oracle of wanted) {
    const fresh = await oracle.generate(tools);
    if (write) {
      writeFileSync(oracle.file, `${JSON.stringify(fresh, null, 2)}\n`);
      console.log(`wrote ${oracle.name}: ${oracle.file.pathname}`);
    } else if (
      isDeepStrictEqual(JSON.parse(readFileSync(oracle.file, 'utf8')), fresh)
    ) {
      console.log(`${oracle.name}: identical to the committed file`);
    } else {
      console.error(
        `${oracle.name}: differs from the committed file; run with --write, then prettier, and review the diff`,
      );
      status = 1;
    }
  }
  return status;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} finally {
  removeScratch();
}

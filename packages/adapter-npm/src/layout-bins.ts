/**
 * Executables for `node_modules/.bin`, without symlinks.
 *
 * npm links `.bin/<name>` to the package's script. OpenPacker's layout never
 * creates a symlink, so each executable is a few lines of shell that run the
 * script the package's `bin` field names with the interpreter its shebang
 * asks for. The script is addressed relative to the shim, so a project moved
 * on disk, or one `.bin` found through a relative `PATH`, still works.
 *
 * `package.json` is registry-controlled input. A bin name is a file name and a
 * bin target is a path that ends up quoted inside a shell script, so both are
 * validated here rather than escaped and trusted.
 */

import { lstat, open, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

export interface PackageBin {
  /** File name under `.bin`. */
  name: string;
  /** Script path inside the package, POSIX, never leaving it. */
  target: string;
}

export interface Interpreter {
  program: string;
  args: readonly string[];
}

const BIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._~+-]*$/u;
const INTERPRETER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const INTERPRETER_ARG = /^-{1,2}[A-Za-z0-9][A-Za-z0-9._=:+-]*$/u;
const MAX_PACKAGE_JSON_BYTES = 4 * 1024 * 1024;

/** The executables a package declares, and the declarations refused. */
export async function readPackageBins(
  packageDirectory: string,
  packageName: string,
): Promise<{
  bins: PackageBin[];
  refused: { name: string; reason: string }[];
}> {
  let parsed: { bin?: unknown };
  try {
    const path = join(packageDirectory, 'package.json');
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_PACKAGE_JSON_BYTES)
      return { bins: [], refused: [] };
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    parsed = JSON.parse(await readFile(path, 'utf8')) as { bin?: unknown };
  } catch {
    return { bins: [], refused: [] };
  }
  const declared: [string, unknown][] = [];
  if (typeof parsed.bin === 'string')
    declared.push([packageName.split('/').at(-1)!, parsed.bin]);
  else if (
    typeof parsed.bin === 'object' &&
    parsed.bin !== null &&
    !Array.isArray(parsed.bin)
  )
    declared.push(...Object.entries(parsed.bin));

  const bins: PackageBin[] = [];
  const refused: { name: string; reason: string }[] = [];
  for (const [name, target] of declared) {
    if (!BIN_NAME.test(name)) {
      refused.push({ name, reason: 'not a safe file name for .bin' });
      continue;
    }
    const cleaned = cleanTarget(target);
    if (cleaned === undefined) {
      refused.push({
        name,
        reason: 'its target is not a path inside the package',
      });
      continue;
    }
    if (!(await isRegularFile(join(packageDirectory, ...cleaned.split('/'))))) {
      refused.push({ name, reason: `its target ${cleaned} is not a file` });
      continue;
    }
    bins.push({ name, target: cleaned });
  }
  return { bins, refused };
}

function cleanTarget(target: unknown): string | undefined {
  if (typeof target !== 'string') return undefined;
  if (/[\0\r\n\\]/u.test(target)) return undefined;
  if (target === '' || target.startsWith('/')) return undefined;
  const normal = posix.normalize(target);
  if (normal === '.' || normal === '..' || normal.startsWith('../'))
    return undefined;
  return normal;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

/** The interpreter a script's first line asks for; node when it asks for none. */
export async function interpreterFor(scriptPath: string): Promise<Interpreter> {
  let head = '';
  try {
    const file = await open(scriptPath, 'r');
    try {
      const buffer = Buffer.alloc(256);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await file.close();
    }
  } catch {
    return NODE;
  }
  return parseShebang(head.split('\n', 1)[0] ?? '');
}

const NODE: Interpreter = { program: 'node', args: [] };

/** `#!/usr/bin/env -S node --flag` and `#!/bin/sh` → program and arguments. */
export function parseShebang(line: string): Interpreter {
  const match = /^#!\s*(\S+)(?:\s+(.*))?$/u.exec(line.replace(/\r$/u, ''));
  if (!match) return NODE;
  let tokens = [match[1]!, ...(match[2]?.trim().split(/\s+/u) ?? [])].filter(
    (token) => token !== '',
  );
  if (posix.basename(tokens[0]!) === 'env') {
    tokens = tokens.slice(1);
    if (tokens[0] === '-S') tokens = tokens.slice(1);
  }
  const program = posix.basename(tokens[0] ?? '');
  if (program === '' || !INTERPRETER_TOKEN.test(program)) return NODE;
  if (program === 'node' || program === 'nodejs')
    return {
      program: 'node',
      args: tokens.slice(1).filter((arg) => INTERPRETER_ARG.test(arg)),
    };
  return {
    program,
    args: tokens.slice(1).filter((arg) => INTERPRETER_ARG.test(arg)),
  };
}

/**
 * The POSIX shim. `relative` is validated by `readPackageBins` and the package
 * name by the planner; it is single-quoted so nothing in it is interpreted.
 */
export function renderPosixShim(
  relative: string,
  interpreter: Interpreter,
): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return [
    '#!/bin/sh',
    '# Written by OpenPacker. The package is addressed relative to this file.',
    'basedir=$(dirname "$0")',
    `exec ${[interpreter.program, ...interpreter.args].map(quote).join(' ')} "$basedir"${quote(`/${relative}`)} "$@"`,
    '',
  ].join('\n');
}

/** The Windows shim, written next to the POSIX one when the host is Windows. */
export function renderCmdShim(
  relative: string,
  interpreter: Interpreter,
): string {
  const target = relative.replaceAll('/', '\\');
  return [
    '@ECHO off',
    'SETLOCAL',
    `${[interpreter.program, ...interpreter.args].join(' ')} "%~dp0\\${target}" %*`,
    '',
  ].join('\r\n');
}

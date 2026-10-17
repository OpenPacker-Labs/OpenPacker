import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** The versions the golden files are generated with. A different version is refused, never guessed at. */
export const PINNED = {
  pnpm: '10.28.0',
  npm: '10.9.4',
  mapWorkspaces: '4.0.2',
  glob: '10.4.5',
  semver: '7.7.2',
  pnpmSemver: '7.7.3',
};

function versionOf(directory) {
  return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    .version;
}

function expect(what, directory, wanted) {
  const found = versionOf(directory);
  if (found !== wanted)
    throw new Error(
      `${what} at ${directory} is ${found}; the golden files are generated with ${wanted}`,
    );
}

/**
 * The two tools, from the package directories given on the command line.
 * Nothing here installs anything: pnpm is run as a program in a throwaway home
 * over a throwaway tree, and npm's libraries are only read.
 */
export function loadTools(pnpmDirectory, npmDirectory) {
  expect('pnpm', pnpmDirectory, PINNED.pnpm);
  const required = createRequire(join(npmDirectory, 'package.json'));
  expect('npm', npmDirectory, PINNED.npm);
  const modules = join(npmDirectory, 'node_modules');
  expect(
    '@npmcli/map-workspaces',
    join(modules, '@npmcli', 'map-workspaces'),
    PINNED.mapWorkspaces,
  );
  expect('glob', join(modules, 'glob'), PINNED.glob);
  expect('semver', join(modules, 'semver'), PINNED.semver);
  const pnpmSemver = join(pnpmDirectory, 'dist', 'node_modules', 'semver');
  expect('the semver pnpm bundles', pnpmSemver, PINNED.pnpmSemver);
  return {
    pnpmBinary: join(pnpmDirectory, 'bin', 'pnpm.cjs'),
    mapWorkspaces: required('@npmcli/map-workspaces'),
    semver: required('semver'),
    pnpmSemver: createRequire(join(pnpmSemver, 'package.json'))('./index.js'),
  };
}

/** Scratch directories made by one run, removed when it ends. */
const scratch = [];

export function scratchDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

export function removeScratch() {
  for (const directory of scratch.splice(0))
    rmSync(directory, { recursive: true, force: true });
}

/**
 * Write a tree. `files` maps a path to an object (written as JSON), a string
 * (written as it is) or `null` (an empty directory).
 */
export function writeTree(root, files) {
  for (const [path, entry] of Object.entries(files)) {
    const place = join(root, path);
    if (entry === null) {
      mkdirSync(place, { recursive: true });
      continue;
    }
    mkdirSync(dirname(place), { recursive: true });
    writeFileSync(
      place,
      typeof entry === 'string' ? entry : JSON.stringify(entry),
    );
  }
}

/**
 * A runner for the pnpm program: an empty home, no network, no version
 * switching. `settings` are extra environment variables, which is how pnpm
 * takes a config setting (`npm_config_<name>`) without a file in the tree.
 */
export function pnpmRunner(binary) {
  const home = scratchDirectory('opm-oracle-home-');
  const environment = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_STATE_HOME: join(home, 'state'),
    npm_config_manage_package_manager_versions: 'false',
    NODE_NO_WARNINGS: '1',
  };
  return (args, directory, settings = {}) => {
    const result = spawnSync(process.execPath, [binary, ...args], {
      cwd: directory,
      env: { ...environment, ...settings },
      encoding: 'utf8',
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
}

/** The directories `pnpm ls --json` printed, relative to `root`, sorted; `''` is the root. */
export function listedDirectories(result, root) {
  if (result.status !== 0)
    throw new Error(
      `pnpm failed (${result.status}): ${result.stderr.slice(0, 300)}`,
    );
  const text = result.stdout.trim();
  const projects = text === '' ? [] : JSON.parse(text);
  return projects.map((project) => project.path.slice(root.length + 1)).sort();
}

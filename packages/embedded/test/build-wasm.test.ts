import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  STUB_MARKER,
  WASM_EXPORTS,
  missingWasmPrerequisites,
  wasmBuildRequired,
  wasmDeclarationStub,
  wasmSkipMessage,
  writeDeclarationStubs,
} from '../scripts/build-wasm.mjs';

const packageRoot = join(import.meta.dirname, '..');
const repoRoot = join(packageRoot, '../..');
const temps: string[] = [];

function temp(): string {
  const directory = mkdtempSync(join(tmpdir(), 'opm-build-wasm-'));
  temps.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temps.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

type Run = (
  command: string,
  args: readonly string[],
) => { status: number | null; stdout: string; error?: Error };

/** A toolchain stand-in: each named tool exits 0, the rest cannot start. */
function toolchain(present: readonly string[], libdir: string): Run {
  return (command, args) => {
    if (!present.includes(command))
      return { status: null, stdout: '', error: new Error('ENOENT') };
    if (command === 'rustc' && args[0] === '--print')
      return { status: 0, stdout: `${libdir}\n` };
    return { status: 0, stdout: `${command} 1.0.0\n` };
  };
}

function populatedLibdir(): string {
  const libdir = temp();
  writeFileSync(join(libdir, 'libcore.rlib'), '');
  return libdir;
}

describe('wasmBuildRequired', () => {
  it('is off on a developer machine', () => {
    expect(wasmBuildRequired({})).toBe(false);
    expect(wasmBuildRequired({ OPENPACKER_REQUIRE_WASM: '0' })).toBe(false);
  });

  it('is on for OPENPACKER_REQUIRE_WASM=1 and for any CI', () => {
    expect(wasmBuildRequired({ OPENPACKER_REQUIRE_WASM: '1' })).toBe(true);
    expect(wasmBuildRequired({ CI: 'true' })).toBe(true);
    expect(wasmBuildRequired({ CI: '1' })).toBe(true);
    expect(wasmBuildRequired({ CI: 'yes' })).toBe(true);
  });

  it('reads CI=false, CI=0 and an empty CI as not CI', () => {
    for (const CI of ['false', 'FALSE', '0', '', '  '])
      expect(wasmBuildRequired({ CI })).toBe(false);
  });

  it('lets no variable switch the requirement off in CI', () => {
    expect(
      wasmBuildRequired({ CI: 'true', OPENPACKER_REQUIRE_WASM: '0' }),
    ).toBe(true);
  });
});

describe('missingWasmPrerequisites', () => {
  it('reports nothing for a complete toolchain', () => {
    const run = toolchain(
      ['rustc', 'cargo', 'wasm-bindgen'],
      populatedLibdir(),
    );
    expect(missingWasmPrerequisites(run, {})).toEqual([]);
  });

  it('names a missing wasm-bindgen alone', () => {
    const run = toolchain(['rustc', 'cargo'], populatedLibdir());
    expect(missingWasmPrerequisites(run, {})).toEqual(['wasm-bindgen']);
  });

  it('names a target whose standard library is not installed', () => {
    const absent = join(temp(), 'wasm32-unknown-unknown', 'lib');
    const empty = temp();
    for (const libdir of [absent, empty])
      expect(
        missingWasmPrerequisites(
          toolchain(['rustc', 'cargo', 'wasm-bindgen'], libdir),
          {},
        ),
      ).toEqual(['the wasm32-unknown-unknown target']);
  });

  it('names both when neither is installed', () => {
    expect(
      missingWasmPrerequisites(toolchain(['rustc', 'cargo'], temp()), {}),
    ).toEqual(['the wasm32-unknown-unknown target', 'wasm-bindgen']);
  });

  it('does not look for a target when there is no Rust at all', () => {
    expect(missingWasmPrerequisites(toolchain([], temp()), {})).toEqual([
      'a Rust toolchain (rustc and cargo)',
      'wasm-bindgen',
    ]);
  });

  it('treats a tool that starts but fails as missing', () => {
    const failing: Run = (command) =>
      command === 'wasm-bindgen'
        ? { status: 1, stdout: '' }
        : { status: 0, stdout: `${populatedLibdir()}\n` };
    expect(missingWasmPrerequisites(failing, {})).toContain('wasm-bindgen');
  });
});

describe('wasmSkipMessage', () => {
  const missing = ['the wasm32-unknown-unknown target', 'wasm-bindgen'];

  it('is one warning line that says how to fix it and how to make it fatal', () => {
    const line = wasmSkipMessage(missing, false);
    expect(line).not.toContain('\n');
    expect(line.startsWith('warning: @openpacker/embedded:')).toBe(true);
    expect(line).toContain(
      'the wasm32-unknown-unknown target and wasm-bindgen',
    );
    expect(line).toContain('rustup target add wasm32-unknown-unknown');
    expect(line).toContain('cargo install --locked wasm-bindgen-cli');
    expect(line).toContain('OPENPACKER_REQUIRE_WASM=1');
  });

  it('pins the installer to the wasm-bindgen version Cargo.lock resolves', () => {
    const lock = readFileSync(join(repoRoot, 'Cargo.lock'), 'utf8');
    const version = /name = "wasm-bindgen"\r?\nversion = "([^"]+)"/u.exec(
      lock,
    )?.[1];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(wasmSkipMessage(missing, false)).toContain(`--version ${version}`);
  });

  it('is one error line when the bindings are required', () => {
    const line = wasmSkipMessage(['wasm-bindgen'], true);
    expect(line).not.toContain('\n');
    expect(line.startsWith('error: @openpacker/embedded:')).toBe(true);
    expect(line).toContain('wasm-bindgen is missing');
    expect(line).not.toContain('target add');
  });
});

describe('declaration stubs', () => {
  it('declare exactly what the Rust crate and EmbeddedBindings export', () => {
    const names = WASM_EXPORTS.map((line: string) => line.split('(')[0]);
    const rust = readFileSync(
      join(repoRoot, 'crates/openpacker-wasm/src/lib.rs'),
      'utf8',
    );
    const exported = [
      ...rust.matchAll(/#\[wasm_bindgen\]\s*pub fn (\w+)/gu),
    ].map((match) => match[1]);
    expect([...names].sort()).toEqual([...exported].sort());

    const source = readFileSync(join(packageRoot, 'src/index.ts'), 'utf8');
    const block = /export interface EmbeddedBindings \{([^}]*)\}/u.exec(
      source,
    )?.[1];
    const declared = [...(block ?? '').matchAll(/^\s+(\w+)\(/gmu)].map(
      (match) => match[1],
    );
    expect([...names].sort()).toEqual([...declared].sort());
  });

  it('carry no code and the web module adds the initializer', () => {
    const node = wasmDeclarationStub('nodejs');
    const web = wasmDeclarationStub('web');
    expect(node.startsWith(STUB_MARKER)).toBe(true);
    expect(node).toContain(
      'export function solve_json(input: string): string;',
    );
    expect(node).not.toContain('export default');
    expect(web).toContain('export default function init');
    expect(web).toContain('export function initSync');
    for (const text of [node, web])
      expect(
        text.split('\n').every((line) => !/^(const|let|var)\b/u.test(line)),
      ).toBe(true);
  });

  it('are written for both targets, and rewritten while they are stubs', () => {
    const directory = temp();
    expect(writeDeclarationStubs(directory)).toHaveLength(2);
    expect(writeDeclarationStubs(directory)).toHaveLength(2);
    expect(
      readFileSync(join(directory, 'dist/cjs/openpacker_wasm.d.ts'), 'utf8'),
    ).toBe(wasmDeclarationStub('nodejs'));
    expect(
      readFileSync(join(directory, 'dist/esm/openpacker_wasm.d.ts'), 'utf8'),
    ).toBe(wasmDeclarationStub('web'));
  });

  it('never replace real wasm-bindgen output', () => {
    const directory = temp();
    mkdirSync(join(directory, 'dist/cjs'), { recursive: true });
    const real = 'export function solve_json(input: string): string;\n';
    writeFileSync(join(directory, 'dist/cjs/openpacker_wasm.d.ts'), real);
    expect(writeDeclarationStubs(directory)).toEqual([
      join(directory, 'dist/esm/openpacker_wasm.d.ts'),
    ]);
    expect(
      readFileSync(join(directory, 'dist/cjs/openpacker_wasm.d.ts'), 'utf8'),
    ).toBe(real);
  });
});

describe('build:wasm without a toolchain', () => {
  /** Run a copy of the script in a scratch repository whose PATH holds nothing. */
  function run(env: Record<string, string>) {
    const scratch = temp();
    const scripts = join(scratch, 'packages/embedded/scripts');
    mkdirSync(scripts, { recursive: true });
    copyFileSync(
      join(packageRoot, 'scripts/build-wasm.mjs'),
      join(scripts, 'build-wasm.mjs'),
    );
    writeFileSync(
      join(scratch, 'Cargo.lock'),
      '[[package]]\nname = "wasm-bindgen"\nversion = "9.8.7"\n',
    );
    const result = spawnSync(
      process.execPath,
      [join(scripts, 'build-wasm.mjs')],
      {
        encoding: 'utf8',
        env: {
          PATH: temp(),
          ...(process.env.SystemRoot && {
            SystemRoot: process.env.SystemRoot,
          }),
          ...env,
        },
      },
    );
    return { ...result, scratch };
  }

  it('warns once and exits 0 by default, leaving type stubs behind', () => {
    const result = run({});
    expect(result.status).toBe(0);
    const lines = result.stderr.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('warning: @openpacker/embedded: skipped');
    expect(lines[0]).toContain('--version 9.8.7');
    for (const dir of ['esm', 'cjs'])
      expect(
        readFileSync(
          join(
            result.scratch,
            'packages/embedded/dist',
            dir,
            'openpacker_wasm.d.ts',
          ),
          'utf8',
        ),
      ).toContain(STUB_MARKER);
  });

  it('warns and exits 0 for CI=false', () => {
    const result = run({ CI: 'false' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('warning:');
  });

  it('fails with one error line for OPENPACKER_REQUIRE_WASM=1', () => {
    const result = run({ OPENPACKER_REQUIRE_WASM: '1' });
    expect(result.status).toBe(1);
    const lines = result.stderr.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('error: @openpacker/embedded:');
  });

  it('fails when CI is set, and writes no stubs for a build it refused', () => {
    const result = run({ CI: 'true' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('error:');
    expect(() =>
      readFileSync(
        join(result.scratch, 'packages/embedded/dist/cjs/openpacker_wasm.d.ts'),
        'utf8',
      ),
    ).toThrow();
  });
});

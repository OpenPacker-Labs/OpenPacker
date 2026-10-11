#!/usr/bin/env node
// Build the wasm-bindgen bindings: dist/esm/openpacker_wasm.* (web) and
// dist/cjs/openpacker_wasm.* (nodejs).
//
// The bindings need the wasm32-unknown-unknown target and wasm-bindgen. A
// machine that only wants the CLI (`opm`, `opmx`, `openpacker`) has neither,
// and the CLI never loads these files, so a missing toolchain is a warning
// there rather than a failed build. CI and release builds must not ship
// without the bindings, so `CI` or OPENPACKER_REQUIRE_WASM=1 turns the same
// condition into an error. A toolchain that is present but fails (a cargo
// error, a wasm-bindgen schema mismatch) is an error in both modes.
//
// A skipped build still writes declaration-only stubs, because three
// workspaces (openpackerd and two examples) import the bindings' types and
// would otherwise stop `npm run build` for everyone. The stubs carry no code:
// importing the module at run time still fails, which is the truth.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../..');
const packageRoot = resolve(import.meta.dirname, '..');

export const WASM_TARGET = 'wasm32-unknown-unknown';

/**
 * What crates/openpacker-wasm exports through #[wasm_bindgen], as wasm-bindgen
 * would declare it. `test/build-wasm.test.ts` holds this list against the Rust
 * source and against `EmbeddedBindings`, so a new export cannot be added to
 * one and forgotten in the others.
 */
export const WASM_EXPORTS = [
  'solve_json(input: string): string',
  'check_json(input: string, output: string): string',
  'validate_universe_json(input: string): void',
  'brute_force_oracle_json(input: string): string',
  'canonicalize_json(input: string): string',
  'digest_json(input: string): string',
  'version_satisfies(version: string, vers: string): boolean',
  'normalize_purl(value: string): string',
  'parse_vers_json(value: string): string',
  'verify_sha256(bytes: Uint8Array, expected: string): boolean',
  'verify_receipt_digest(receipt_json: string, expected: string): boolean',
];

/** First line of a stub, so a later run can tell it from real output. */
export const STUB_MARKER = '// openpacker-wasm-stub: declarations only';

/**
 * Whether a missing toolchain must fail the build.
 *
 * `CI=false` and `CI=0` read as not-CI, the convention other tools follow.
 * There is deliberately no opt-out for CI: a build that cannot ship the
 * bindings must say so.
 */
export function wasmBuildRequired(env) {
  if (env.OPENPACKER_REQUIRE_WASM === '1') return true;
  const ci = env.CI?.trim().toLowerCase();
  return ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false';
}

/**
 * The prerequisites this machine lacks, by name; empty when the build can run.
 *
 * `run` is spawnSync-shaped and injectable. A tool counts as present when it
 * starts and exits 0, which is what the build itself needs of it.
 */
export function missingWasmPrerequisites(run = spawnSync, env = process.env) {
  const probe = (command, args) => {
    const result = run(command, args, {
      cwd: root,
      encoding: 'utf8',
      env,
    });
    return result.error === undefined && result.status === 0
      ? String(result.stdout ?? '')
      : undefined;
  };
  const missing = [];
  if (
    probe('rustc', ['--version']) === undefined ||
    probe('cargo', ['--version']) === undefined
  )
    missing.push('a Rust toolchain (rustc and cargo)');
  else if (!hasWasmTarget(probe)) missing.push(`the ${WASM_TARGET} target`);
  if (probe('wasm-bindgen', ['--version']) === undefined)
    missing.push('wasm-bindgen');
  return missing;
}

/**
 * The target's standard library sits under the active sysroot whether or not
 * rustup manages it, so this holds for a rustup toolchain and a distro one.
 */
function hasWasmTarget(probe) {
  const libdir = probe('rustc', [
    '--print',
    'target-libdir',
    '--target',
    WASM_TARGET,
  ])?.trim();
  return (
    Boolean(libdir) && existsSync(libdir) && readdirSync(libdir).length > 0
  );
}

/** The wasm-bindgen CLI must match the crate Cargo.lock resolves. */
function pinnedBindgenVersion() {
  try {
    const lock = readFileSync(join(root, 'Cargo.lock'), 'utf8');
    return /name = "wasm-bindgen"\r?\nversion = "([^"]+)"/u.exec(lock)?.[1];
  } catch {
    return undefined;
  }
}

function installHint(missing) {
  const steps = [];
  if (missing.some((item) => item.includes('target')))
    steps.push(`rustup target add ${WASM_TARGET}`);
  if (missing.includes('wasm-bindgen')) {
    const version = pinnedBindgenVersion();
    steps.push(
      `cargo install --locked wasm-bindgen-cli${version ? ` --version ${version}` : ''}`,
    );
  }
  return steps.length > 0 ? steps.join(' && ') : undefined;
}

/** The single line printed when the build is skipped or refused. */
export function wasmSkipMessage(missing, required) {
  const what = missing.join(' and ');
  const are = missing.length > 1 ? 'are' : 'is';
  const hint = installHint(missing);
  if (required)
    return `error: @openpacker/embedded: the wasm bindings are required (CI or OPENPACKER_REQUIRE_WASM=1) but ${what} ${are} missing${hint ? `; install with: ${hint}` : ''}`;
  return `warning: @openpacker/embedded: skipped the wasm bindings, ${what} ${are} missing; the CLI is unaffected and dependents compile against type stubs, but importing @openpacker/embedded/wasm-node fails until they are built${hint ? ` (${hint})` : ''}; OPENPACKER_REQUIRE_WASM=1 makes this an error`;
}

/**
 * The declarations a stub holds. `web` is wasm-bindgen's `--target web`
 * module, which adds the asynchronous initializer; `nodejs` is the plain one.
 */
export function wasmDeclarationStub(target) {
  const functions = WASM_EXPORTS.map((line) => `export function ${line};`);
  const init =
    target === 'web'
      ? [
          'export default function init(input?: unknown): Promise<unknown>;',
          'export function initSync(module: unknown): unknown;',
        ]
      : [];
  return [
    STUB_MARKER,
    '// The wasm bindings were not built on this machine (npm run build:wasm',
    '// -w @openpacker/embedded), so there is no openpacker_wasm.js beside this',
    '// file and importing it fails. Building them replaces this file.',
    ...functions,
    ...init,
    '',
  ].join('\n');
}

/** Write each stub unless real wasm-bindgen output already sits there. */
export function writeDeclarationStubs(directory = packageRoot) {
  const written = [];
  for (const [target, outDir] of [
    ['web', 'dist/esm'],
    ['nodejs', 'dist/cjs'],
  ]) {
    const file = join(directory, outDir, 'openpacker_wasm.d.ts');
    if (existsSync(file) && !readFileSync(file, 'utf8').startsWith(STUB_MARKER))
      continue;
    mkdirSync(join(directory, outDir), { recursive: true });
    writeFileSync(file, wasmDeclarationStub(target));
    written.push(file);
  }
  return written;
}

function step(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function build() {
  const targetRoot = process.env.CARGO_TARGET_DIR
    ? resolve(root, process.env.CARGO_TARGET_DIR)
    : join(root, 'target');
  const wasm = join(targetRoot, WASM_TARGET, 'release', 'openpacker_wasm.wasm');
  step(
    'cargo',
    ['build', '-p', 'openpacker-wasm', '--target', WASM_TARGET, '--release'],
    root,
  );
  for (const [target, outDir] of [
    ['web', 'dist/esm'],
    ['nodejs', 'dist/cjs'],
  ])
    step(
      'wasm-bindgen',
      [
        wasm,
        '--target',
        target,
        '--out-dir',
        outDir,
        '--out-name',
        'openpacker_wasm',
      ],
      packageRoot,
    );
}

function main() {
  const missing = missingWasmPrerequisites();
  if (missing.length > 0) {
    const required = wasmBuildRequired(process.env);
    if (!required) writeDeclarationStubs();
    process.stderr.write(`${wasmSkipMessage(missing, required)}\n`);
    process.exit(required ? 1 : 0);
  }
  build();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();

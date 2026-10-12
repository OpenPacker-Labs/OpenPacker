import { describe, expect, it } from 'vitest';
import { OpmError, parseManifest, serializeManifest } from '../src/index.js';
import { pick, seeded } from './type-confusion.js';

/**
 * A manifest is a file in a cloned repository, so the reader meets any text.
 * Every `key = value` of a manifest that holds every field is replaced, one at a
 * time and then in seeded combinations, by a value of each other type or shape,
 * and a section header by names it does not know: the reader either reads the
 * manifest or refuses it with `INVALID_MANIFEST`, and never throws what it did
 * not mean to (a `TypeError` or a `SyntaxError` is written as
 * `opm: internal error: ...`).
 */
const DIGEST = `sha256:${'a'.repeat(64)}`;
const FULL_MANIFEST = [
  '[project]',
  'name = "demo"',
  'ecosystems = ["npm", "cargo"]',
  '',
  '[packages.demo]',
  'purl = "pkg:npm/demo"',
  'version = "1.0.0"',
  'source = "https://registry.npmjs.org/demo/-/demo-1.0.0.tgz"',
  'scope = "runtime"',
  'bin_names = ["demo"]',
  'bin_paths = ["bin/demo.js"]',
  'alias = "demo"',
  '',
  '[registries.mirror]',
  'url = "https://mirror.example.test"',
  'default_for = ["npm"]',
  '',
  '[pack.providers.dev-acme]',
  'manifest = "provider.json"',
  'executable = "bin/provider"',
  'default_for = ["npm"]',
  'allow_environment = ["HOME"]',
  '',
  '[plugins.dev.example-adapter]',
  `store_digest = "${DIGEST}"`,
  'artifact_origins = ["https://plugins.example.test"]',
  'artifact_origin_token_envs = ["PLUGIN_TOKEN"]',
  'artifact_origin_extra_header_names = ["x-api-key"]',
  'artifact_origin_extra_header_envs = ["PLUGIN_KEY"]',
  '',
  '[adapters.packslip]',
  'pin = "abc"',
  'attempts = 3',
  'strict = true',
  'roots = ["a", "b"]',
  '',
  '[adapters.packslip.trust."github.com/a/b"]',
  'identity = "x"',
  '',
  '[options]',
  'offline = false',
  'layout = "opm"',
  'native_projection = "manifest"',
  '',
  '[policy]',
  'allow_yanked = false',
  'allow_quarantined = false',
  'semantic_loss_maximum = "warning"',
  'required_evidence = ["sbom"]',
  'minimum_release_age_minutes = 1440',
  'minimum_release_age_strict = true',
  'minimum_release_age_exclude = ["pkg:npm/a"]',
  'trust_policy = "no-downgrade"',
  'trust_policy_exclude = ["pkg:npm/a"]',
  'block_exotic_transitive = true',
  'block_exotic_direct = false',
  'allow_lifecycle_scripts = false',
  'allowed_lifecycle_script_packages = ["pkg:npm/a"]',
  'expected_registry_id = "https://registry.npmjs.org"',
  '',
  '[sandbox]',
  'enabled = true',
  'mode = "fail-closed"',
  'prefer = "auto"',
  'allow_host_unsandboxed_install = false',
  'project_write = false',
  'minimal_path = true',
  'strict_lifecycle_allowlist = false',
  'allow_dangerous_grants = false',
  'legacy_fat_root = false',
  'timeout_ms = 60000',
  '',
  '[sandbox.packages."pkg:npm/sharp"]',
  'network = true',
  'write = ["a"]',
  'read = ["b"]',
  'env = ["C"]',
  '',
].join('\n');

/** What replaces a value: one of each type or shape a TOML reader might not expect. */
const VALUES: readonly string[] = [
  '""',
  '"x"',
  '"a" "b"',
  '"a\\q"',
  '"unterminated',
  '0',
  '-1',
  '1.5',
  '1e3',
  '0x1F',
  'true',
  'false',
  '[]',
  '["x"]',
  '[1]',
  '[true]',
  '[[]]',
  '[["x"]]',
  '["a" "b"]',
  '["a",]',
  '[,]',
  '[',
  '{ a = 1 }',
  '{}',
  '1979-05-27',
  'nan',
  'inf',
  "'single'",
  '"""multi"""',
  'null',
  '-',
  '"\\u0000"',
  '"\\ud800"',
];

const HEADERS: readonly string[] = [
  '[]',
  '[ ]',
  '[project.x]',
  '[packages.]',
  '[packages.a.b]',
  '[registries.]',
  '[pack.providers.]',
  '[plugins.]',
  '[plugins."x"]',
  '[adapters.]',
  '[adapters.packslip.trust."x"]',
  '[adapters.packslip.trust.5]',
  '[adapters.packslip.trust.""]',
  '[adapters.packslip.trust."\\q"]',
  '[sandbox.packages.]',
  '[sandbox.packages."a\\"]',
  '[[packages]]',
  '[options.x]',
  '[__proto__]',
  '[packages.__proto__]',
];

function outcome(text: string): 'read' | 'refused' | Error {
  try {
    serializeManifest(parseManifest(text));
    return 'read';
  } catch (error) {
    if (
      error instanceof OpmError &&
      (error.code === 'INVALID_MANIFEST' || error.code === 'INVALID_DIGEST')
    )
      return 'refused';
    return error instanceof Error ? error : new Error(String(error));
  }
}

const LINES = FULL_MANIFEST.split('\n');
const ASSIGNMENTS = LINES.flatMap((line, index) =>
  /^[A-Za-z0-9_.-]+ = /u.test(line) ? [index] : [],
);
const HEADER_LINES = LINES.flatMap((line, index) =>
  line.startsWith('[') ? [index] : [],
);

function withValue(lines: readonly string[], index: number, value: string) {
  const copy = [...lines];
  copy[index] = `${copy[index]!.split(' = ')[0]} = ${value}`;
  return copy;
}

describe('the manifest reader', () => {
  it('reads the manifest that holds every field', () => {
    expect(outcome(FULL_MANIFEST)).toBe('read');
  });

  it('has a field for every key the fuzz walks', () => {
    expect(ASSIGNMENTS.length).toBeGreaterThan(55);
    expect(HEADER_LINES.length).toBeGreaterThan(10);
  });

  it('refuses or reads a value of any other type, one field at a time', () => {
    const failures: string[] = [];
    for (const index of ASSIGNMENTS)
      for (const value of VALUES) {
        const result = outcome(withValue(LINES, index, value).join('\n'));
        if (result instanceof Error)
          failures.push(
            `${LINES[index]!.split(' = ')[0]} = ${value}: ${result.name}: ${result.message}`,
          );
      }
    expect(failures).toEqual([]);
  });

  it('refuses or reads a section header it does not know, one at a time', () => {
    const failures: string[] = [];
    for (const index of HEADER_LINES)
      for (const header of HEADERS) {
        const copy = [...LINES];
        copy[index] = header;
        const result = outcome(copy.join('\n'));
        if (result instanceof Error)
          failures.push(
            `${LINES[index]} -> ${header}: ${result.name}: ${result.message}`,
          );
      }
    expect(failures).toEqual([]);
  });

  it('refuses or reads a field that is gone or twice, one at a time', () => {
    const failures: string[] = [];
    for (const index of [...ASSIGNMENTS, ...HEADER_LINES]) {
      const gone = LINES.filter((_, at) => at !== index);
      const twice = [...LINES];
      twice.splice(index, 0, LINES[index]!);
      for (const [what, lines] of [
        ['gone', gone],
        ['twice', twice],
      ] as const) {
        const result = outcome(lines.join('\n'));
        if (result instanceof Error)
          failures.push(
            `${LINES[index]} ${what}: ${result.name}: ${result.message}`,
          );
      }
    }
    expect(failures).toEqual([]);
  });

  it('refuses or reads a manifest with several fields of the wrong type, for 4000 seeded draws', () => {
    const random = seeded(0xc0de);
    const failures: string[] = [];
    for (let draw = 0; draw < 4000; draw += 1) {
      let lines: readonly string[] = LINES;
      const edits: string[] = [];
      const count = 2 + Math.floor(random() * 3);
      for (let edit = 0; edit < count; edit += 1) {
        const index = pick(ASSIGNMENTS, random);
        const value = pick(VALUES, random);
        edits.push(`${LINES[index]!.split(' = ')[0]} = ${value}`);
        lines = withValue(lines, index, value);
      }
      const result = outcome(lines.join('\n'));
      if (result instanceof Error)
        failures.push(`${edits.join('; ')}: ${result.name}: ${result.message}`);
    }
    expect(failures.slice(0, 20)).toEqual([]);
  });
});

import type { PolicyInput } from '@openpacker/contracts';
import type {
  NativeProjectionLevel,
  OpmManifest,
  PackageRequirement,
  RegistrySource,
  RequirementScope,
} from './types.js';
import { OpmError } from './types.js';

/**
 * Minimal TOML subset reader/writer for opm.toml.
 * Supports: [section], string/bool/number/array-of-string.
 * [policy] holds committed supply-chain governance (no secret expansion).
 */

export function defaultManifest(name = 'project'): OpmManifest {
  return {
    project: {
      name,
      ecosystems: ['npm', 'cargo', 'pypi'],
    },
    packages: {},
    options: {
      offline: false,
      layout: 'opm',
    },
  };
}

export function serializeManifest(manifest: OpmManifest): string {
  const lines: string[] = [
    '# Open Package Manager project manifest',
    '[project]',
    `name = ${tomlString(manifest.project.name)}`,
    `ecosystems = ${tomlStringArray(manifest.project.ecosystems)}`,
    '',
  ];

  const aliases = Object.keys(manifest.packages).sort();
  if (aliases.length === 0) {
    lines.push('# [packages.<alias>]');
    lines.push('# purl = "pkg:npm/example"');
    lines.push('# version = "1.0.0"');
    lines.push('');
  } else {
    for (const alias of aliases) {
      const pkg = manifest.packages[alias];
      if (!pkg) continue;
      lines.push(`[packages.${escapeKey(alias)}]`);
      lines.push(`purl = ${tomlString(pkg.purl)}`);
      if (pkg.version !== undefined)
        lines.push(`version = ${tomlString(pkg.version)}`);
      if (pkg.source !== undefined)
        lines.push(`source = ${tomlString(pkg.source)}`);
      if (pkg.scope !== undefined && pkg.scope !== 'runtime')
        lines.push(`scope = ${tomlString(pkg.scope)}`);
      if (pkg.bins !== undefined && pkg.bins.length > 0) {
        // bins expressed as parallel arrays for simple TOML subset
        lines.push(
          `bin_names = ${tomlStringArray(pkg.bins.map((b) => b.name))}`,
        );
        lines.push(
          `bin_paths = ${tomlStringArray(pkg.bins.map((b) => b.path))}`,
        );
      }
      lines.push('');
    }
  }

  for (const id of Object.keys(manifest.registries ?? {}).sort()) {
    const source = manifest.registries![id]!;
    lines.push(`[registries.${escapeKey(id)}]`);
    lines.push(`url = ${tomlString(source.url)}`);
    if (source.defaultFor !== undefined && source.defaultFor.length > 0)
      lines.push(`default_for = ${tomlStringArray(source.defaultFor)}`);
    lines.push('');
  }

  lines.push('[options]');
  lines.push(`offline = ${manifest.options.offline ? 'true' : 'false'}`);
  lines.push(`layout = ${tomlString(manifest.options.layout)}`);
  if (manifest.options.nativeProjection !== undefined)
    lines.push(
      `native_projection = ${tomlString(manifest.options.nativeProjection)}`,
    );
  lines.push('');

  if (manifest.policy) {
    lines.push(
      '# Supply-chain / PREX policy (committed; no secrets in registry URLs)',
    );
    lines.push('[policy]');
    const policy = manifest.policy;
    lines.push(`allow_yanked = ${policy.allowYanked ? 'true' : 'false'}`);
    lines.push(
      `allow_quarantined = ${policy.allowQuarantined ? 'true' : 'false'}`,
    );
    lines.push(
      `semantic_loss_maximum = ${tomlString(policy.semanticLossMaximum)}`,
    );
    if (policy.requiredEvidence.length > 0)
      lines.push(
        `required_evidence = ${tomlStringArray(policy.requiredEvidence)}`,
      );
    if (policy.minimumReleaseAgeMinutes !== undefined)
      lines.push(
        `minimum_release_age_minutes = ${policy.minimumReleaseAgeMinutes}`,
      );
    if (policy.minimumReleaseAgeStrict !== undefined)
      lines.push(
        `minimum_release_age_strict = ${policy.minimumReleaseAgeStrict ? 'true' : 'false'}`,
      );
    if (policy.minimumReleaseAgeExclude?.length)
      lines.push(
        `minimum_release_age_exclude = ${tomlStringArray(policy.minimumReleaseAgeExclude)}`,
      );
    if (policy.trustPolicy !== undefined)
      lines.push(`trust_policy = ${tomlString(policy.trustPolicy)}`);
    if (policy.trustPolicyExclude?.length)
      lines.push(
        `trust_policy_exclude = ${tomlStringArray(policy.trustPolicyExclude)}`,
      );
    if (policy.blockExoticSources?.transitive !== undefined)
      lines.push(
        `block_exotic_transitive = ${policy.blockExoticSources.transitive ? 'true' : 'false'}`,
      );
    if (policy.blockExoticSources?.direct !== undefined)
      lines.push(
        `block_exotic_direct = ${policy.blockExoticSources.direct ? 'true' : 'false'}`,
      );
    if (policy.allowLifecycleScripts !== undefined)
      lines.push(
        `allow_lifecycle_scripts = ${policy.allowLifecycleScripts ? 'true' : 'false'}`,
      );
    if (policy.allowedLifecycleScriptPackages?.length)
      lines.push(
        `allowed_lifecycle_script_packages = ${tomlStringArray(policy.allowedLifecycleScriptPackages)}`,
      );
    if (policy.expectedRegistryId !== undefined)
      lines.push(
        `expected_registry_id = ${tomlString(policy.expectedRegistryId)}`,
      );
    lines.push('');
  }

  return lines.join('\n');
}

export function parseManifest(text: string): OpmManifest {
  const manifest = defaultManifest();
  let section: string | undefined;
  let packageAlias: string | undefined;
  const packageScratch = new Map<
    string,
    {
      purl?: string;
      version?: string;
      source?: string;
      bin_names?: string[];
      bin_paths?: string[];
      scope?: RequirementScope;
    }
  >();
  let registryId: string | undefined;
  const registryScratch = new Map<
    string,
    { url?: string; default_for?: string[] }
  >();
  const policyScratch: Record<string, string | boolean | number | string[]> =
    {};
  let hasPolicy = false;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const line = stripComment(raw).trim();
    if (line === '') continue;

    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      const name = header[1] ?? '';
      if (name === 'project' || name === 'options' || name === 'policy') {
        section = name;
        packageAlias = undefined;
        if (name === 'policy') hasPolicy = true;
      } else if (name.startsWith('registries.')) {
        section = 'registries';
        registryId = name.slice('registries.'.length);
        packageAlias = undefined;
        if (!registryScratch.has(registryId))
          registryScratch.set(registryId, {});
      } else if (name.startsWith('packages.')) {
        section = 'packages';
        packageAlias = name.slice('packages.'.length);
        if (!packageScratch.has(packageAlias))
          packageScratch.set(packageAlias, {});
      } else if (name === 'packages') {
        section = 'packages';
        packageAlias = undefined;
      } else {
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unsupported TOML section [${name}] at line ${i + 1}`,
        );
      }
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) {
      throw new OpmError(
        'INVALID_MANIFEST',
        `Invalid TOML assignment at line ${i + 1}: ${raw}`,
      );
    }
    const key = kv[1] ?? '';
    const valueRaw = kv[2] ?? '';
    const value = parseTomlValue(valueRaw, i + 1);

    if (section === 'project') {
      if (key === 'name' && typeof value === 'string')
        manifest.project.name = value;
      else if (key === 'ecosystems' && Array.isArray(value))
        manifest.project.ecosystems = value;
      else
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unknown project field "${key}" at line ${i + 1}`,
        );
    } else if (section === 'options') {
      if (key === 'offline' && typeof value === 'boolean')
        manifest.options.offline = value;
      else if (key === 'layout' && value === 'opm')
        manifest.options.layout = 'opm';
      else if (key === 'native_projection') {
        if (!isProjectionLevel(value))
          throw new OpmError(
            'INVALID_MANIFEST',
            `options.native_projection must be off|manifest|lock|layout (line ${i + 1})`,
          );
        manifest.options.nativeProjection = value;
      } else if (key === 'layout')
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unsupported layout "${String(value)}" (v1 only supports "opm")`,
        );
      else
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unknown options field "${key}" at line ${i + 1}`,
        );
    } else if (section === 'registries') {
      if (registryId === undefined)
        throw new OpmError(
          'INVALID_MANIFEST',
          `Registry field outside [registries.<id>] at line ${i + 1}`,
        );
      const scratch = registryScratch.get(registryId) ?? {};
      if (key === 'url' && typeof value === 'string') scratch.url = value;
      else if (key === 'default_for' && Array.isArray(value))
        scratch.default_for = value;
      else
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unknown registry field "${key}" at line ${i + 1}`,
        );
      registryScratch.set(registryId, scratch);
    } else if (section === 'policy') {
      // A misspelled policy key must not be a silently weaker policy. Every
      // other section rejects unknown fields; the governance section is the
      // last place to make an exception.
      if (!POLICY_KEYS.has(key))
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unknown policy field "${key}" at line ${i + 1}. Known fields: ` +
            `${[...POLICY_KEYS].sort().join(', ')}`,
        );
      policyScratch[key] = value as string | boolean | number | string[];
    } else if (section === 'packages') {
      if (packageAlias === undefined)
        throw new OpmError(
          'INVALID_MANIFEST',
          `Package field outside [packages.<alias>] at line ${i + 1}`,
        );
      const scratch = packageScratch.get(packageAlias) ?? {};
      if (key === 'purl' && typeof value === 'string') scratch.purl = value;
      else if (key === 'version' && typeof value === 'string')
        scratch.version = value;
      else if (key === 'source' && typeof value === 'string')
        scratch.source = value;
      else if (key === 'bin_names' && Array.isArray(value))
        scratch.bin_names = value;
      else if (key === 'bin_paths' && Array.isArray(value))
        scratch.bin_paths = value;
      else if (key === 'scope') {
        if (!isRequirementScope(value))
          throw new OpmError(
            'INVALID_MANIFEST',
            `packages.${packageAlias}.scope must be runtime|development|optional|peer|build (line ${i + 1})`,
          );
        scratch.scope = value;
      } else if (key === 'alias' && typeof value === 'string') {
        // ignore explicit alias; section key wins
      } else
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unknown package field "${key}" at line ${i + 1}`,
        );
      packageScratch.set(packageAlias, scratch);
    } else {
      throw new OpmError(
        'INVALID_MANIFEST',
        `Assignment outside section at line ${i + 1}`,
      );
    }
  }

  for (const [alias, scratch] of packageScratch) {
    if (!scratch.purl) {
      throw new OpmError(
        'INVALID_MANIFEST',
        `Package "${alias}" is missing required purl`,
      );
    }
    const requirement: PackageRequirement = {
      alias,
      purl: scratch.purl,
    };
    if (scratch.version !== undefined) requirement.version = scratch.version;
    if (scratch.source !== undefined) requirement.source = scratch.source;
    if (scratch.scope !== undefined) requirement.scope = scratch.scope;
    if (scratch.bin_names !== undefined || scratch.bin_paths !== undefined) {
      const names = scratch.bin_names ?? [];
      const paths = scratch.bin_paths ?? [];
      if (names.length !== paths.length) {
        throw new OpmError(
          'INVALID_MANIFEST',
          `Package "${alias}" bin_names/bin_paths length mismatch`,
        );
      }
      requirement.bins = names.map((name, index) => ({
        name,
        path: paths[index] ?? '',
      }));
    }
    manifest.packages[alias] = requirement;
  }

  if (registryScratch.size > 0) {
    const registries: Record<string, RegistrySource> = {};
    for (const [id, scratch] of registryScratch) {
      if (!scratch.url)
        throw new OpmError(
          'INVALID_MANIFEST',
          `Registry "${id}" is missing required url`,
        );
      registries[id] = {
        id,
        url: scratch.url,
        ...(scratch.default_for === undefined
          ? {}
          : { defaultFor: scratch.default_for }),
      };
    }
    manifest.registries = registries;
  }

  if (hasPolicy) manifest.policy = policyFromScratch(policyScratch);

  return manifest;
}

/** Every field accepted under [policy], with the type it must have. */
const POLICY_FIELD_TYPES: Readonly<
  Record<string, 'boolean' | 'string' | 'number' | 'string[]'>
> = {
  allow_yanked: 'boolean',
  allow_quarantined: 'boolean',
  semantic_loss_maximum: 'string',
  required_evidence: 'string[]',
  minimum_release_age_minutes: 'number',
  minimum_release_age_strict: 'boolean',
  minimum_release_age_exclude: 'string[]',
  trust_policy: 'string',
  trust_policy_exclude: 'string[]',
  block_exotic_transitive: 'boolean',
  block_exotic_direct: 'boolean',
  allow_lifecycle_scripts: 'boolean',
  allowed_lifecycle_script_packages: 'string[]',
  expected_registry_id: 'string',
};

const POLICY_KEYS = new Set(Object.keys(POLICY_FIELD_TYPES));

function policyFromScratch(
  scratch: Record<string, string | boolean | number | string[]>,
): PolicyInput {
  // A wrong-typed policy value is refused rather than dropped: silently
  // ignoring `minimum_release_age_minutes = "1440"` leaves the project running
  // with no release-age window while opm.toml says it has one.
  for (const [key, value] of Object.entries(scratch)) {
    const expected = POLICY_FIELD_TYPES[key];
    if (expected === undefined)
      throw new OpmError('INVALID_MANIFEST', `Unknown policy field "${key}"`);
    const actual = Array.isArray(value) ? 'string[]' : typeof value;
    if (expected !== actual)
      throw new OpmError(
        'INVALID_MANIFEST',
        `policy.${key} must be ${expected}, got ${actual}`,
      );
  }

  const bool = (key: string, fallback: boolean): boolean => {
    const value = scratch[key];
    return typeof value === 'boolean' ? value : fallback;
  };
  const str = (key: string): string | undefined => {
    const value = scratch[key];
    return typeof value === 'string' ? value : undefined;
  };
  const num = (key: string): number | undefined => {
    const value = scratch[key];
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;
  };
  const arr = (key: string): string[] | undefined => {
    const value = scratch[key];
    return Array.isArray(value) ? value : undefined;
  };

  const semantic = str('semantic_loss_maximum') ?? 'warning';
  if (semantic !== 'info' && semantic !== 'warning' && semantic !== 'error')
    throw new OpmError(
      'INVALID_MANIFEST',
      `policy.semantic_loss_maximum must be info|warning|error`,
    );

  const trust = str('trust_policy');
  if (trust !== undefined && trust !== 'none' && trust !== 'no-downgrade')
    throw new OpmError(
      'INVALID_MANIFEST',
      `policy.trust_policy must be none|no-downgrade`,
    );

  const policy: PolicyInput = {
    allowYanked: bool('allow_yanked', false),
    allowQuarantined: bool('allow_quarantined', false),
    semanticLossMaximum: semantic,
    requiredEvidence: arr('required_evidence') ?? [],
  };

  const age = num('minimum_release_age_minutes');
  if (age !== undefined) policy.minimumReleaseAgeMinutes = age;
  if (scratch.minimum_release_age_strict !== undefined)
    policy.minimumReleaseAgeStrict = bool('minimum_release_age_strict', false);
  const ageExclude = arr('minimum_release_age_exclude');
  if (ageExclude) policy.minimumReleaseAgeExclude = ageExclude;
  if (trust !== undefined) policy.trustPolicy = trust;
  const trustExclude = arr('trust_policy_exclude');
  if (trustExclude) policy.trustPolicyExclude = trustExclude;

  const blockTransitive = scratch.block_exotic_transitive;
  const blockDirect = scratch.block_exotic_direct;
  if (blockTransitive !== undefined || blockDirect !== undefined) {
    policy.blockExoticSources = {
      ...(typeof blockTransitive === 'boolean'
        ? { transitive: blockTransitive }
        : {}),
      ...(typeof blockDirect === 'boolean' ? { direct: blockDirect } : {}),
    };
  }
  if (scratch.allow_lifecycle_scripts !== undefined)
    policy.allowLifecycleScripts = bool('allow_lifecycle_scripts', false);
  const allowedScripts = arr('allowed_lifecycle_script_packages');
  if (allowedScripts) policy.allowedLifecycleScriptPackages = allowedScripts;
  const registryId = str('expected_registry_id');
  if (registryId !== undefined) {
    // Refuse secret-like env placeholders in committed registry pins (pnpm lesson).
    if (/\$\{[^}]+\}/.test(registryId))
      throw new OpmError(
        'INVALID_MANIFEST',
        'policy.expected_registry_id must not contain ${ENV} expansion (committed config cannot leak secrets via registry settings)',
      );
    policy.expectedRegistryId = registryId;
  }
  return policy;
}

function isRequirementScope(value: unknown): value is RequirementScope {
  return (
    value === 'runtime' ||
    value === 'development' ||
    value === 'optional' ||
    value === 'peer' ||
    value === 'build'
  );
}

function isProjectionLevel(value: unknown): value is NativeProjectionLevel {
  return (
    value === 'off' ||
    value === 'manifest' ||
    value === 'lock' ||
    value === 'layout'
  );
}

function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== '\\') inString = !inString;
    if (ch === '#' && !inString) return line.slice(0, i);
  }
  return line;
}

function parseTomlValue(
  raw: string,
  line: number,
): string | boolean | number | string[] {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) {
      throw new OpmError(
        'INVALID_MANIFEST',
        `Unterminated string at line ${line}`,
      );
    }
    return JSON.parse(value) as string;
  }
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) {
      throw new OpmError(
        'INVALID_MANIFEST',
        `Unterminated array at line ${line}`,
      );
    }
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    // split on commas not inside quotes
    const items: string[] = [];
    let current = '';
    let inString = false;
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i] ?? '';
      if (ch === '"' && inner[i - 1] !== '\\') inString = !inString;
      if (ch === ',' && !inString) {
        items.push(current.trim());
        current = '';
      } else current += ch;
    }
    items.push(current.trim());
    return items.map((item, index) => {
      if (!item.startsWith('"') || !item.endsWith('"')) {
        throw new OpmError(
          'INVALID_MANIFEST',
          `Array item ${index + 1} must be a string at line ${line}`,
        );
      }
      return JSON.parse(item) as string;
    });
  }
  // bare identifier (rare) — treat as string
  if (/^[A-Za-z0-9_./:@%+-]+$/.test(value)) return value;
  throw new OpmError(
    'INVALID_MANIFEST',
    `Unsupported TOML value at line ${line}: ${raw}`,
  );
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map((v) => tomlString(v)).join(', ')}]`;
}

function escapeKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  // quote-style section keys not supported; sanitize
  return key.replace(/[^A-Za-z0-9_-]/g, '_');
}

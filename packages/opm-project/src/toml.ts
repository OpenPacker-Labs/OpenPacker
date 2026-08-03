import type { OpmManifest, PackageRequirement } from './types.js';
import { OpmError } from './types.js';

/**
 * Minimal TOML subset reader/writer for opm.toml.
 * Supports: [section], [section.key], string/bool/array-of-string, dotted keys.
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

  lines.push('[options]');
  lines.push(`offline = ${manifest.options.offline ? 'true' : 'false'}`);
  lines.push(`layout = ${tomlString(manifest.options.layout)}`);
  lines.push('');
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
    }
  >();

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const line = stripComment(raw).trim();
    if (line === '') continue;

    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      const name = header[1] ?? '';
      if (name === 'project' || name === 'options') {
        section = name;
        packageAlias = undefined;
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
      else if (key === 'layout')
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unsupported layout "${String(value)}" (v1 only supports "opm")`,
        );
      else
        throw new OpmError(
          'INVALID_MANIFEST',
          `Unknown options field "${key}" at line ${i + 1}`,
        );
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
      else if (key === 'alias' && typeof value === 'string') {
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

  return manifest;
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
): string | boolean | string[] {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
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

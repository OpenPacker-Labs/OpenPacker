import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CatalogPackage, OpmCatalog } from './types.js';
import { OpmError } from './types.js';

export async function loadCatalogFile(
  path: string,
): Promise<{ catalog: OpmCatalog; baseDir: string }> {
  const text = await readFile(path, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new OpmError(
      'INVALID_CATALOG',
      `Catalog ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OpmError('INVALID_CATALOG', `Catalog ${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new OpmError(
      'INVALID_CATALOG',
      `Unsupported catalog schemaVersion in ${path}`,
    );
  }
  if (
    typeof record.packages !== 'object' ||
    record.packages === null ||
    Array.isArray(record.packages)
  ) {
    throw new OpmError(
      'INVALID_CATALOG',
      `Catalog ${path} packages must be an object`,
    );
  }
  const packages: Record<string, CatalogPackage> = {};
  for (const [key, raw] of Object.entries(
    record.packages as Record<string, unknown>,
  )) {
    if (typeof raw !== 'object' || raw === null) continue;
    const pkg = raw as Record<string, unknown>;
    if (
      typeof pkg.purl !== 'string' ||
      typeof pkg.version !== 'string' ||
      typeof pkg.digest !== 'string' ||
      typeof pkg.size !== 'number' ||
      typeof pkg.format !== 'string' ||
      typeof pkg.mediaType !== 'string' ||
      typeof pkg.source !== 'string'
    ) {
      throw new OpmError(
        'INVALID_CATALOG',
        `Catalog entry ${key} is incomplete in ${path}`,
      );
    }
    if (
      pkg.format !== 'tar' &&
      pkg.format !== 'tar+gzip' &&
      pkg.format !== 'zip'
    ) {
      throw new OpmError(
        'INVALID_CATALOG',
        `Catalog entry ${key} has bad format`,
      );
    }
    const bins = Array.isArray(pkg.bins)
      ? pkg.bins.map((b) => {
          if (typeof b !== 'object' || b === null) {
            throw new OpmError('INVALID_CATALOG', `Bad bins in ${key}`);
          }
          const bin = b as Record<string, unknown>;
          if (typeof bin.name !== 'string' || typeof bin.path !== 'string') {
            throw new OpmError('INVALID_CATALOG', `Bad bins in ${key}`);
          }
          return { name: bin.name, path: bin.path };
        })
      : undefined;
    const entry: CatalogPackage = {
      purl: pkg.purl,
      version: pkg.version,
      digest: pkg.digest,
      size: pkg.size,
      format: pkg.format,
      mediaType: pkg.mediaType,
      source: pkg.source,
    };
    if (bins !== undefined) entry.bins = bins;
    packages[key] = entry;
    // also index by purl field
    packages[pkg.purl] = entry;
  }
  return { catalog: { schemaVersion: 1, packages }, baseDir: dirname(path) };
}

export async function loadCatalogs(paths: readonly string[]): Promise<{
  packages: Map<string, CatalogPackage & { resolvedSource: string }>;
}> {
  const packages = new Map<
    string,
    CatalogPackage & { resolvedSource: string }
  >();
  for (const path of paths) {
    try {
      const { catalog, baseDir } = await loadCatalogFile(path);
      for (const [key, entry] of Object.entries(catalog.packages)) {
        const resolvedSource = resolveSource(entry.source, baseDir);
        packages.set(key, { ...entry, resolvedSource });
        packages.set(entry.purl, { ...entry, resolvedSource });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  return { packages };
}

export function resolveSource(source: string, baseDir: string): string {
  if (source.startsWith('file:')) {
    // file:/rel, file:///abs, file://localhost/abs
    if (source.startsWith('file://') || source.startsWith('file:/')) {
      try {
        // absolute file URLs
        if (
          source.startsWith('file:///') ||
          source.startsWith('file://localhost/')
        ) {
          return fileURLToPath(source);
        }
        if (source.startsWith('file://')) {
          // file://host/path — unusual; fall through
        } else {
          // file:/maybe-relative — Node accepts file:/abs
          const rest = source.slice('file:'.length);
          if (isAbsolute(rest)) return rest;
          return resolve(baseDir, rest);
        }
      } catch {
        // fall through
      }
    }
    const rest = source.slice('file:'.length);
    if (isAbsolute(rest)) return rest;
    return resolve(baseDir, rest);
  }
  if (source.startsWith('https:') || source.startsWith('http:')) return source;
  if (isAbsolute(source)) return source;
  return resolve(baseDir, source);
}

export function toFileUrl(path: string): string {
  return pathToFileURL(resolve(path)).href;
}

export function joinCatalogPath(baseDir: string, relative: string): string {
  return join(baseDir, relative);
}

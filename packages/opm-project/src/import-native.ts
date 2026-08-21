/**
 * One-shot ingest of native project files into `opm.toml`.
 *
 * Adapters already know how to `detect` + `readRequirements`. This command
 * writes those requirements into the opm manifest and stops. It does not
 * solve, install, or bind native files as later authority — `opm.toml` is
 * authoritative after import (ADR 0034).
 */

import { access } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { requireAdapterRegistry } from './adapters.js';
import {
  assertSafeSegment,
  assertStableProjectMetadataSupported,
  MANIFEST_NAME,
  projectPaths,
} from './paths.js';
import { initProject, writeManifestFile } from './project.js';
import { aliasFromNativeName, stripPurlVersion } from './spec.js';
import { defaultManifest } from './toml.js';
import type { OpmManifest, PackageRequirement } from './types.js';
import { OpmError } from './types.js';

export interface NativeImportResult {
  manifestPath: string;
  imported: readonly {
    alias: string;
    purl: string;
    ecosystem: string;
    range?: string;
  }[];
  ecosystems: readonly string[];
}

export async function importNativeProject(input: {
  root: string;
  force?: boolean;
}): Promise<NativeImportResult> {
  assertStableProjectMetadataSupported();
  const root = resolve(input.root);
  const paths = projectPaths(root);

  let exists = false;
  try {
    await access(paths.manifest);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists && !input.force)
    throw new OpmError(
      'INVALID_MANIFEST',
      `${MANIFEST_NAME} already exists at ${paths.manifest}. Pass --force to replace it from native project files.`,
    );

  const registry = requireAdapterRegistry();
  const packages: Record<string, PackageRequirement> = {};
  const imported: NativeImportResult['imported'][number][] = [];
  const ecosystems = new Set<string>();
  const usedAliases = new Set<string>();

  for (const module of registry.list()) {
    if (!module.project) continue;
    const format = module.project();
    const detected = await format.detect(root);
    if (!detected) continue;
    ecosystems.add(format.purlType);
    const requirements = await format.readRequirements(detected);
    for (const requirement of requirements) {
      const alias = uniqueAlias(requirement.name, format.purlType, usedAliases);
      usedAliases.add(alias);
      const entry: PackageRequirement = {
        alias,
        purl: stripPurlVersion(requirement.purl),
      };
      if (requirement.range !== undefined && requirement.range !== '')
        entry.version = requirement.range;
      if (requirement.scope !== undefined && requirement.scope !== 'runtime')
        entry.scope = requirement.scope;
      packages[alias] = entry;
      imported.push({
        alias,
        purl: entry.purl,
        ecosystem: format.purlType,
        ...(entry.version === undefined ? {} : { range: entry.version }),
      });
    }
  }

  if (ecosystems.size === 0)
    throw new OpmError(
      'NOT_FOUND',
      `No native project files found in ${root}.`,
    );

  const name = basename(root) || 'project';
  const manifest: OpmManifest = {
    ...defaultManifest(name),
    project: {
      name,
      ecosystems: [...ecosystems].sort(),
    },
    packages,
  };

  if (!exists) await initProject({ root, name });
  await writeManifestFile(paths.manifest, manifest);

  return {
    manifestPath: paths.manifest,
    imported,
    ecosystems: [...ecosystems].sort(),
  };
}

function uniqueAlias(
  nativeName: string,
  ecosystem: string,
  used: ReadonlySet<string>,
): string {
  const base = assertSafeSegment(
    aliasFromNativeName(nativeName),
    'package alias',
  );
  if (!used.has(base)) return base;
  const qualified = assertSafeSegment(
    aliasFromNativeName(`${nativeName}-${ecosystem}`),
    'package alias',
  );
  if (!used.has(qualified)) return qualified;
  throw new OpmError(
    'INVALID_SPEC',
    `Native import produced duplicate alias "${base}" for ${ecosystem} package "${nativeName}"`,
  );
}

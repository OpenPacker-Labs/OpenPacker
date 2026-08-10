/**
 * `go.mod` as a PREX project format.
 *
 * `go.mod` is neither JSON, TOML nor XML — it is a small line-oriented format
 * with `require` either as a single line or as a parenthesised block. Both
 * shapes are edited in place; the block is preferred for new entries because
 * that is what `go mod tidy` produces.
 *
 * Go has one dependency class. `// indirect` marks a module nothing in the
 * main module imports directly, which is the closest thing to a scope and is
 * preserved rather than invented.
 */

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DetectedProject,
  NativeRequirement,
  ProjectFormat,
  ProjectionResult,
  WriteManifestOptions,
} from '@openpacker/adapter-core';
import type { SemanticLoss } from '@openpacker/contracts';
import {
  matchFileStyle,
  readTextFile,
  writeFileAtomic,
} from '@openpacker/project-io';

export class GolangProjectFormat implements ProjectFormat {
  readonly providerId = 'org.openpacker.project.golang';
  readonly purlType = 'golang' as const;

  async detect(root: string): Promise<DetectedProject | undefined> {
    const manifestPath = join(root, 'go.mod');
    try {
      await access(manifestPath);
    } catch {
      return undefined;
    }
    return {
      root,
      manifestPath,
      relatedPaths: { lock: join(root, 'go.sum') },
    };
  }

  async readRequirements(
    project: DetectedProject,
  ): Promise<readonly NativeRequirement[]> {
    const text = await readFile(project.manifestPath, 'utf8');
    return requireLines(text).map(({ module, version }) => ({
      purl: `pkg:golang/${module
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/')}`,
      name: module,
      range: version,
      scope: 'runtime' as const,
    }));
  }

  async writeManifest(
    project: DetectedProject,
    requirements: readonly NativeRequirement[],
    options: WriteManifestOptions = {},
  ): Promise<ProjectionResult> {
    const semanticLoss: SemanticLoss[] = [];
    const wanted = new Map<string, string>();
    for (const requirement of requirements) {
      if (requirement.scope !== 'runtime') {
        // `go.mod` has no second dependency list to put this in, and a test
        // dependency there would be indistinguishable from a shipped one.
        semanticLoss.push(scopeLoss(requirement));
        continue;
      }
      // Go requires a full semantic version, not a range; a bare range would
      // make `go mod` reject the file.
      wanted.set(requirement.name, goVersion(requirement.range));
    }
    const retire = new Set(options.retire ?? []);

    const file = await readTextFile(project.manifestPath);
    const lines = file.text.split('\n');
    const seen = new Set<string>();
    const kept: string[] = [];

    for (const line of lines) {
      const parsed = parseRequireLine(line);
      if (!parsed) {
        kept.push(line);
        continue;
      }
      if (wanted.has(parsed.module)) {
        seen.add(parsed.module);
        const version = wanted.get(parsed.module)!;
        kept.push(
          line.replace(/(^\s*(?:require\s+)?\S+\s+)\S+/u, `$1${version}`),
        );
        continue;
      }
      if (retire.has(parsed.module)) continue;
      kept.push(line);
    }

    const additions = [...wanted.entries()].filter(
      ([module]) => !seen.has(module),
    );
    const body =
      additions.length === 0
        ? kept
        : insertRequires(
            kept,
            additions.map(([module, version]) => `\t${module} ${version}`),
          );

    const next = matchFileStyle(file, body.join('\n'));
    if (next === file.text) return { written: [], semanticLoss };
    await writeFileAtomic(project.manifestPath, next);
    return { written: [project.manifestPath], semanticLoss };
  }
}

interface RequireEntry {
  module: string;
  version: string;
}

/** Every `require`d module, from either the single-line or block form. */
function requireLines(text: string): RequireEntry[] {
  const out: RequireEntry[] = [];
  for (const line of text.split('\n')) {
    const parsed = parseRequireLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * A module/version pair on this line, if there is one.
 *
 * Only lines that look like a module path and a `v`-prefixed version count, so
 * `go 1.22`, `module example.com/x` and `)` are left alone.
 */
function parseRequireLine(line: string): RequireEntry | undefined {
  const match =
    /^\s*(?:require\s+)?([A-Za-z0-9._~/-]+\.[A-Za-z0-9._~/-]+)\s+(v\S+)/u.exec(
      line,
    );
  if (!match) return undefined;
  if (/^\s*(?:module|go|toolchain|replace|exclude|retract)\b/u.test(line))
    return undefined;
  return { module: match[1]!, version: match[2]! };
}

/** Put new requires inside the block form, adding one if the file has none. */
function insertRequires(
  lines: readonly string[],
  additions: readonly string[],
): string[] {
  const open = lines.findIndex((line) => /^\s*require\s*\(\s*$/u.test(line));
  if (open !== -1) {
    const close = lines.findIndex(
      (line, index) => index > open && /^\s*\)\s*$/u.test(line),
    );
    const at = close === -1 ? lines.length : close;
    return [...lines.slice(0, at), ...additions, ...lines.slice(at)];
  }
  const trailing = lines.at(-1) === '' ? [''] : [];
  const body = trailing.length > 0 ? lines.slice(0, -1) : [...lines];
  return [...body, '', 'require (', ...additions, ')', ...trailing];
}

/**
 * A version `go.mod` will accept.
 *
 * Go modules are pinned, not ranged; `v0.0.0` is the placeholder `go mod tidy`
 * itself writes when it has nothing better, and it is honest about opm not
 * having resolved one.
 */
function goVersion(range: string | undefined): string {
  if (range === undefined || range === '' || range === '*') return 'v0.0.0';
  return range.startsWith('v') ? range : `v${range}`;
}

function scopeLoss(requirement: NativeRequirement): SemanticLoss {
  return {
    code: 'NATIVE_SCOPE_UNSUPPORTED',
    severity: 'warning',
    sourceEcosystem: 'golang',
    sourcePath: `/packages/${requirement.name}/scope`,
    originalMeaning: `${requirement.name} is declared with scope "${requirement.scope}"`,
    representedMeaning: 'The requirement was not written to go.mod',
    omittedMeaning:
      'go.mod has a single require list; a development dependency there would be indistinguishable from a shipped one',
    mitigation:
      'Declare the package as runtime, or keep it out of the Go module.',
    blocksProfile: ['native-validated-v1'],
  };
}

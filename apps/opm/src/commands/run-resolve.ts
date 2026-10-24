/**
 * Which executable `opm exec` starts, and what it says when there is none
 * (ADR 0047, ADR 0053).
 */
import type { BinProviderReport } from '@openpacker/opm-project';
import type { RunContext } from './run-context.js';
import { plain, RunError } from './run-error.js';
import { resolveBin, type BinResolution } from './run-paths.js';

/**
 * The first runnable `bin` in `binDirs`. Nothing is searched on `PATH`, with
 * one exception: `node`, with no `node` in any `.bin`, is the Node that is
 * running `opm`. That is not a search. It is the program `opm` already trusts
 * and is made of, nothing the environment can substitute, and a one-line
 * `exec node ...` is how a script calls it (ADR 0053).
 */
export async function resolveExecutable(
  bin: string,
  binDirs: readonly string[],
  context: RunContext,
): Promise<BinResolution> {
  const resolution = await resolveBin(bin, binDirs, {
    platform: context.platform,
    pathext: context.env.PATHEXT,
    probe: context.probe,
  });
  if (resolution.found === undefined && bin === 'node')
    return { ...resolution, found: context.execPath ?? process.execPath };
  return resolution;
}

function describeProviders(
  report: BinProviderReport,
  bin: string,
  plainLine: (text: string) => string,
): string[] {
  if (!report.locked)
    return [
      'This is not an opm project with a lock, so there is nothing to say about which package provides it.',
    ];
  if (report.providers.length === 0)
    return [
      `No package in opm.lock.json provides "${bin}". Add one with: opm add <purl>`,
    ];
  const lines = report.providers.slice(0, 5).map((provider) => {
    const how =
      provider.evidence === 'declared'
        ? 'declares it'
        : 'has that name, so it likely does';
    return `${plainLine(provider.alias)} (${plainLine(provider.purl)}), ${provider.direct ? 'a direct requirement' : 'a dependency'}, ${how}`;
  });
  const first = report.providers[0];
  const next =
    report.projection === 'layout'
      ? 'Run: opm sync   (it writes node_modules/.bin)'
      : 'Set native_projection = "layout" under [options] in opm.toml, then run: opm sync';
  return [
    'The lock would provide it through:',
    ...lines.map((line) => `  ${line}`),
    next,
    ...(first?.evidence === 'declared'
      ? [`Or run it inside the sandbox with: opmx ${bin}`]
      : []),
  ];
}

/** The failure for a bin that is in no `.bin` directory, with the lock's account of who would provide it. */
export async function missingBinError(
  root: string,
  bin: string,
  resolution: BinResolution,
): Promise<RunError> {
  // The lock is only read to explain a failure, so the library that reads it
  // is loaded only then: a bin that is found never pays for it.
  const { findBinProviders } = await import('@openpacker/opm-project');
  const report = await findBinProviders(root, bin);
  const plainLine = await plain();
  return new RunError(
    'NOT_FOUND',
    [
      `"${bin}" is not in node_modules/.bin of ${plainLine(root)} or any parent directory; exec never fetches or searches PATH`,
      ...resolution.present.map(
        (file) => `${plainLine(file)} exists but is not executable`,
      ),
      ...describeProviders(report, bin, plainLine),
    ].join('\n'),
  );
}

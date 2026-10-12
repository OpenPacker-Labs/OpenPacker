/**
 * Which executable `opm exec` starts, and what it says when there is none
 * (ADR 0047, ADR 0053).
 */
import type { BinProviderReport } from '@openpacker/opm-project';
import type { RunContext } from './run-context.js';
import { RunError } from './run-error.js';
import { resolveBin, type BinResolution } from './run-paths.js';

/**
 * The first runnable `bin` in `binDirs`. Nothing is searched on `PATH`: a
 * program that is not in a `.bin` directory is not found.
 */
export async function resolveExecutable(
  bin: string,
  binDirs: readonly string[],
  context: RunContext,
): Promise<BinResolution> {
  return await resolveBin(bin, binDirs, {
    platform: context.platform,
    pathext: context.env.PATHEXT,
    probe: context.probe,
  });
}

function describeProviders(report: BinProviderReport, bin: string): string[] {
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
    return `${provider.alias} (${provider.purl}), ${provider.direct ? 'a direct requirement' : 'a dependency'}, ${how}`;
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
  return new RunError(
    'NOT_FOUND',
    [
      `"${bin}" is not in node_modules/.bin of ${root} or any parent directory; exec never fetches or searches PATH`,
      ...resolution.present.map(
        (file) => `${file} exists but is not executable`,
      ),
      ...describeProviders(report, bin),
    ].join('\n'),
  );
}

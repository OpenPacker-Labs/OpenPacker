/**
 * Lines `opm` and `opmx` print from what a registry, a lock or a package wrote
 * (a purl, a version, an alias, a reason): each goes through `say`, which
 * escapes what a terminal would act on.
 */

import { say } from './error-report.js';

interface Io {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

/** One line each: `opm search`'s purls, `opm versions`' versions, `opm why`'s answer. */
export function writeLines(lines: readonly string[], io: Io): void {
  for (const line of lines) say(io.stdout, `${line}\n`);
}

/** `opm list`: one row per package of the project's lock. */
export function writeInstalled(
  rows: readonly {
    alias: string;
    purl: string;
    digest: string;
    installed: boolean;
    bins: readonly string[];
    installedAs: readonly string[];
  }[],
  io: Io,
): void {
  for (const row of rows) {
    const digest =
      row.digest.length > 15 ? `${row.digest.slice(0, 15)}…` : row.digest;
    const status = row.installed ? 'installed' : 'not-installed';
    const bins = row.bins.length > 0 ? ` bins=[${row.bins.join(',')}]` : '';
    const names =
      row.installedAs.length > 0 ? ` as=[${row.installedAs.join(',')}]` : '';
    say(
      io.stdout,
      `${row.alias}\t${row.purl}\t${digest}\t${status}${bins}${names}\n`,
    );
  }
}

/** opmx's line naming the tool an ephemeral run started, and whether it was cached. */
export function writeToolRan(io: Io, exactPurl: string, cached: boolean): void {
  say(io.stderr, `opmx: ${exactPurl}${cached ? ' (cached)' : ''}\n`);
}

/** `opm run` with no script: each script of a `package.json` and its command, on one line. */
export function writeScripts(
  scripts: Iterable<readonly [string, unknown]>,
  io: Io,
): void {
  let listed = 0;
  for (const [name, command] of scripts)
    if (typeof command === 'string') {
      say(io.stdout, `${name}\t${command.replace(/\r?\n/gu, '\\n')}\n`);
      listed += 1;
    }
  if (listed === 0) io.stdout.write('(no scripts)\n');
}

/**
 * Report the ecosystem project files opm maintained, and anything it could not
 * promise about them. Silence here would hide edits to files the user tracks
 * in version control.
 */
export function writeNativeProjection(
  report:
    | {
        projections: readonly {
          ecosystem: string;
          written: readonly string[];
          skipped?: readonly { path: string; reason: string }[];
          semanticLoss: readonly {
            code: string;
            representedMeaning?: string;
          }[];
        }[];
      }
    | undefined,
  io: Io,
): void {
  if (!report) return;
  for (const projection of report.projections) {
    for (const path of projection.written)
      say(io.stdout, `  updated ${path}\n`);
    for (const entry of projection.skipped ?? [])
      say(io.stderr, `opm: skipped ${entry.path}: ${entry.reason}\n`);
    for (const loss of projection.semanticLoss)
      say(
        io.stderr,
        `opm: ${loss.code}${loss.representedMeaning ? `: ${loss.representedMeaning}` : ''}\n`,
      );
  }
}

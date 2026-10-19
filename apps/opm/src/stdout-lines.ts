import { plainLine } from '@openpacker/canonical';

/**
 * Lines `opm list` and `opm import --native` write to stdout.
 *
 * Nothing sits between those commands and the stream, and what they print came
 * from a repository's files (an alias, a PURL, a version range, a bin name), so
 * each value is made one line with no escape sequence in it where it is printed.
 * The tabs and line feeds between the values are opm's own.
 */

/** One row of `opm list`. */
export function listLine(row: {
  alias: string;
  purl: string;
  digest: string;
  installed: boolean;
  bins: readonly string[];
<<<<<<< ours
  installedAs: readonly string[];
=======
  /** The names under node_modules it is installed as, when not its own (ADR 0054). */
  installedAs?: readonly string[];
>>>>>>> theirs
}): string {
  const digest = plainLine(
    row.digest.length > 15 ? `${row.digest.slice(0, 15)}…` : row.digest,
  );
  const status = row.installed ? 'installed' : 'not-installed';
  const bins =
    row.bins.length > 0
      ? ` bins=[${row.bins.map((bin) => plainLine(bin)).join(',')}]`
      : '';
  const names =
<<<<<<< ours
    row.installedAs.length > 0
=======
    row.installedAs !== undefined && row.installedAs.length > 0
>>>>>>> theirs
      ? ` as=[${row.installedAs.map((name) => plainLine(name)).join(',')}]`
      : '';
  return `${plainLine(row.alias)}\t${plainLine(row.purl)}\t${digest}\t${status}${bins}${names}\n`;
}

/** The heading of `opm import --native`. */
export function importHeading(count: number, manifestPath: string): string {
  return `Imported ${count} requirement(s) from native project files into ${plainLine(manifestPath)}\n`;
}

/** One requirement `opm import --native` read. */
export function importLine(item: {
  alias: string;
  purl: string;
  range?: string | undefined;
  ecosystem: string;
}): string {
  const range = item.range !== undefined ? `@${plainLine(item.range)}` : '';
  return `  ${plainLine(item.alias)}\t${plainLine(item.purl)}${range}\t${plainLine(item.ecosystem)}\n`;
}

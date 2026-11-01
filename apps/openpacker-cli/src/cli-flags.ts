/**
 * How `opm` reads a flag on its command line: the long name of a short one,
 * and which flags take no value.
 */

/** The long name of a one-letter flag (`-w` is `--workspace`, `-F` is `--filter`). */
export function shortToLong(short: string): string {
  switch (short) {
    case 'e':
      return 'ecosystem';
    case 'h':
      return 'help';
    case 'w':
      return 'workspace';
    case 'F':
      return 'filter';
    default:
      return short;
  }
}

/** Whether a flag takes no value, so the word after it is not read as its value. */
export function isBooleanFlag(key: string): boolean {
  return (
    key === 'help' ||
    key === 'force' ||
    key === 'offline' ||
    key === 'online' ||
    key === 'json' ||
    key === 'dry-run' ||
    key === 'delegate' ||
    key === 'allow-build' ||
    key === 'allow-network' ||
    key === 'allow-elevation' ||
    key === 'latest' ||
    key === 'if-present' ||
    key === 'native' ||
    key === 'shared' ||
    key === 'production' ||
    key === 'frozen' ||
    key === 'workspaces' ||
    key === 'no-workspaces' ||
    key === 'include-workspace-root' ||
    key === 'plan' ||
    key === 'write' ||
    key === 'isolate'
  );
}

/**
 * What a host cannot do, said before anything is opened or run.
 *
 * The sandbox's stable-path guarantee is built from descriptors: a directory
 * is bound by the descriptor that was checked, and an approved executable is
 * run from the descriptor that was hashed. Linux gives an open file a path the
 * kernel will resolve and execute (`/proc/self/fd/N`). macOS does not
 * (`/dev/fd/N` is a descriptor filesystem whose children resolve to nothing,
 * ADR 0045), Node has no `fexecve`, and Windows has no equivalent. A refusal
 * names the platform, the missing piece and what to do instead, so a run never
 * ends in a late `ENOENT` from a path that was never going to resolve.
 */

export function platformLabel(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform;
}

/** Why an executable snapshot cannot be run here, or undefined when it can. */
export function executableAuthorityRefusal(
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'linux') return undefined;
  const label = platformLabel(platform);
  const missing =
    platform === 'darwin'
      ? 'macOS has no fexecve and no path that names an open descriptor (/dev/fd/N is a descriptor filesystem, ADR 0045)'
      : `${label} has no path that names an open descriptor`;
  return (
    `Cannot run an approved executable snapshot on ${label}: it is executed from the descriptor that was hashed, ` +
    `and only Linux gives that descriptor a path the kernel will execute (/proc/self/fd/N). ${missing}, ` +
    'and Node cannot fexecve. Copying the bytes to a named file would leave a path another process could swap ' +
    'between the check and the run, so nothing is run. Run this on a Linux host.'
  );
}

/**
 * The sentence that follows a refusal to contain a package run, or undefined
 * where containment exists (ADR 0036, "macOS/Windows containment withdrawal").
 */
export function containmentWithdrawnNote(
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'linux') return undefined;
  const label = platformLabel(platform);
  return (
    `Package-exec containment is withdrawn on ${label} (ADR 0036): the only backend that holds the stable ` +
    'directory handles every run requires is Bubblewrap on Linux. Run this on a Linux host, or run a tool ' +
    'you have reviewed and installed in this project with `opm exec <bin>`, which runs with your own ' +
    'authority and no jail (ADR 0047).'
  );
}

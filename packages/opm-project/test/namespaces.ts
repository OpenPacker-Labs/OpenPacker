import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Real namespaces for the tests that need a process or a mount of another
 * place than this one. The command is tried as the user is (root) and then
 * through an unprivileged user namespace, so a CI runner that is not root still
 * has them; a machine that refuses both skips the test with a warning, or fails
 * it where `OPM_REQUIRE_NAMESPACES=1` says the proof must be there.
 */

const works = (argv: string[]) =>
  spawnSync(argv[0]!, [...argv.slice(1), 'true'], { stdio: 'ignore' })
    .status === 0;

const first = (candidates: string[][]): string[] | undefined =>
  process.platform === 'linux' ? candidates.find(works) : undefined;

/** `unshare …` options that start the next command as pid 1 of a new PID namespace. */
export const pidNamespace = first([
  ['unshare', '--pid', '--fork', '--mount-proc'],
  ['unshare', '--user', '--map-root-user', '--pid', '--fork', '--mount-proc'],
]);

/** `unshare …` options that start the next command in a mount namespace of its own. */
export const mountNamespace = first([
  ['unshare', '--mount'],
  ['unshare', '--user', '--map-root-user', '--mount'],
]);

/**
 * `describe` when `command` is available; a skipped suite with a warning when
 * it is not; a failing one when `OPM_REQUIRE_NAMESPACES=1`.
 */
export function describeNamespaced(
  name: string,
  command: string[] | undefined,
  body: () => void,
): void {
  if (command !== undefined) {
    describe(name, body);
    return;
  }
  if (process.env.OPM_REQUIRE_NAMESPACES === '1') {
    describe(name, () => {
      it('needs a namespace this machine refuses', () => {
        expect.fail(
          'OPM_REQUIRE_NAMESPACES=1, but `unshare` is refused here (as root and through a user namespace)',
        );
      });
    });
    return;
  }
  if (process.platform === 'linux')
    console.warn(
      `${name}: \`unshare\` is refused here (as root and through a user namespace); skipped. OPM_REQUIRE_NAMESPACES=1 makes this a failure.`,
    );
  describe.skip(name, body);
}

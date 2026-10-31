/**
 * What `npm`, `pnpm` and `yarn` inside `opm run` refuse, and the opm command
 * each refusal names (ADR 0061). Only a script is run; every other command
 * of those tools is refused here, never handed on to the tool.
 */
import { RunError } from './run-error.js';

export type ForeignTool = 'npm' | 'pnpm' | 'yarn';

const INSTALL =
  'install the lock with opm ci, or add a dependency with opm add <spec>';
const CI = 'install the lock with opm ci';
const REMOVE = 'remove a dependency with opm remove <alias|purl>';
const UPDATE = 'update with opm update';
const EXEC =
  'start an installed executable with opm exec <bin>, or fetch a package into the sandbox with opmx <package>';
const FETCH = 'fetch a package and run it in the sandbox with opmx <package>';
const LIST = 'list the dependencies with opm list';
const WHY = 'ask why a package is installed with opm why <name>';
const INFO = 'read a release with opm info <purl>';
const PUBLISH = 'publish with opm publish';
const PACK = 'pack with opm pack npm';
const INIT = 'start a project with opm init';

function table(
  entries: readonly [readonly string[], string][],
): ReadonlyMap<string, string> {
  return new Map(
    entries.flatMap(([names, hint]) => names.map((name) => [name, hint])),
  );
}

/** npm's commands other than the four that run a script, with their aliases. */
const NPM = table([
  [
    [
      'install',
      'i',
      'in',
      'ins',
      'inst',
      'insta',
      'instal',
      'isnt',
      'isnta',
      'isntal',
      'isntall',
      'add',
    ],
    INSTALL,
  ],
  [['ci', 'clean-install', 'ic', 'install-clean', 'isntall-clean'], CI],
  [
    [
      'install-test',
      'it',
      'install-ci-test',
      'cit',
      'clean-install-test',
      'sit',
    ],
    'install the lock with opm ci, then run opm run test',
  ],
  [['uninstall', 'unlink', 'remove', 'rm', 'r', 'un'], REMOVE],
  [['update', 'up', 'upgrade', 'udpate'], UPDATE],
  [['exec', 'x'], EXEC],
  [['ls', 'list', 'la', 'll'], LIST],
  [['explain', 'why'], WHY],
  [['search', 'find', 's', 'se'], 'search a registry with opm search <query>'],
  [['view', 'info', 'show', 'v'], INFO],
  [['publish'], PUBLISH],
  [['pack'], PACK],
  [['init', 'create', 'innit'], INIT],
]);

/** pnpm's commands, so that a word that is one is not taken for a script. */
const PNPM = table([
  [['install', 'i', 'add', 'install-test', 'it'], INSTALL],
  [['remove', 'rm', 'uninstall', 'un'], REMOVE],
  [['update', 'up', 'upgrade'], UPDATE],
  [['exec'], EXEC],
  [['dlx', 'create'], FETCH],
  [['list', 'ls', 'll', 'la'], LIST],
  [['why'], WHY],
  [['view', 'info', 'show', 'v'], INFO],
  [['publish'], PUBLISH],
  [['pack'], PACK],
  [['init'], INIT],
  [
    [
      'approve-builds',
      'audit',
      'bin',
      'c',
      'cat-file',
      'cat-index',
      'ci',
      'completion',
      'config',
      'dedupe',
      'deploy',
      'doctor',
      'env',
      'fetch',
      'find-hash',
      'get',
      'help',
      'ignored-builds',
      'import',
      'licenses',
      'link',
      'ln',
      'm',
      'multi',
      'outdated',
      'patch',
      'patch-commit',
      'patch-remove',
      'prune',
      'rb',
      'rebuild',
      'recursive',
      'root',
      'self-update',
      'server',
      'set',
      'setup',
      'store',
      'unlink',
    ],
    '',
  ],
]);

/** Yarn's commands, classic and Berry's, so that a word that is one is not taken for a script. */
const YARN = table([
  [['install', 'add'], INSTALL],
  [['remove'], REMOVE],
  [['up', 'upgrade', 'upgrade-interactive'], UPDATE],
  [['exec', 'node'], EXEC],
  [['dlx', 'create'], FETCH],
  [['list'], LIST],
  [['why', 'explain'], WHY],
  [['info'], INFO],
  [['publish'], PUBLISH],
  [['pack'], PACK],
  [['init'], INIT],
  [
    ['workspaces'],
    "run a script in every member with opm run --workspaces <script> (npm's order) or opm run -r <script> (dependencies first)",
  ],
  [
    [
      'access',
      'audit',
      'autoclean',
      'bin',
      'cache',
      'check',
      'config',
      'constraints',
      'dedupe',
      'generate-lock-entry',
      'global',
      'help',
      'import',
      'licenses',
      'link',
      'login',
      'logout',
      'npm',
      'outdated',
      'owner',
      'patch',
      'patch-commit',
      'plugin',
      'policies',
      'rebuild',
      'search',
      'set',
      'stage',
      'tag',
      'team',
      'unlink',
      'unplug',
      'version',
      'versions',
    ],
    '',
  ],
]);

const KNOWN: Readonly<Record<ForeignTool, ReadonlyMap<string, string>>> = {
  npm: NPM,
  pnpm: PNPM,
  yarn: YARN,
};

/** What each tool's shim runs, as a refusal says it. */
const RUNS: Readonly<Record<ForeignTool, string>> = {
  npm: 'npm run, npm test, npm start, npm stop and npm restart',
  pnpm: 'pnpm run, test, start, stop, restart and pnpm <script>',
  yarn: 'yarn run <script> and yarn <script> with plain arguments',
};

/** Whether `word` is one of the tool's own commands that the shim refuses. */
export function isRefusedCommand(tool: ForeignTool, word: string): boolean {
  return KNOWN[tool].has(word);
}

/**
 * The refusal of `<tool> <what>`: what the shim runs instead of the tool, and,
 * where opm has one, the command that does the job.
 */
export function refusal(
  tool: ForeignTool,
  what: string,
  why?: string,
): RunError {
  const word = what.split(' ')[0] ?? what;
  const hint = why ?? KNOWN[tool].get(word);
  return new RunError(
    'USAGE',
    `${what === '' ? tool : `${tool} ${what}`} inside opm run: opm runs ${RUNS[tool]} itself and hands nothing to ${tool}; ` +
      (hint === undefined || hint === ''
        ? `opm has no counterpart, so run it outside opm run if it is needed`
        : hint),
  );
}

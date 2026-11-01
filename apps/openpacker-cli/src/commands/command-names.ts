/**
 * The words `opm` answers as commands. Anything else at the start of the
 * command line is a script or an executable of the project (ADR 0053), or an
 * unknown command.
 */
export const COMMANDS: ReadonlySet<string> = new Set([
  'init',
  'import',
  'add',
  'remove',
  'install',
  'ci',
  'uninstall',
  'sync',
  'update',
  'run',
  'exec',
  'list',
  'why',
  'search',
  'versions',
  'info',
  'resolve',
  'manifest',
  'pack',
  'publish',
  'yank',
  'packslip',
  'plugin',
  'auth',
  'system',
  'generations',
  'rollback',
  'recover',
  'gc',
  'shell',
  'help',
]);

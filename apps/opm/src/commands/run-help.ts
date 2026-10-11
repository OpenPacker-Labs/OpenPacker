/** The `opm run` / `opm exec` section of `opm --help` (ADR 0047). */
export const RUN_HELP = `Run your own scripts and installed executables (no registry, no install):
  opm run                                  list the scripts of package.json
  opm run <script> [--if-present] [--path <dir>] [-- <args...>]
  opm exec <bin> [--path <dir>] [-- <args...>]
  run starts "pre<script>", "<script>" and "post<script>" in that order from the
  package.json at the opm project root (--path <dir>: that directory). A hook
  that fails stops the rest. Arguments after -- are appended to the script.
  --if-present exits 0 when the script is not defined.
  exec starts <bin> from node_modules/.bin only: the project root's and each
  parent's. It never fetches anything and never searches PATH. When the bin is
  missing it names the locked package that would provide it and exits 4.
  Both put those .bin directories first on PATH, run with your environment plus
  npm_lifecycle_event, npm_package_name, npm_package_version and INIT_CWD, pass
  stdin/stdout/stderr through, and exit with the child's own status (128 plus
  the signal number when a signal ended it). A script that does not exist exits 4.
  SECURITY: these run YOUR code with YOUR authority. Scripts in your own
  package.json and executables in node_modules/.bin are not sandboxed and do not
  go through the jail that opmx and installs use, exactly as npm run does not.
  A dependency's own lifecycle scripts (preinstall, postinstall) are never run
  by these commands. The environment is passed on, never printed.
`;

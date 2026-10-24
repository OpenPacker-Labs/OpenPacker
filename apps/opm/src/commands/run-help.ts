/** The `opm run` / `opm exec` section of `opm --help` (ADR 0047, ADR 0053). */
export const RUN_HELP = `Run your own scripts and installed executables (no registry, no install):
  opm run                                  list the scripts of package.json
  opm run <script> [--if-present] [--path <dir>] [-- <args...>]
  opm exec <bin> [--path <dir>] [-- <args...>]
  opm <script|bin> [args...]               a word that is no command: that script, else that bin
  run starts "pre<script>", "<script>" and "post<script>" in that order from the
  package.json at the opm project root (--path <dir>: that directory). A hook
  that fails stops the rest. Arguments after -- are appended to the script.
  --if-present exits 0 when the script is not defined.
  A --path straight after <bin> is opm's, as it is before <bin>; the program's
  own arguments are what follows, or what follows --. An argument the program
  calls --path goes after --: opm exec tool --path <dir> -- --path x.
  exec starts <bin> from node_modules/.bin only: the project root's and each
  parent's. It never fetches anything and never searches PATH (node alone is the
  Node that runs opm). When the bin is missing it names the locked package that
  would provide it and exits 4.
  Both put those .bin directories first on PATH, run with your environment plus
  npm_lifecycle_event, npm_package_name, npm_package_version and INIT_CWD, pass
  stdin/stdout/stderr through, and exit with the child's own status (128 plus
  the signal number when a signal ended it). A script that does not exist exits 4.
In a workspace, run and exec take pnpm's and npm's member options (before or after
the command: opm --filter a run build, opm run build --filter a):
  --filter <selector>, -F   pnpm's selectors: name, ./dir, {glob}, name..., ...name, ^, !
  -r, --recursive           every member, dependencies first (the root only with --include-workspace-root)
  -w, --workspace <name|dir>, --workspaces    npm's: directory order, one at a time
  --workspace-root          the workspace root alone
  --workspace-concurrency <n>   members at once (default min(4, processors); 0 every processor, -n that many fewer)
  --parallel                every member at once, streamed, no order
  --no-sort, --reverse, --stream, -C/--dir/--prefix <dir>
  A member without the script is skipped; none having it exits 4. Several members
  print "<member> <script>: <line>", one block per member (--stream: as it comes).
  The first member to fail stops the rest and opm exits with its status.
  dlx and npx are not commands: opm exec <bin> runs an installed bin, opmx <package>
  fetches one.
  SECURITY: these run YOUR code with YOUR authority. Scripts in your own
  package.json and executables in node_modules/.bin are not sandboxed and do not
  go through the jail that opmx and installs use, exactly as npm run does not.
  A dependency's own lifecycle scripts (preinstall, postinstall) are never run
  by these commands. The environment is passed on, never printed.
`;

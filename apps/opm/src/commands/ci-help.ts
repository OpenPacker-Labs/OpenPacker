/**
 * What `opm --help` says of `opm ci` (ADR 0046, ADR 0051, ADR 0055), kept
 * beside the command so the main help does not grow with every option.
 */
export const CI_HELP = `  opm ci [--path <dir>] [--production] [--omit <dev|optional|peer>] [--offline|--online]
         [--workspace|-w <name|dir>]... [--include-workspace-root] [--workspaces[=false]|--no-workspaces]
         [--filter|-F <selector>]... [--os <os>]... [--cpu <cpu>]... [--libc <libc>]...
         [--supported-architectures project] [--plan]
                                      install exactly what package-lock.json or
                                      pnpm-lock.yaml says (a project with both
                                      is installed from the one its packageManager
                                      names); resolves nothing, runs no install
                                      script (opm install --frozen is the same).
                                      A workspace lock links each member to its
                                      directory and gives it its own node_modules;
                                      -w or --filter (pnpm's grammar) installs only
                                      those members and what they need
                                      (--include-workspace-root adds the root's
                                      own dependencies), --workspaces=false only
                                      the root's.
                                      An optional package for another platform is
                                      left out: the machine is this one, unless
                                      --os, --cpu and --libc ('current' is this
                                      machine) or --supported-architectures project
                                      (the project's own pnpm setting) widen it.
                                      --plan reads, checks and plans, and fetches
                                      and writes nothing.`;

import { registryEcosystems } from '@openpacker/opm-project';
import { RUN_HELP } from './run-help.js';

/** The text of `opm help`. */
export function helpText(): string {
  return `opm — Open Package Manager

Usage:
  opm init [--name <name>] [--path <dir>]
  opm import --native [--path <dir>] [--force]
  opm add <spec> [--ecosystem|-e <eco>] [--source <file|url>] [--alias <name>] [--offline|--online]
  opm remove <alias|purl>
  opm install [--offline|--online]
  opm ci [--path <dir>] [--production] [--omit <dev|optional|peer>] [--offline|--online]
         [--workspace|-w <name|dir>]... [--include-workspace-root] [--workspaces[=false]|--no-workspaces]
                                      install exactly what package-lock.json says;
                                      resolves nothing, runs no install script
                                      (opm install --frozen is the same).
                                      A workspace lock links each member to its
                                      directory and gives it its own node_modules;
                                      -w installs only those members and what they
                                      need (--include-workspace-root adds the root's
                                      own dependencies), --workspaces=false only
                                      the root's
  opm uninstall [alias]
  opm sync [--offline|--online]
  opm update [alias...] [--latest] [--offline|--online]
  opm list
  opm why <alias|name|purl>
  opm gc [--keep <n>] [--dry-run]     remove store paths no retained generation uses
  opm gc --shared [--dry-run]         remove entries of the user-level package store
                                      that no project links to
  opm recover [--abandon-step <id>]   finish what a killed opm left; with an id,
                                      take that step as dead (its owner is in
                                      another container or host) and put it back
  Commands that change a project wait for another opm on it: --wait <ms> (or
  OPM_STEP_WAIT_MS), 10000 by default

${RUN_HELP}

Signed vendor releases (packslip — https://packslip.dev):
  opm add packslip:github.com/jdx/hk[@version]    (or packslip:jdx/hk)
  opm packslip verify <spec>                      who signed it; installs nothing
  opm packslip pin <spec> [--write]               hold a keyless project to its signer
  opm packslip approve <proposal-id>              accept one reported signer change
  Trust lives in opm.toml, never in the lock:
    [adapters.packslip.trust."github.com/jdx/hk"]  pin = ["ps1_…"]  (keyless)
    [adapters.packslip.trust."example.com/tool"]   public_key = "RW…"  (key-signed)
  A changed signer stops the resolve and prints a proposal id; nothing is
  accepted until a person approves exactly that change.
  OPM_PACKSLIP_GITHUB_TOKEN_ENV names the variable holding a GitHub token;
  OPM_PACKSLIP_TRUSTED_ROOT points at a Sigstore trusted_root.json.

Browse registries (no project needed):
  opm search <query|purl> [--ecosystem|-e <eco>]
  opm versions <purl> [--ecosystem|-e <eco>]
  opm info <exact-purl> [--ecosystem|-e <eco>]

Resolve a full dependency graph (transitive, proof-checked):
  opm resolve pkg:npm/chalk --range '^4.1.0'
  opm resolve pkg:npm/chalk --candidates 8

Pack a project:
  opm pack npm --package-version <version>
  opm pack <npm|cargo|pypi|nuget|maven|golang|oci|nix|deb|winget|chocolatey> --package-version <version>
  opm pack <purl-type> --package-version <version> --provider <id> --dry-run
  Standard packing is the default. OCI targets require explicit --os and --arch.
  Delegated providers come from [pack.providers.<id>] in opm.toml.
  Provider builds require --allow-build; network additionally requires --allow-network.
  Provider environment is empty unless each name is granted with --allow-env NAME.

Publish to a PREX registry (not npmjs, PyPI, or crates.io):
  opm publish --from <dir> --registry <url>
  opm publish --pack <ecosystem> --package-version <v> --registry <url>
  opm yank <exact-purl> --registry <url> --reason <text>
  OPM_PREX_REGISTRY is the default registry URL. --offline is refused.

Host/profile installers use the same verbs when the registry advertises
install (capability discovery). Examples:
  opm add pkg:nix/hello
  opm add pkg:deb/curl --allow-elevation --dry-run
  opm system available   # alias: list install-capable adapters

Delegated adapter plugins (user-level, never installed by default):
  opm plugin add <name>[@version]     install from the plugin registry
  opm plugin list                     show installed plugins and their pins
  opm plugin remove <name>            remove a plugin and its store entry
  opmx --plugin <name> <tool>         ephemeral-run a plugin-served purl type
  [plugins.<id>] store_digest = "sha256:…" in opm.toml pins an installed
  plugin for this project; optional artifact_origins lists extra HTTPS
  origins the host may fetch this plugin's artifacts from (union with
  OPM_HOST_FETCH_ORIGINS). Optional artifact_origin_token_envs lists
  env-var names (never values) parallel to those origins;
  OPM_HOST_FETCH_TOKEN_ENVS is the process-wide parallel list for
  OPM_HOST_FETCH_ORIGINS. Optional artifact_origin_extra_header_names and
  artifact_origin_extra_header_envs name one extra header per origin
  (for example X-JFrog-Art-Api); OPM_HOST_FETCH_HEADER_NAMES and
  OPM_HOST_FETCH_HEADER_ENVS are the process-wide parallel lists.
  OPM_HOST_FETCH_BEARER is not a grant unless that
  name is listed. The binding never acquires, and project commands fail
  closed when the installed entry digests differently.
  The plugin registry is selected with OPM_REGISTRY_OPM_PLUGIN; the store
  lives at OPM_PLUGIN_HOME or $XDG_DATA_HOME/openpacker/plugins.
  Installed plugins register as adapters at startup; a plugin that fails
  verification is reported on stderr and skipped (its ecosystem stays
  unsupported rather than answering untrusted).

Auth (env names only):
  opm auth set --origin <https-origin> [--token-env <NAME>]
  opm auth list
  opm auth unset --origin <https-origin>
  Remembers which environment variable holds a bearer for a pinned HTTPS origin.
  The file stores names only — never token values. Mint tokens outside opm
  (cloud CLI, gh, vault). No login command, device flow, or --token flag.
  Config: OPM_AUTH_CONFIG or $XDG_CONFIG_HOME/openpacker/auth.json (mode 0600).

Registries (catalog, from adapter discovery): ${registryEcosystems().join(', ') || '(none configured)'}
Host/profile install uses the same verbs when Registry Definition advertises install.

  Override one with OPM_REGISTRY_<ECOSYSTEM>, e.g.
  OPM_REGISTRY_NPM=https://npm.internal.example
  --offline refuses every registry read.

Specs:
  pkg:npm/@scope/name@1.2.3
  lodash@4.17.21 --ecosystem npm
  demo-tool --ecosystem npm --source ./vendor/demo-tool.tgz

opm import --native reads adapter readRequirements (package.json,
Cargo.toml, pyproject.toml, ...) into opm.toml once. Native files stay
non-authoritative: later sync does not re-import them.

An add with no --source and no catalog entry resolves against the ecosystem's
registry and verifies the download against the digest the registry published.

Project files:
  opm.toml          requirements (edit or use opm add/remove)
  opm.lock.json     exact pins (generated)
  .opm/store        content-addressed installs (hard links into the shared store)
  .opm/bin          executable shims (use with opmx or PATH)

Shared package store (one copy of each package per machine, linked into every
project): $XDG_CACHE_HOME/openpacker/store, else ~/.cache/openpacker/store.
OPM_STORE_HOME=/abs/path relocates it; OPM_STORE_HOME=off keeps each project
self-contained. It is used only on the project's own filesystem, where links
are possible. Free what no project uses with: opm gc --shared

Execute installed bins with: opmx <bin|package> [args...]
  Ephemeral: opmx pkg:nuget/dotnet-cowsay@1.3.0
  Ephemeral: opmx pkg:pypi/cowsay

Aliases: opkg, opkgm → opm
Protocol/control plane: openpacker (advanced)
`;
}

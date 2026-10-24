import { OpmError, parseRunTimeout } from '@openpacker/opm-project';

/** opmx's command line: its arguments, its granted environment and its help. */

/**
 * Values for `--allow-env` names, read from the operator's own environment at
 * the moment of consent — mirroring `opm pack --allow-env`: a name is granted
 * explicitly, its value is never written anywhere opm controls.
 */
export function grantedEnvironment(names: readonly string[]) {
  const environment: Record<string, string> = {};
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
      throw new OpmError('USAGE', `Invalid --allow-env name: ${name}`);
    const value = process.env[name];
    if (value === undefined)
      throw new OpmError(
        'USAGE',
        `--allow-env ${name}: the variable is not set in this environment`,
      );
    environment[name] = value;
  }
  return environment;
}

export function parse(argv: string[]) {
  let packageAlias: string | undefined;
  let binName: string | undefined;
  const positionals: string[] = [];
  const passthrough: string[] = [];
  const plugins: string[] = [];
  const allowEnv: string[] = [];
  let offline = false;
  let timeoutMs: number | undefined;
  let allowNetwork = false;
  let i = 0;
  let seenSelector = false;
  while (i < argv.length) {
    const arg = argv[i] ?? '';
    if (arg === '--') {
      passthrough.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--package' || arg === '-p') {
      packageAlias = argv[i + 1];
      i += 2;
      continue;
    }
    if (arg.startsWith('--package=')) {
      packageAlias = arg.slice('--package='.length);
      i += 1;
      continue;
    }
    if (arg === '--plugin') {
      const name = argv[i + 1];
      if (name === undefined || name.startsWith('--'))
        throw new OpmError('USAGE', 'opmx --plugin requires a plugin name');
      plugins.push(name);
      i += 2;
      continue;
    }
    if (arg.startsWith('--plugin=')) {
      const name = arg.slice('--plugin='.length);
      if (name === '')
        throw new OpmError('USAGE', 'opmx --plugin requires a plugin name');
      plugins.push(name);
      i += 1;
      continue;
    }
    if (arg === '--allow-env') {
      const name = argv[i + 1];
      if (name === undefined || name.startsWith('--'))
        throw new OpmError(
          'USAGE',
          'opmx --allow-env requires an environment variable name',
        );
      allowEnv.push(name);
      i += 2;
      continue;
    }
    if (arg.startsWith('--allow-env=')) {
      const name = arg.slice('--allow-env='.length);
      if (name === '')
        throw new OpmError(
          'USAGE',
          'opmx --allow-env requires an environment variable name',
        );
      allowEnv.push(name);
      i += 1;
      continue;
    }
    if (arg === '--timeout') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw new OpmError(
          'USAGE',
          'opmx --timeout requires a number of milliseconds (0 for none)',
        );
      timeoutMs = parseRunTimeout(value, '--timeout');
      i += 2;
      continue;
    }
    if (arg.startsWith('--timeout=')) {
      timeoutMs = parseRunTimeout(arg.slice('--timeout='.length), '--timeout');
      i += 1;
      continue;
    }
    if (arg === '--allow-network') {
      allowNetwork = true;
      i += 1;
      continue;
    }
    if (arg === '--offline') {
      offline = true;
      i += 1;
      continue;
    }
    if (arg === '--bin' || arg === '-c' || arg === '-b') {
      binName = argv[i + 1];
      i += 2;
      continue;
    }
    if (arg.startsWith('--bin=')) {
      binName = arg.slice('--bin='.length);
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      i += 1;
      continue;
    }
    if (!seenSelector && !arg.startsWith('-')) {
      positionals.push(arg);
      seenSelector = true;
      i += 1;
      // Everything after the selector belongs to the tool. A `--` sitting
      // immediately there is the separator itself and must not be forwarded:
      // `opmx tool -- -t x` was handing the tool a literal "--", which any
      // argument parser reads as end-of-options and then fails on the flags
      // that follow.
      if (argv[i] === '--') i += 1;
      passthrough.push(...argv.slice(i));
      break;
    }
    passthrough.push(arg);
    i += 1;
  }
  return {
    ...(packageAlias !== undefined && { packageAlias }),
    ...(binName !== undefined && { binName }),
    positionals,
    passthrough,
    plugins,
    allowEnv,
    offline,
    ...(timeoutMs !== undefined && { timeoutMs }),
    allowNetwork,
  };
}

export function help(): string {
  return `opmx — execute a package binary

From this project's install (needs opm.toml and a prior opm install/sync):
  opmx <package-or-bin> [args...]
  opmx --package <alias> [--bin <name>] -- [args...]
  opmx -p demo-tool -c demo-tool -- --version

Straight from a registry, without installing — the npx/uvx/pipx-run shape.
No project required:
  opmx pkg:npm/json@11.0.0 -- --version
  opmx pkg:npm/json                     # newest published version
  opmx pkg:npm/some-tool --bin other    # when a package ships several

Third-party purl types come from delegated adapter plugins (opm plugin add).
--plugin names an installed plugin to register for this run; it never
installs one:
  opmx --plugin acme pkg:acme/some-tool
  opmx --plugin acme some-tool    # when the plugin serves one purl type
The plugin answers metadata only; the host downloads the tool bytes from the
location the plugin publishes and digest-verifies them before anything runs.
A plugin's declared environment stays unforwarded unless each name is granted
with --allow-env NAME (repeatable). --offline refuses an ephemeral resolve.

A tool runs until it ends or is stopped (Ctrl-C), as with npx, and all it
writes reaches the terminal. --timeout <ms> ends it after that many
milliseconds (0: never). Without it, a project's [sandbox] opmx_timeout_ms
applies, else a [sandbox] timeout_ms it sets, else no limit.

A tool has no network unless it is granted one: it reaches nothing outside
its sandbox, and nothing outside reaches it, a server included.
--allow-network shares this host's network with the run; a project grants a
package for every run with [sandbox.packages."<purl>"] network = true. opmx
says on stderr when a tool listens without it, and on which port.

Tool files are kept once per machine in the shared package store
(OPM_STORE_HOME, default ~/.cache/openpacker/store; OPM_STORE_HOME=off opts out).
Tools live in a content-addressed cache under OPM_TOOL_CACHE (else
XDG_CACHE_HOME, else ~/.cache/openpacker/x). Every run re-resolves the
registry metadata — an unpinned run is a different thing tomorrow — but the
artifact bytes move only when the resolved digest is not already cached: a
repeat run rebuilds from the digest-verified store archive instead of
downloading, and says so with "(cached)". The resolved version is printed to
stderr either way.
`;
}

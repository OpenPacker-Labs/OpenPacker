/**
 * The records `opm` prints from what a registry, a lock, a plugin store or a
 * project's own manifests wrote: an imported requirement, a registry
 * artifact, a plugin pin, a host install's command, a manifest. Each line goes
 * through `say`, which escapes what a terminal would act on (the review of
 * #179, round 5, S2').
 */

import { say } from './error-report.js';

interface Io {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

/** `opm import --native`: the requirements read from the native manifests. */
export function writeImported(
  result: {
    manifestPath: string;
    imported: readonly {
      alias: string;
      purl: string;
      range?: string | undefined;
      ecosystem: string;
    }[];
  },
  io: Io,
): void {
  say(
    io.stdout,
    `Imported ${result.imported.length} requirement(s) from native project files into ${result.manifestPath}\n`,
  );
  for (const item of result.imported) {
    const range = item.range !== undefined ? `@${item.range}` : '';
    say(
      io.stdout,
      `  ${item.alias}\t${item.purl}${range}\t${item.ecosystem}\n`,
    );
  }
}

/** `opm add`: the requirement and the package the lock pinned for it. */
export function writeAdded(
  alias: string,
  purl: string | undefined,
  installName: string | undefined,
  io: Io,
): void {
  say(
    io.stdout,
    `Added ${alias} → ${purl ?? alias}${installName === undefined ? '' : ` (installed as ${installName})`}\n`,
  );
}

/** `opm update`: the requirements whose pins moved. */
export function writeUpdated(updated: readonly string[], io: Io): void {
  say(
    io.stdout,
    updated.length === 0
      ? 'Already up to date\n'
      : `Updated ${updated.length} package(s): ${updated.join(', ')}\n`,
  );
}

/** `opm info`: what the registry says of one exact package. */
export function writeArtifactInfo(
  artifact: {
    exactPurl: string;
    version: string;
    digest: string;
    size: number;
    mediaType: string;
    uri: string;
  },
  io: Io,
): void {
  say(
    io.stdout,
    `${artifact.exactPurl}\n` +
      `  version   ${artifact.version}\n` +
      `  digest    ${artifact.digest}\n` +
      `  size      ${artifact.size} bytes\n` +
      `  mediaType ${artifact.mediaType}\n` +
      `  source    ${artifact.uri}\n`,
  );
}

/** `opm manifest` and `opm pack`: what the builder could not say. */
export function writeLosses(
  losses: readonly { code: string; omittedMeaning?: string | undefined }[],
  io: Io,
): void {
  for (const loss of losses)
    say(io.stderr, `opm: ${loss.code}: ${loss.omittedMeaning ?? ''}\n`);
}

/** `opm plugin add`: the pin the store holds. */
export function writePluginInstalled(
  installed: {
    alreadyInstalled: boolean;
    name: string;
    exactPurl: string;
    id: string;
    storeDigest: string;
    storePath: string;
  },
  io: Io,
): void {
  say(
    io.stdout,
    (installed.alreadyInstalled
      ? `Plugin ${installed.name} is already installed at ${installed.exactPurl}\n`
      : `Installed plugin ${installed.exactPurl}\n`) +
      `  id:     ${installed.id}\n` +
      `  digest: ${installed.storeDigest}\n` +
      `  store:  ${installed.storePath}\n`,
  );
}

/** `opm plugin remove`. */
export function writePluginRemoved(
  removed: { name: string; exactPurl: string },
  io: Io,
): void {
  say(io.stdout, `Removed plugin ${removed.name} (${removed.exactPurl})\n`);
}

/** `opm plugin list`: one row per pin. */
export function writePluginList(
  plugins: readonly {
    name: string;
    exactPurl: string;
    storeDigest: string;
    installedAt: string;
    present: boolean;
  }[],
  io: Io,
): void {
  if (plugins.length === 0) io.stdout.write('(no plugins installed)\n');
  for (const plugin of plugins)
    say(
      io.stdout,
      `${plugin.name}\t${plugin.exactPurl}\t${plugin.storeDigest}\t${plugin.installedAt}${plugin.present ? '' : '  (store entry missing)'}\n`,
    );
}

/** A host install: the native command, what it cannot promise, and whether it needs consent. */
export function writeHostPlan(
  plan: {
    command: readonly string[];
    semanticLoss: readonly {
      code: string;
      representedMeaning?: string | undefined;
    }[];
    requiresElevation?: boolean | undefined;
  },
  elevationAllowed: boolean,
  io: Io,
): void {
  say(io.stdout, `${plan.command.join(' ')}\n`);
  for (const loss of plan.semanticLoss)
    say(io.stderr, `opm: ${loss.code}: ${loss.representedMeaning}\n`);
  if (plan.requiresElevation === true && !elevationAllowed)
    io.stderr.write(
      'opm: host install needs elevation; pass --allow-elevation to consent\n',
    );
}

/** A host install that ran: the package the native tool installed. */
export function writeHostInstalled(
  outcome: { exactPurl: string; installedVersion?: string | undefined },
  io: Io,
): void {
  say(
    io.stdout,
    `Host-installed ${outcome.exactPurl}${outcome.installedVersion ? ` @ ${outcome.installedVersion}` : ''}\n`,
  );
}

/** A document opm prints whole (`opm manifest`, `opm packslip verify --json`). */
export function writeDocument(text: string, io: Io): void {
  say(io.stdout, `${text}\n`);
}

/** `opm pack --dry-run`: the native commands it would run. */
export function writePackCommands(
  ecosystem: string,
  commands: readonly (readonly string[])[],
  cleanup: readonly (readonly string[])[],
  io: Io,
): void {
  if (commands.length === 0) say(io.stdout, `standard ${ecosystem}\n`);
  for (const command of commands) say(io.stdout, `${command.join(' ')}\n`);
  for (const command of cleanup)
    say(io.stdout, `cleanup: ${command.join(' ')}\n`);
}

/** `opm pack`: each archive the native tool produced. */
export function writePackArtifacts(
  artifacts: readonly {
    path: string;
    digest: string;
    size: number;
    nativeRole: string;
  }[],
  io: Io,
): void {
  for (const artifact of artifacts)
    say(
      io.stdout,
      `${artifact.path}\n  ${artifact.digest}  ${artifact.size} bytes  ${artifact.nativeRole}\n`,
    );
}

/** What a provider warned of while it inspected a release. */
export function writeWarnings(
  warnings: readonly { code: string; message: string }[],
  io: Io,
): void {
  for (const warning of warnings)
    say(io.stderr, `opm: ${warning.code}: ${warning.message}\n`);
}

/** `opm packslip verify`: the release, then one labelled fact a line. */
export function writeFacts(
  heading: string,
  facts: readonly (readonly [string, string | undefined])[],
  io: Io,
): void {
  say(io.stdout, `${heading}\n`);
  for (const [label, value] of facts)
    if (value !== undefined && value !== '')
      say(io.stdout, `  ${label.padEnd(12)}${value}\n`);
}

/** `opm publish`: the package and the registry it went to. */
export function writePublished(
  name: string,
  version: string,
  registry: string,
  io: Io,
): void {
  say(
    io.stdout,
    `Published ${name}${version ? `@${version}` : ''} to ${registry}\n`,
  );
}

/** `opm yank`: the version the registry withdrew. */
export function writeYanked(shown: string, io: Io): void {
  say(io.stdout, `Yanked ${shown}\n`);
}

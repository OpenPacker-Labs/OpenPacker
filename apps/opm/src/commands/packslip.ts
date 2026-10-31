import { out, plainLine } from '@openpacker/canonical';
import {
  OpmError,
  exactPurl,
  findOpmRoot,
  listRegistryVersions,
  parsePackageSpec,
  projectPaths,
  projectStep,
  providerFor,
  readLockfile,
  readManifestFile,
  registryOptionsForEcosystem,
  requireOpmRoot,
  stripPurlVersion,
  writeManifestFile,
  type OpmManifest,
  type RegistryOptions,
  type StepOptions,
} from '@openpacker/opm-project';
import { report } from '../error-report.js';
import { cliStep } from './recover.js';

export interface CommandArgs {
  positionals: string[];
  options: Map<string, string | true>;
}

export interface CommandIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

const SUBCOMMANDS = 'verify | pin | approve';

/** JSON, as opm-project types an adapter's settings. */
type Json = NonNullable<OpmManifest['adapterSettings']>[string][string];
type Table = { [key: string]: Json };

function isTable(value: Json | undefined): value is Table {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `opm packslip` — inspect and configure trust in packslip-signed releases.
 *
 *   verify <spec>       resolve a release and show who signed it, without
 *                       installing anything
 *   pin <spec>          show (or with --write, record) the signer fingerprint
 *                       a keyless project should be held to
 *   approve <id>        record a person's approval of one reported trust change
 */
export async function runPackslipCommand(
  args: CommandArgs,
  io: CommandIo,
  cwd: string,
  // The network, injected the way every resolve in opm-project is; the CLI
  // passes nothing and gets the real one.
  transport: RegistryOptions = {},
): Promise<number> {
  const [subcommand, ...rest] = args.positionals;
  const scoped: CommandArgs = { ...args, positionals: rest };
  switch (subcommand) {
    case 'verify':
      return verify(scoped, io, cwd, transport);
    case 'pin':
      return pin(scoped, io, cwd, transport);
    case 'approve':
      return approve(scoped, io, cwd);
    default:
      throw new OpmError(
        'INVALID_SPEC',
        `opm packslip requires a subcommand: ${SUBCOMMANDS}`,
      );
  }
}

interface Release {
  readonly purl: string;
  readonly project: string;
  readonly inspection: Awaited<
    ReturnType<Awaited<ReturnType<typeof providerFor>>['inspect']>
  >;
}

/**
 * Resolve and verify one release with the project's own trust settings when
 * there is a project, and with the defaults a bare invocation gets when there
 * is not. An unpinned spec means the newest the vendor publishes.
 */
async function resolve(
  args: CommandArgs,
  cwd: string,
  subcommand: string,
  transport: RegistryOptions,
): Promise<Release & { manifest?: OpmManifest; root?: string }> {
  const spec = args.positionals[0];
  if (!spec)
    throw new OpmError(
      'INVALID_SPEC',
      `opm packslip ${subcommand} requires a packslip spec: packslip:github.com/jdx/hk[@version]`,
    );
  const parsed = parsePackageSpec(spec, { ecosystem: 'packslip' });
  const root = await findOpmRoot(cwd);
  const manifest =
    root === undefined
      ? undefined
      : await readManifestFile(projectPaths(root).manifest);
  // Only the signer history is wanted from the lock, and a lock that cannot be
  // read is no history; it must not stop a read-only look at a release.
  const lock =
    root === undefined
      ? undefined
      : await readLockfile(projectPaths(root).lock).catch(() => undefined);
  const options = registryOptionsForEcosystem(
    'packslip',
    manifest ?? {},
    { ...transport, offline: args.options.has('offline') },
    lock,
  );
  const base = stripPurlVersion(parsed.purl);
  let version = parsed.version;
  if (version === undefined) {
    const versions = await listRegistryVersions('packslip', base, options);
    const newest = versions.at(-1);
    version = newest?.slice(newest.lastIndexOf('@') + 1);
    if (version === undefined)
      throw new OpmError(
        'UNRESOLVABLE',
        `${base} has no release opm can use on this machine`,
      );
  }
  const purl = exactPurl(base, version);
  const provider = await providerFor('packslip', options, [
    'prex.registry.package-metadata/1',
  ]);
  const inspection = await provider.inspect(purl);
  const project = base.slice('pkg:packslip/'.length).split('?')[0] ?? base;
  return {
    purl,
    project,
    inspection,
    ...(manifest !== undefined && { manifest }),
    ...(root !== undefined && { root }),
  };
}

function signerOf(release: Release): Table {
  const record = release.inspection.attestation?.record;
  const signer = record?.signer;
  return isTable(signer) ? signer : {};
}

function text(value: Json | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function verify(
  args: CommandArgs,
  io: CommandIo,
  cwd: string,
  transport: RegistryOptions,
): Promise<number> {
  const release = await resolve(args, cwd, 'verify', transport);
  const { inspection } = release;
  const attestation = inspection.attestation;
  if (attestation === undefined)
    throw new OpmError(
      'INVALID_PROVIDER_METADATA',
      'The release carried no signature evidence',
    );
  const signer = signerOf(release);
  const executables = (inspection.executables ?? []).map((bin) => bin.name);
  for (const warning of inspection.warnings)
    io.stderr.write(
      report(
        'opm: ',
        `${plainLine(warning.code)}: ${plainLine(warning.message)}`,
      ),
    );

  if (args.options.has('json')) {
    out(
      io,
      `${JSON.stringify(
        {
          purl: release.purl,
          signer: attestation.signerIdentity,
          scheme: text(signer.scheme),
          issuer: attestation.issuer,
          fingerprint: text(signer.fingerprint),
          repositoryId: text(signer.repository_id),
          logged: attestation.signedAtVerified,
          signedAt: attestation.signedAt,
          trustTier: attestation.trustTier,
          evidence: attestation.evidence,
          executables,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  const lines: [string, string | undefined][] = [
    ['signer', attestation.signerIdentity],
    [
      'scheme',
      [
        text(signer.scheme),
        attestation.issuer && `issuer ${attestation.issuer}`,
      ]
        .filter(Boolean)
        .join(', '),
    ],
    ['fingerprint', text(signer.fingerprint)],
    ['repository', text(signer.repository_id)],
    [
      'logged',
      attestation.signedAtVerified
        ? 'yes, a transparency log vouches for the signing time'
        : 'no transparency-log entry',
    ],
    ['signed', attestation.signedAt],
    ['trust tier', attestation.trustTier],
    ['executables', executables.join(', ') || '(none declared)'],
  ];
  out(io, `${release.purl}\n`);
  for (const [label, value] of lines)
    if (value !== undefined && value !== '')
      out(io, `  ${label.padEnd(12)}${value}\n`);
  return 0;
}

async function pin(
  args: CommandArgs,
  io: CommandIo,
  cwd: string,
  transport: RegistryOptions,
): Promise<number> {
  // `--write=false` must not write, and must not be mistaken for a request not
  // to: it is refused before anything is fetched.
  const write = args.options.get('write');
  if (write !== undefined && write !== true)
    throw new OpmError('INVALID_SPEC', '--write takes no value');
  const release = await resolve(args, cwd, 'pin', transport);
  const signer = signerOf(release);
  const fingerprint = text(signer.fingerprint);
  if (fingerprint === undefined)
    throw new OpmError(
      'INVALID_SPEC',
      `${release.project} is signed with a key (${text(signer.identity) ?? 'unknown'}), not keylessly, so there is no fingerprint to pin. ` +
        'Set public_key to the vendor’s minisign public key in [adapters.packslip.trust."' +
        `${release.project}"].`,
    );
  const stanza = `[adapters.packslip.trust."${release.project}"]\npin = ["${fingerprint}"]\n`;
  if (write !== true) {
    out(io, stanza);
    io.stderr.write(
      report(
        'opm: ',
        'this fingerprint is what the release showed just now. Confirm it with the vendor ' +
          'before relying on it; pass --write to record it in opm.toml.',
      ),
    );
    return 0;
  }
  const root = await requireOpmRoot(cwd);
  return writePin(
    root,
    release.project,
    fingerprint,
    io,
    cliStep(io, args.options),
  );
}

/**
 * Record a keyless signer's fingerprint in opm.toml, as one step on the
 * project (`project-step.ts`): opm.toml is read again inside it, so it holds
 * what a killed step left put back, and nothing else writes it meanwhile.
 */
export async function writePin(
  root: string,
  project: string,
  fingerprint: string,
  io: CommandIo,
  step: StepOptions,
): Promise<number> {
  return projectStep(root, step, async () => {
    const manifest = await readManifestFile(projectPaths(root).manifest);
    return pinIn(root, manifest, project, fingerprint, io);
  });
}

async function pinIn(
  root: string,
  manifest: OpmManifest,
  project: string,
  fingerprint: string,
  io: CommandIo,
): Promise<number> {
  const settings = { ...manifest.adapterSettings?.packslip };
  const trust: Table = isTable(settings.trust) ? { ...settings.trust } : {};
  const existing = trust[project];
  const entry: Table = isTable(existing) ? { ...existing } : {};
  if (entry.public_key !== undefined)
    throw new OpmError(
      'INVALID_MANIFEST',
      `${project} is already trusted by public_key; a fingerprint pin applies only to keyless signers`,
    );
  const held = Array.isArray(entry.pin) ? entry.pin : [];
  entry.pin = [...new Set([...held, fingerprint])].sort() as Json;
  trust[project] = entry;
  await writeManifestFile(projectPaths(root).manifest, {
    ...manifest,
    adapterSettings: {
      ...manifest.adapterSettings,
      packslip: { ...settings, trust },
    },
  });
  out(io, `Pinned ${project} to ${fingerprint}\n`);
  return 0;
}

async function approve(
  args: CommandArgs,
  io: CommandIo,
  cwd: string,
): Promise<number> {
  const id = args.positionals[0];
  if (!id || !/^[0-9a-f]{16}$/u.test(id))
    throw new OpmError(
      'INVALID_SPEC',
      'opm packslip approve requires the 16-character proposal id from the refusal message',
    );
  const root = await requireOpmRoot(cwd);
  return projectStep(root, cliStep(io, args.options), () =>
    approveIn(root, id, io),
  );
}

async function approveIn(
  root: string,
  id: string,
  io: CommandIo,
): Promise<number> {
  const manifest = await readManifestFile(projectPaths(root).manifest);
  const settings = { ...manifest.adapterSettings?.packslip };
  const held = Array.isArray(settings.approvals)
    ? settings.approvals
    : typeof settings.approvals === 'string'
      ? [settings.approvals]
      : [];
  if (held.includes(id)) {
    out(io, `Proposal ${id} is already approved\n`);
    return 0;
  }
  await writeManifestFile(projectPaths(root).manifest, {
    ...manifest,
    adapterSettings: {
      ...manifest.adapterSettings,
      packslip: { ...settings, approvals: [...held, id].sort() },
    },
  });
  out(
    io,
    `Approved proposal ${id}. The next opm sync or opm update accepts exactly that change and nothing else.\n`,
  );
  return 0;
}

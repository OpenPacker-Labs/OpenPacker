import { access, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

async function markdownFiles(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? markdownFiles(path)
        : Promise.resolve(entry.name.endsWith('.md') ? [path] : []);
    }),
  );
  return files.flat().sort();
}

const files = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'examples/README.md',
  'examples/cli/README.md',
  ...(await markdownFiles('docs')),
  ...(await markdownFiles('spec/prex/v1')),
].sort();

const requiredDocuments = [
  'docs/architecture.md',
  'docs/README.md',
  'docs/guides/cli.md',
  'docs/guides/opm.md',
  'docs/guides/getting-started.md',
  'examples/cli/README.md',
  'examples/opm-project/README.md',
  'docs/integrations/artifact-extension-authoring.md',
  'docs/integrations/ecosystem-codec-authoring.md',
  'docs/integrations/epoch.md',
  'docs/integrations/mise.md',
  'docs/integrations/nix.md',
  'docs/integrations/oci-oras-ocm.md',
  'docs/integrations/overlays.md',
  'docs/integrations/provider-authoring.md',
  'docs/operations/backup-airgap-recovery.md',
  'docs/operations/benchmarking.md',
  'docs/operations/contributing-releasing.md',
  'docs/operations/runtime-clients.md',
  'docs/operations/storage-deployment.md',
  'docs/operations/trust-lifecycle-policy.md',
  'docs/product/compliance.md',
  'docs/product/leverage-guide.md',
  'docs/product/reference-implementation.md',
  'docs/product/use-cases.md',
  'docs/product/user-surface.md',
  'docs/protocol/capabilities-errors-media.md',
  'docs/protocol/events.md',
  'docs/protocol/identity-canonicalization.md',
  'docs/protocol/ir-semantics.md',
  'docs/protocol/operations.md',
  'docs/protocol/receipts-lockfiles.md',
  'docs/protocol/resolution-proof.md',
  'docs/research/formal-foundations.md',
  'docs/security/threat-model.md',
  'docs/security/tuf-sigstore-slsa-sbom.md',
  'examples/README.md',
  'spec/prex/v1/canonicalization.md',
  'spec/prex/v1/conformance.md',
  'spec/prex/v1/errors.md',
  'spec/prex/v1/media-types.md',
  'spec/prex/v1/normative.md',
  'spec/prex/v1/semantics.md',
];
for (const file of requiredDocuments) await access(join(root, file));
for (let number = 1; number <= 29; number += 1) {
  const prefix = `${String(number).padStart(4, '0')}-`;
  if (!files.some((file) => file.startsWith(`docs/adr/${prefix}`)))
    throw new Error(`Required ADR ${prefix} is missing`);
}

const requiredTerms = [
  '/v1/normalize',
  '/v1/identify',
  '/v1/enumerate',
  '/v1/inspect',
  '/v1/solve',
  '/v1/materialize',
  '/v1/verify',
  '/v1/explain',
  '/v1/openpacker/lock/import',
  'PREX-N',
  'PREX-C',
  'INVALID_PURL',
  'INTERNAL_ERROR',
  'application/vnd.openpacker.prex.receipt.v1+json',
  'prex-calculus-subset-v1',
  'native-capture-v1',
  'solutionDigest',
  'receiptDigest',
  'import-lock',
  'openpacker import-lock',
  'openpacker normalize',
  'openpacker enumerate',
  'opm install',
  'opmx',
  'opm.toml',
  'opm sync',
];

let corpus = '';
const unfinishedMarker = new RegExp(
  `\\b(?:${['TO' + 'DO', 'FIX' + 'ME', 'T' + 'BD'].join('|')})\\b`,
  'u',
);
for (const file of files) {
  const text = await readFile(join(root, file), 'utf8');
  corpus += text;
  if (unfinishedMarker.test(text))
    throw new Error(`${file} contains an unfinished-work marker`);
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = match[1];
    if (!target || /^(?:https?:|mailto:|#)/u.test(target)) continue;
    const path = target.split('#', 1)[0];
    if (!path) continue;
    await access(resolve(root, dirname(file), decodeURI(path))).catch(() => {
      throw new Error(`${file} has a missing local link: ${target}`);
    });
  }
}

for (const term of requiredTerms)
  if (!corpus.includes(term)) throw new Error(`Documentation omits ${term}`);

for (const source of [
  'github.com/package-url/purl-spec',
  'rfc-editor.org/rfc/rfc8785',
  'rfc-editor.org/rfc/rfc9457',
  'github.com/npm/registry',
  'docs.npmjs.com/cli/v11/configuring-npm/package-lock-json',
  'doc.rust-lang.org/cargo/reference/registry-index',
  'learn.microsoft.com/en-us/nuget/api',
  'docs.deps.dev/api',
  'help.sonatype.com/en/component-details-rest-api',
  'mise.jdx.dev/backend-plugin-development',
  'opencontainers/distribution-spec',
  'oras.land/docs',
  'ocm.software/docs',
  'theupdateframework.github.io/specification',
  'docs.sigstore.dev/about/bundle',
  'slsa.dev/spec',
  'cyclonedx.org/specification',
  'github.com/cloudevents/spec',
  'asyncapi.com/docs/reference/specification',
  'docs.pact.io/getting_started/provider_verification',
])
  if (!corpus.includes(source))
    throw new Error(`Documentation omits authoritative source ${source}`);

const packageJson = JSON.parse(
  await readFile(join(root, 'package.json'), 'utf8'),
);
for (const script of [
  'verify',
  'demo',
  'benchmark',
  'test:conformance',
  'test:docs',
  'golden:generate',
  'golden:check',
])
  if (typeof packageJson.scripts?.[script] !== 'string')
    throw new Error(`Documented package script is missing: ${script}`);

const cli = await readFile(
  join(root, 'apps/openpacker-cli/src/index.ts'),
  'utf8',
);
for (const command of [
  'normalize',
  'identify',
  'enumerate',
  'inspect',
  'solve',
  'explain',
  'materialize',
  'verify',
  'pack',
  'publish',
  'receipt',
  'catalog',
  'lifecycle',
  'export',
  'serve',
  'demo',
])
  if (!cli.includes(`'${command}'`))
    throw new Error(`Documented CLI command is missing: ${command}`);

const evidenceManifestPath = 'docs/operations/documentation-smoke.json';
const evidenceManifest = JSON.parse(
  await readFile(join(root, evidenceManifestPath), 'utf8'),
);
if (
  typeof evidenceManifest.executedBySmoke !== 'object' ||
  typeof evidenceManifest.coveredByVerify !== 'object'
)
  throw new Error(
    `${evidenceManifestPath} must declare executedBySmoke and coveredByVerify`,
  );

async function workspaceHasTestScript(name) {
  for (const group of ['apps', 'packages', 'examples', 'integrations']) {
    const entries = await readdir(join(root, group), {
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = await readFile(
        join(root, group, entry.name, 'package.json'),
        'utf8',
      ).catch(() => undefined);
      if (manifest === undefined) continue;
      const parsed = JSON.parse(manifest);
      if (parsed.name === name) return typeof parsed.scripts?.test === 'string';
    }
  }
  return false;
}

// Every advertised-but-not-executed evidence command must be a real script
// that the aggregate verify gate actually runs — the manifest cannot drift
// into decoration.
for (const [id, command] of Object.entries(evidenceManifest.coveredByVerify)) {
  const runMatch = command.match(/^npm run ([^ ]+)$/u);
  const workspaceMatch = command.match(/^npm test --workspace (\S+)$/u);
  if (runMatch) {
    if (typeof packageJson.scripts?.[runMatch[1]] !== 'string')
      throw new Error(`Evidence ${id} names a missing script: ${command}`);
    if (!packageJson.scripts.verify.includes(`npm run ${runMatch[1]}`))
      throw new Error(`verify does not run documented evidence ${id}`);
  } else if (workspaceMatch) {
    if (!packageJson.scripts.verify.includes('npm test'))
      throw new Error(`verify does not run workspace tests for ${id}`);
    if (!(await workspaceHasTestScript(workspaceMatch[1])))
      throw new Error(
        `Evidence ${id} names a workspace without a test script: ${command}`,
      );
  } else {
    throw new Error(`Unrecognized evidence command for ${id}: ${command}`);
  }
}

const executableChecks = Object.entries(evidenceManifest.executedBySmoke).map(
  ([id, command]) => {
    const [binary, ...args] = command.split(' ');
    return [
      id,
      binary === 'node'
        ? process.execPath
        : process.platform === 'win32'
          ? `${binary}.cmd`
          : binary,
      args,
    ];
  },
);
for (const [id, command, args] of executableChecks) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status !== 0)
    throw new Error(
      `Documented check ${id} failed: ${command} ${args.join(' ')}\n${result.stderr || result.stdout}`,
    );
}

console.log(
  `documentation smoke: ${files.length} files, local links, inventory, primary sources, ${executableChecks.length} executed checks, and ${Object.keys(evidenceManifest.coveredByVerify).length} verify-covered evidence commands passed`,
);
console.log(relative(root, join(root, evidenceManifestPath)));

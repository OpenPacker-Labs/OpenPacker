import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = join(root, 'release');
const sourcePackage = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
);
// Nightly and integration promotion set OPENPACKER_RELEASE_VERSION.
const releaseVersion =
  process.env.OPENPACKER_RELEASE_VERSION || sourcePackage.version;

rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(join(releaseDir, 'dist'), { recursive: true });

const built = spawnSync('npm run build', {
  cwd: root,
  stdio: 'inherit',
  shell: true,
});
if (built.status !== 0) process.exit(built.status ?? 1);

const dependencies = {
  '@microsoft/mxc-sdk': '0.7.0',
  '@sigstore/bundle': '4.0.0',
  '@sigstore/core': '3.2.1',
  '@sigstore/protobuf-specs': '0.5.2',
  '@sigstore/verify': '3.1.1',
  ajv: '8.18.0',
  'ajv-formats': '3.0.1',
  'fast-xml-parser': '^5.10.1',
  fastify: '5.11.2',
  fflate: '^0.8.3',
  koffi: '^2.15.0',
  minimatch: '^10.2.6',
  'smol-toml': '^1.7.1',
  undici: '8.10.0',
  yaml: '^2.8.3',
};

const requireBanner =
  "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);";

const esbuildCommon = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  alias: {
    '@openpacker/embedded/wasm-node': join(root, 'scripts/wasm-node-stub.mjs'),
  },
  external: Object.keys(dependencies),
  loader: { '.node': 'copy' },
  logLevel: 'info',
  banner: { js: requireBanner },
};

await esbuild.build({
  ...esbuildCommon,
  entryPoints: [join(root, 'src/main.ts')],
  outfile: join(releaseDir, 'dist/main.js'),
});

await esbuild.build({
  ...esbuildCommon,
  entryPoints: [join(root, 'src/opmx-main.ts')],
  outfile: join(releaseDir, 'dist/opmx-main.js'),
});

// PREX-only workflows and tests import `@openpacker/cli` / `dist/index.js`.
await esbuild.build({
  ...esbuildCommon,
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(releaseDir, 'dist/index.js'),
});

writeFileSync(
  join(releaseDir, 'package.json'),
  `${JSON.stringify(
    {
      name: '@openpacker/cli',
      version: releaseVersion,
      description: sourcePackage.description,
      license: 'MIT',
      type: 'module',
      bin: {
        opm: './dist/main.js',
        opmx: './dist/opmx-main.js',
        opkg: './dist/main.js',
        opkgm: './dist/main.js',
      },
      files: ['dist'],
      engines: sourcePackage.engines,
      publishConfig: sourcePackage.publishConfig,
      dependencies,
      repository: sourcePackage.repository,
    },
    null,
    2,
  )}\n`,
);

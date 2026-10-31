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

await esbuild.build({
  entryPoints: [join(root, 'dist/index.js')],
  outfile: join(releaseDir, 'dist/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
  },
  alias: {
    '@openpacker/embedded/wasm-node': join(root, 'scripts/wasm-node-stub.mjs'),
  },
  external: Object.keys(dependencies),
  loader: { '.node': 'copy' },
  logLevel: 'info',
});

writeFileSync(
  join(releaseDir, 'package.json'),
  `${JSON.stringify(
    {
      name: '@openpacker/cli',
      version: releaseVersion,
      description: 'OpenPacker command-line client',
      license: 'MIT',
      type: 'module',
      bin: {
        openpacker: './dist/index.js',
      },
      files: ['dist'],
      engines: {
        node: '^22.19.0 || >=24',
      },
      publishConfig: {
        access: 'public',
        tag: 'alpha',
      },
      dependencies,
      repository: {
        type: 'git',
        url: 'git+https://github.com/Tyler-R-Kendrick/OpenPacker.git',
        directory: 'apps/openpacker-cli',
      },
    },
    null,
    2,
  )}\n`,
);

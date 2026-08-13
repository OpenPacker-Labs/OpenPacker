import { existsSync, readdirSync } from 'node:fs';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { BinDeclaration } from './types.js';
import { OpmError } from './types.js';
import { assertSafeSegment, resolveContained } from './paths.js';

export async function discoverNpmBins(
  extractRoot: string,
): Promise<BinDeclaration[]> {
  const candidates = [
    join(extractRoot, 'package', 'package.json'),
    join(extractRoot, 'package.json'),
  ];
  for (const packageJsonPath of candidates) {
    try {
      const text = await readFile(packageJsonPath, 'utf8');
      const pkg = JSON.parse(text) as {
        name?: string;
        bin?: string | Record<string, string>;
      };
      const packageDir = dirname(packageJsonPath);
      const relPackageDir = relative(extractRoot, packageDir);
      if (pkg.bin === undefined) return [];
      if (typeof pkg.bin === 'string') {
        const name =
          typeof pkg.name === 'string'
            ? pkg.name.includes('/')
              ? pkg.name.split('/').pop()!
              : pkg.name
            : 'bin';
        return [
          {
            name,
            path: joinPosix(relPackageDir, pkg.bin),
          },
        ];
      }
      return Object.entries(pkg.bin).map(([name, path]) => ({
        name,
        path: joinPosix(relPackageDir, path),
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  return [];
}

/**
 * Console scripts declared by an installed wheel.
 *
 * A wheel records its entry points in `<name>.dist-info/entry_points.txt`, an
 * INI file whose `[console_scripts]` section maps a command name to
 * `module:callable`. There is no script file to point at — the launcher is
 * generated — which is why npm-shaped discovery finds nothing here.
 */
export async function discoverPythonBins(
  extractRoot: string,
): Promise<BinDeclaration[]> {
  let entries: string[];
  try {
    entries = await readdir(extractRoot);
  } catch {
    return [];
  }
  const bins: BinDeclaration[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.dist-info')) continue;
    let text: string;
    try {
      text = await readFile(
        join(extractRoot, entry, 'entry_points.txt'),
        'utf8',
      );
    } catch {
      continue;
    }
    let section = '';
    for (const rawLine of text.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      if (line.startsWith('[')) {
        section = line.slice(1, -1).trim().toLowerCase();
        continue;
      }
      if (section !== 'console_scripts') continue;
      const separator = line.indexOf('=');
      if (separator <= 0) continue;
      const name = line.slice(0, separator).trim();
      const target = line.slice(separator + 1).trim();
      // `module:callable`, optionally with a `[extra]` suffix this cannot
      // honour without resolving extras.
      const spec = target.split('[')[0]!.trim();
      if (!/^[A-Za-z0-9_.]+:[A-Za-z0-9_.]+$/u.test(spec)) continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) continue;
      bins.push({
        name,
        // The dist-info file is what declares it; recorded so the origin of
        // the entry point is traceable rather than invented.
        path: `${entry}/entry_points.txt`,
        interpreter: 'python',
        entry: spec,
      });
    }
  }
  return bins.sort((left, right) => (left.name < right.name ? -1 : 1));
}

/**
 * Commands declared by a .NET tool package.
 *
 * A tool nupkg carries `tools/<framework>/<rid>/DotnetToolSettings.xml`, whose
 * `<Command>` elements name the command, the managed assembly to run, and the
 * runner. There is no native executable to point at — `dotnet` runs the dll —
 * which is why this needs its own discovery rather than a file lookup.
 *
 * Packages ship the same command under several TFMs (`net8.0`, `net9.0`,
 * `net10.0`). Emitting one entry per TFM made every multi-target tool look
 * ambiguous. One command name wins: the highest TFM that the host runtime can
 * load (or the newest TFM when no runtime is detected).
 */
export async function discoverDotnetBins(
  extractRoot: string,
): Promise<BinDeclaration[]> {
  const settings = await findToolSettings(join(extractRoot, 'tools'));
  const hostMajor = hostDotnetMajor();
  type Candidate = BinDeclaration & { tfmMajor: number; tfmMinor: number };
  const best = new Map<string, Candidate>();
  for (const file of settings) {
    let xml: string;
    try {
      xml = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const tfm = tfmFromToolsPath(file) ?? { major: 0, minor: 0 };
    // Skip TFMs the host cannot load when we know what is installed.
    if (hostMajor !== undefined && tfm.major > hostMajor) continue;
    for (const match of xml.matchAll(/<Command\b([^>]*)\/?>/giu)) {
      const attributes = match[1] ?? '';
      const name = /\bName\s*=\s*"([^"]+)"/iu.exec(attributes)?.[1];
      const entryPoint = /\bEntryPoint\s*=\s*"([^"]+)"/iu.exec(attributes)?.[1];
      const runner = /\bRunner\s*=\s*"([^"]+)"/iu.exec(attributes)?.[1];
      if (!name || !entryPoint) continue;
      // Only the `dotnet` runner is understood; anything else would need a
      // launcher this cannot generate, and guessing would produce a command
      // that fails at run time instead of here.
      if (runner !== undefined && runner.toLowerCase() !== 'dotnet') continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.dll$/iu.test(entryPoint)) continue;
      const directory = dirname(file);
      const candidate: Candidate = {
        name,
        path: `${relative(extractRoot, directory).split(sep).join('/')}/${entryPoint}`,
        interpreter: 'dotnet',
        tfmMajor: tfm.major,
        tfmMinor: tfm.minor,
      };
      const previous = best.get(name);
      if (
        previous === undefined ||
        candidate.tfmMajor > previous.tfmMajor ||
        (candidate.tfmMajor === previous.tfmMajor &&
          candidate.tfmMinor > previous.tfmMinor)
      )
        best.set(name, candidate);
    }
  }
  return [...best.values()]
    .map(({ tfmMajor: _a, tfmMinor: _b, ...bin }) => bin)
    .sort((left, right) => (left.name < right.name ? -1 : 1));
}

/** `tools/net8.0/any/…` → { major: 8, minor: 0 }. */
function tfmFromToolsPath(
  settingsPath: string,
): { major: number; minor: number } | undefined {
  const match = /[/\\](?:net|netcoreapp|netstandard)(\d+)(?:\.(\d+))?/iu.exec(
    settingsPath,
  );
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? '0'),
  };
}

/**
 * Highest Microsoft.NETCore.App major the host has installed.
 *
 * Reads the shared framework directory rather than shelling out, so discovery
 * stays offline and cheap. Undefined when nothing is installed — callers then
 * keep the newest TFM in the package.
 */
export function hostDotnetMajor(): number | undefined {
  const roots = [
    process.env.DOTNET_ROOT?.trim(),
    process.env.OPM_DOTNET?.trim()
      ? dirname(process.env.OPM_DOTNET.trim())
      : undefined,
    join(homedir(), '.dotnet'),
    '/usr/share/dotnet',
  ].filter((value): value is string => value !== undefined && value !== '');
  let highest: number | undefined;
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(join(root, 'shared', 'Microsoft.NETCore.App'));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const major = Number(/^(\d+)\./u.exec(entry)?.[1]);
      if (!Number.isFinite(major)) continue;
      if (highest === undefined || major > highest) highest = major;
    }
  }
  return highest;
}

/** `DotnetToolSettings.xml` files under a tools directory. */
async function findToolSettings(
  directory: string,
  depth = 0,
): Promise<string[]> {
  // The layout is tools/<framework>/<rid>/, so three levels is the shape;
  // bounding it keeps a hostile archive from driving an unbounded walk.
  if (depth > 3) return [];
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      found.push(...(await findToolSettings(path, depth + 1)));
    else if (entry.name.toLowerCase() === 'dotnettoolsettings.xml')
      found.push(path);
  }
  return found;
}

/** Executables an extracted package declares, however its ecosystem does it. */
export async function discoverBins(
  extractRoot: string,
  ecosystem: string,
): Promise<BinDeclaration[]> {
  if (ecosystem === 'pypi') return discoverPythonBins(extractRoot);
  if (ecosystem === 'nuget') return discoverDotnetBins(extractRoot);
  if (ecosystem === 'npm') return discoverNpmBins(extractRoot);
  // Other ecosystems have no convention this understands yet. Returning
  // nothing is honest; the runner turns it into a message that says which
  // ecosystem is unsupported rather than implying the package is empty.
  return [];
}

function joinPosix(...parts: string[]): string {
  return parts
    .filter((p) => p !== '' && p !== '.')
    .join('/')
    .replace(/\\/g, '/');
}

export interface WrittenBinShim {
  name: string;
  path: string;
  shim: string;
  target: string;
  interpreter?: 'node' | 'python' | 'dotnet';
  entry?: string;
}

/**
 * Write launchers for discovered entry points.
 *
 * npm bins are Node scripts; Python console scripts are a module:callable;
 * .NET tools are managed assemblies. Each gets a launcher that invokes the
 * right runtime — a Node shebang for a .dll is not an install, it is a
 * deferred crash.
 *
 * `pythonPath` is every store root that should be importable when a Python
 * console script runs (the package itself plus its resolved transitive
 * dependencies). Without it a tool that imports a locked dependency fails
 * at runtime even though `opm install` put that dependency on disk.
 */
export async function writeBinShims(input: {
  binDir: string;
  storeRoot: string;
  bins: readonly BinDeclaration[];
  /** Extra store roots on PYTHONPATH for Python entry points. */
  pythonPath?: readonly string[];
}): Promise<WrittenBinShim[]> {
  await mkdir(input.binDir, { recursive: true });
  const written: WrittenBinShim[] = [];
  const storeRoot = resolve(input.storeRoot);
  const binDir = resolve(input.binDir);
  const pythonRoots = [
    storeRoot,
    ...(input.pythonPath ?? []).map((path) => resolve(path)),
  ];
  for (const bin of input.bins) {
    const name = assertSafeSegment(bin.name, 'bin name');
    // "." segments are dropped, not refused. npm bin paths are conventionally
    // written "./lib/tool.js", so rejecting them made a large share of real
    // packages uninstallable while protecting against nothing: only ".."
    // leaves the directory, and `resolveContained` below is the actual
    // containment check either way.
    const segments = bin.path
      .split(/[/\\]/)
      .filter((part) => part !== '' && part !== '.');
    if (segments.length === 0 || segments.includes('..')) {
      throw new OpmError('UNSAFE_BIN', `Bin path escapes store: ${bin.path}`);
    }
    const target = resolveContained(storeRoot, ...segments);
    const shimPath = resolveContained(binDir, name);
    const script = shimScriptFor(bin, {
      binDir,
      target,
      pythonRoots,
      opmxPath: resolveOpmxPath(),
    });
    await writeFile(shimPath, script, { mode: 0o755 });
    await chmod(shimPath, 0o755);
    written.push({
      name,
      path: bin.path,
      shim: shimPath,
      target,
      ...(bin.interpreter === undefined
        ? {}
        : { interpreter: bin.interpreter }),
      ...(bin.entry === undefined ? {} : { entry: bin.entry }),
    });
  }
  return written;
}

/**
 * Absolute `opmx` to embed in shims. PATH lookup is a sandbox bypass:
 * a package bin named `opmx` earlier on PATH would win.
 */
export function resolveOpmxPath(): string {
  const fromEnv = process.env.OPM_OPMX?.trim();
  if (fromEnv) return resolve(fromEnv);
  const argv1 = process.argv[1];
  if (argv1) {
    const dir = dirname(resolve(argv1));
    for (const name of ['opmx', 'opmx.js', 'opmx.mjs']) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}

/**
 * Generate a bin shim.
 *
 * Direct ambient spawn is a sandbox bypass (audit H3). Default behaviour:
 * re-enter via `opmx <name>` when available, otherwise refuse unless
 * OPENPACKER_ALLOW_AMBIENT_SHIMS=1 (loud escape hatch).
 */
function shimScriptFor(
  bin: BinDeclaration,
  context: {
    binDir: string;
    target: string;
    pythonRoots: readonly string[];
    opmxPath: string;
  },
): string {
  const binName = JSON.stringify(bin.name);
  // Ambient body kept for the explicit escape hatch only.
  let ambientBody: string;
  if (bin.interpreter === 'python') {
    const [moduleName, callable] = (bin.entry ?? '').split(':');
    if (!moduleName || !callable)
      throw new OpmError(
        'UNSAFE_BIN',
        `${bin.name} declares an unusable Python entry point: ${bin.entry ?? '(none)'}`,
      );
    const pathLiteral = JSON.stringify(context.pythonRoots);
    ambientBody = `
const roots = ${pathLiteral};
const env = { ...process.env };
const existing = env.PYTHONPATH ? env.PYTHONPATH.split(/[:;]/) : [];
env.PYTHONPATH = [...roots, ...existing].join(process.platform === 'win32' ? ';' : ':');
const program = 'import sys\\n' + ${JSON.stringify(`from ${moduleName} import ${callable} as _entry\\nsys.exit(_entry())\\n`)};
const python = process.env.OPM_PYTHON?.trim() || 'python3';
return spawn(python, ['-c', program, ...process.argv.slice(2)], { stdio: 'inherit', env });
`;
  } else if (bin.interpreter === 'dotnet') {
    const relTarget = relative(context.binDir, context.target);
    ambientBody = `
const assembly = resolve(here, ${JSON.stringify(relTarget)});
const dotnet = process.env.OPM_DOTNET?.trim() || 'dotnet';
return spawn(dotnet, [assembly, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
`;
  } else {
    const relTarget = relative(context.binDir, context.target);
    ambientBody = `
const target = resolve(here, ${JSON.stringify(relTarget)});
return spawn(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
`;
  }

  return `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function run(child) {
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
  child.on('error', (error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
// Prefer re-entry through an absolute opmx (sandboxed). Never PATH-search.
const opmx = process.env.OPM_OPMX?.trim() || ${JSON.stringify(context.opmxPath)};
if (!opmx) {
  console.error(
    'opm: refuse ambient bin shim (sandbox). Use: opmx ' + ${binName} +
    ' … or set OPM_OPMX to the opmx binary.',
  );
  process.exit(78);
}
const viaOpmx = spawn(opmx, [${binName}, ...args], {
  stdio: 'inherit',
  env: process.env,
  shell: false,
});
viaOpmx.on('error', (error) => {
  if (process.env.OPENPACKER_ALLOW_AMBIENT_SHIMS === '1') {
    console.error('opm: opmx unavailable; ambient shim allowed by OPENPACKER_ALLOW_AMBIENT_SHIMS=1');
    run((() => { ${ambientBody}
    })());
    return;
  }
  console.error(
    'opm: refuse ambient bin shim (sandbox). Use: opmx ' + ${binName} +
    ' …  or set OPENPACKER_ALLOW_AMBIENT_SHIMS=1 (insecure).',
  );
  console.error(String(error.message || error));
  process.exit(78);
});
viaOpmx.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
`;
}

export async function removeBinShims(
  binDir: string,
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    const safe = assertSafeSegment(name, 'bin name');
    await rm(resolveContained(binDir, safe), { force: true });
  }
}

export async function resolveExecutable(input: {
  binDir: string;
  projectStateBins: readonly {
    name: string;
    packageAlias: string;
    shim: string;
    target: string;
  }[];
  packageAlias?: string;
  binName?: string;
  positional?: string;
}): Promise<{
  shim: string;
  target: string;
  name: string;
  packageAlias?: string;
}> {
  const wantBin = input.binName ?? input.positional;
  if (!wantBin) {
    throw new OpmError('USAGE', 'opmx requires a package or bin name');
  }

  if (input.packageAlias) {
    const bins = input.projectStateBins.filter(
      (b) => b.packageAlias === input.packageAlias,
    );
    if (bins.length === 0) {
      throw new OpmError(
        'NOT_FOUND',
        `Package "${input.packageAlias}" is not installed or has no bins`,
      );
    }
    const bin = input.binName
      ? bins.find((b) => b.name === input.binName)
      : bins[0];
    if (!bin) {
      throw new OpmError(
        'NOT_FOUND',
        `Bin "${input.binName}" not found in package "${input.packageAlias}"`,
      );
    }
    return {
      shim: bin.shim,
      target: bin.target,
      name: bin.name,
      packageAlias: bin.packageAlias,
    };
  }

  // Match by bin name first, then package alias primary bin
  const byBin = input.projectStateBins.find((b) => b.name === wantBin);
  if (byBin) {
    return {
      shim: byBin.shim,
      target: byBin.target,
      name: byBin.name,
      packageAlias: byBin.packageAlias,
    };
  }
  const byPkg = input.projectStateBins.filter(
    (b) => b.packageAlias === wantBin,
  );
  if (byPkg[0]) {
    return {
      shim: byPkg[0].shim,
      target: byPkg[0].target,
      name: byPkg[0].name,
      packageAlias: byPkg[0].packageAlias,
    };
  }

  // direct path in bin dir
  const direct = join(input.binDir, wantBin);
  try {
    await readFile(direct);
    return { shim: direct, target: direct, name: wantBin };
  } catch {
    throw new OpmError(
      'NOT_FOUND',
      `No installed bin or package named "${wantBin}". Run opm install / opm sync first.`,
    );
  }
}

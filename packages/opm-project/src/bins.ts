import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

function joinPosix(...parts: string[]): string {
  return parts
    .filter((p) => p !== '' && p !== '.')
    .join('/')
    .replace(/\\/g, '/');
}

export async function writeBinShims(input: {
  binDir: string;
  storeRoot: string;
  bins: readonly BinDeclaration[];
}): Promise<{ name: string; path: string; shim: string; target: string }[]> {
  await mkdir(input.binDir, { recursive: true });
  const written: {
    name: string;
    path: string;
    shim: string;
    target: string;
  }[] = [];
  const storeRoot = resolve(input.storeRoot);
  const binDir = resolve(input.binDir);
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
    const relTarget = relative(binDir, target);
    const script = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, ${JSON.stringify(relTarget)});
const child = spawn(process.execPath, [target, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
`;
    await writeFile(shimPath, script, { mode: 0o755 });
    await chmod(shimPath, 0o755);
    written.push({
      name,
      path: bin.path,
      shim: shimPath,
      target,
    });
  }
  return written;
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

/**
 * The executables of a layout: shell shims in each `node_modules/.bin`.
 *
 * npm links `.bin/<name>` to a package's script and OpenPacker writes a shim
 * instead (`layout-bins.ts`). A shim goes in the `.bin` of the `node_modules`
 * its package sits in: the project's, or a workspace member's own. A member's
 * own executables are shimmed in the project's `.bin`, where npm links them
 * (it links the member's name there, so the `.bin` beside that link holds
 * them), and address the member's directory directly.
 */

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeLayoutMember } from '@openpacker/adapter-core';
import { writeFileAtomic } from '@openpacker/project-io';
import {
  NODE,
  interpreterFor,
  readPackageBins,
  renderCmdShim,
  renderPosixShim,
  validateBins,
  type Interpreter,
  type PackageBin,
} from './layout-bins.js';
import { containerOf, directoryOf, modulesOf } from './layout-dirs.js';
import type { Placement } from './layout-plan.js';

/** One executable that wants a name in a `.bin`. */
interface Candidate {
  /** Who declares it, for the message when two want one name. */
  owner: string;
  /** A direct requirement, or a member, keeps a contested name. */
  direct: boolean;
  /** A workspace member's executable, whose script may not be built yet. */
  member: boolean;
  bin: PackageBin;
  /** From the `.bin` directory to the script. */
  relative: string;
  /** Where the script is, to read the interpreter its first line asks for. */
  script: string;
}

export interface Shims {
  total: number;
  /** The file names written, by the `node_modules` they sit in. */
  names: Map<string, string[]>;
}

/** Only these characters may be in the path a shim carries to a member's script. */
const SHIM_PATH = /^[A-Za-z0-9._~+@/-]+$/u;

function outranks(candidate: Candidate, rival: Candidate): boolean {
  if (candidate.direct !== rival.direct) return candidate.direct;
  return candidate.owner < rival.owner;
}

/** A script that is a regular file says what runs it; one that is not there yet runs under node. */
async function interpreterOfMemberScript(script: string): Promise<Interpreter> {
  try {
    if ((await lstat(script)).isFile()) return await interpreterFor(script);
  } catch {
    // not built yet
  }
  return NODE;
}

async function memberCandidates(
  projectRoot: string,
  member: NativeLayoutMember,
  skipped: { path: string; reason: string }[],
): Promise<Candidate[]> {
  const { bins, refused } = await validateBins(Object.entries(member.bin));
  const where = join(modulesOf(projectRoot, ''), '.bin');
  for (const refusal of refused)
    skipped.push({
      path: join(where, refusal.name),
      reason: `${member.name}: bin ${JSON.stringify(refusal.name)} ${refusal.reason}`,
    });
  const out: Candidate[] = [];
  for (const bin of bins) {
    const relative = `../../${member.dir}/${bin.target}`;
    if (!SHIM_PATH.test(relative)) {
      skipped.push({
        path: join(where, bin.name),
        reason: `${member.name}: bin ${JSON.stringify(bin.name)} is at a path a shim cannot carry (${JSON.stringify(relative)})`,
      });
      continue;
    }
    out.push({
      owner: member.name,
      direct: true,
      member: true,
      bin,
      relative,
      script: join(
        projectRoot,
        ...member.dir.split('/'),
        ...bin.target.split('/'),
      ),
    });
  }
  return out;
}

/**
 * Write the shims for every placed package and every installed member.
 * `placements` are already on disk, so their `package.json` can be read.
 */
export async function writeShims(
  projectRoot: string,
  placements: readonly Placement[],
  members: readonly NativeLayoutMember[],
  skipped: { path: string; reason: string }[],
): Promise<Shims> {
  const byContainer = new Map<string, Map<string, Candidate>>();
  const offer = (container: string, candidate: Candidate): void => {
    const taken = byContainer.get(container) ?? new Map<string, Candidate>();
    byContainer.set(container, taken);
    const rival = taken.get(candidate.bin.name);
    if (rival === undefined) {
      taken.set(candidate.bin.name, candidate);
      return;
    }
    const [keep, lose] = outranks(candidate, rival)
      ? [candidate, rival]
      : [rival, candidate];
    taken.set(candidate.bin.name, keep);
    skipped.push({
      path: join(container, '.bin', candidate.bin.name),
      reason: `${lose.owner} also declares ${candidate.bin.name}; ${keep.owner} keeps it`,
    });
  };

  for (const placement of placements) {
    const modules = modulesOf(projectRoot, placement.base ?? '');
    const directory = directoryOf(modules, placement.chain);
    const { bins, refused } = await readPackageBins(
      directory,
      placement.entry.name,
    );
    for (const refusal of refused)
      skipped.push({
        path: join(directory, 'package.json'),
        reason: `${placement.entry.name}: bin ${JSON.stringify(refusal.name)} ${refusal.reason}`,
      });
    for (const bin of bins)
      offer(containerOf(modules, placement.chain), {
        owner: placement.entry.name,
        direct: placement.entry.direct,
        member: false,
        bin,
        relative: `../${placement.entry.name}/${bin.target}`,
        script: join(directory, ...bin.target.split('/')),
      });
  }
  for (const member of members)
    for (const candidate of await memberCandidates(
      projectRoot,
      member,
      skipped,
    ))
      offer(modulesOf(projectRoot, ''), candidate);

  const shims: Shims = { total: 0, names: new Map() };
  for (const [container, taken] of byContainer) {
    const names: string[] = [];
    for (const [name, candidate] of taken) {
      const interpreter = candidate.member
        ? await interpreterOfMemberScript(candidate.script)
        : await interpreterFor(candidate.script);
      await writeFileAtomic(
        join(container, '.bin', name),
        renderPosixShim(candidate.relative, interpreter),
        { mode: 0o755 },
      );
      if (process.platform === 'win32')
        await writeFileAtomic(
          join(container, '.bin', `${name}.cmd`),
          renderCmdShim(candidate.relative, interpreter),
        );
      shims.total += 1;
      names.push(name);
    }
    shims.names.set(container, names);
  }
  return shims;
}

import type { InstallOutcome, InstallPlan } from '@openpacker/adapter-core';
import { readProjectState } from './install.js';
import { emptyLockfile } from './lock.js';
import type { NativeProjectionReport } from './native.js';
import { assertSafeSegment, projectPaths } from './paths.js';
import { stripPurlVersion } from './spec.js';
import {
  hostSandboxFromPolicy,
  installSystemPackage,
  planSystemInstall,
} from './system.js';
import type {
  OpmLockfile,
  OpmManifest,
  ParsedPackageSpec,
  ProjectState,
} from './types.js';
import { OpmError } from './types.js';

/** What `addPackage` reports. */
export interface AddPackageResult {
  manifest: OpmManifest;
  lock: OpmLockfile;
  state: ProjectState;
  alias: string;
  /** What was written into the ecosystem's own project files. */
  native?: NativeProjectionReport;
  /** When the adapter prefers host install, the plan/outcome is returned. */
  hostInstall?: {
    plan: InstallPlan;
    outcome?: InstallOutcome;
  };
}

/** Fail closed if the ecosystem is not one the project allows. */
export function assertEcosystemAllowed(
  manifest: OpmManifest,
  ecosystem: string | undefined,
): void {
  if (
    ecosystem &&
    manifest.project.ecosystems.length > 0 &&
    !manifest.project.ecosystems.includes(ecosystem)
  )
    throw new OpmError(
      'ECOSYSTEM_DENIED',
      `Ecosystem "${ecosystem}" is not in project.ecosystems`,
    );
}

/**
 * `opm add` for an ecosystem whose Registry Definition prefers a host install
 * (apt, winget, choco): the package goes onto the machine through its native
 * tool, and nothing the project keeps changes, so it takes no project step
 * (`project-step.ts`). A dry run only plans.
 */
export async function addHostPackage(input: {
  root: string;
  manifest: OpmManifest;
  parsed: ParsedPackageSpec;
  ecosystem: string;
  offline?: boolean;
  allowElevation?: boolean;
  dryRun?: boolean;
}): Promise<AddPackageResult> {
  const { manifest, parsed, ecosystem } = input;
  assertEcosystemAllowed(manifest, parsed.ecosystem);
  const exact =
    parsed.version !== undefined
      ? `${stripPurlVersion(parsed.purl)}@${parsed.version}`
      : parsed.purl.startsWith('pkg:')
        ? parsed.purl
        : `pkg:${ecosystem}/${parsed.alias}`;
  const sandbox = hostSandboxFromPolicy(manifest.policy);
  const consent = {
    ...(input.offline !== undefined && { offline: input.offline }),
    ...(input.allowElevation !== undefined && {
      allowElevation: input.allowElevation,
    }),
    sandbox,
  };
  const plan = await planSystemInstall(exact, {
    ...consent,
    ...(input.dryRun !== undefined && { dryRun: input.dryRun }),
  });
  const outcome =
    input.dryRun === true
      ? undefined
      : await installSystemPackage(exact, consent);
  const alias = assertSafeSegment(parsed.alias, 'package alias');
  const state = (await readProjectState(
    projectPaths(input.root).projectState,
  )) ?? {
    schemaVersion: 1 as const,
    packages: {},
  };
  return {
    manifest,
    lock: emptyLockfile(),
    state,
    alias,
    hostInstall: {
      plan,
      ...(!(outcome === undefined) && { outcome }),
    },
  };
}

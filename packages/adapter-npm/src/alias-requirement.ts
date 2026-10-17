import type { Requirement } from '@openpacker/contracts';
import { sourceRef, type ParsedRange } from '@openpacker/adapter-core';
import type { NpmAlias } from './alias.js';
import { npmRangeVers } from './range-vers.js';

/**
 * A dependency written `"installName": "npm:target@spec"`.
 *
 * The requirement is about the target, which is the registry package that is
 * installed and the one every gate looks at. The install name rides in the
 * native data, because it decides a directory and nothing else.
 */
export function aliasRequirement(input: {
  dependerNodeId: string;
  installName: string;
  aliasSpec: string;
  alias: Extract<NpmAlias, { target: string }>;
  kind: Requirement['kind'];
  optional: boolean;
  endpoint: string;
  path: string;
  dependencyField: string;
  /** The target's package PURL. */
  purl: string;
  /** The target range as the codec reads it; absent for a dist-tag. */
  parsed: ParsedRange | undefined;
}): Requirement {
  const {
    dependerNodeId,
    installName,
    aliasSpec,
    alias,
    kind,
    optional,
    endpoint,
    path,
    dependencyField,
    purl,
    parsed,
  } = input;
  const vers =
    parsed === undefined
      ? undefined
      : (parsed.vers ?? npmRangeVers(parsed.ast));
  return {
    id: `${dependerNodeId}:${kind}:${installName}`,
    dependerNodeId,
    expression: {
      type: 'package',
      purl,
      ...(!(vers === undefined) && { vers }),
    },
    kind,
    optional,
    source: sourceRef('npm', endpoint),
    authority: 'native',
    raw: { path, range: aliasSpec },
    nativeSemantics: {
      version: 'npm-v1',
      data: {
        dependencyField,
        range: alias.spec,
        installName,
        aliasSpec,
        ...(alias.kind === 'tag' && { specKind: 'tag' }),
      },
    },
    semanticLoss: (parsed?.semanticLoss ?? []).map((loss) =>
      vers === undefined || parsed?.vers !== undefined
        ? loss
        : {
            ...loss,
            representedMeaning:
              'A comparison form that is a superset of the range: it also admits prereleases npm would exclude. The native range is re-checked after the solve',
          },
    ),
  };
}

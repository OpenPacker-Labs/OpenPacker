import { codecFor } from './codecs.js';
import type { RegistryOptions } from './registry.js';
import { resolveGraph } from './resolve.js';
import { solveGraph } from './solve.js';
import { stripPurlVersion } from './spec.js';
import { OpmError } from './types.js';

/** What a tool runs with, as the solve chose it. */
export interface ToolClosure {
  /** Every package the solve selected besides the tool, in solve order. */
  dependencies: { exactPurl: string; purlType: string }[];
  /**
   * What each selected package requires, by its exact PURL: the name it finds
   * each dependency under → that dependency's exact PURL (ADR 0054).
   */
  requires: Map<string, Record<string, string>>;
}

/**
 * The runtime closure of one release of a tool. Undefined when the registry
 * returned nothing to solve against.
 *
 * The tool is held to its own release in the walk and in the solve. Solved from
 * its name alone, the solver chose the newest release, so a tool run at an
 * older one (`opmx pkg:npm/cowsay@1.5.0`) had no edges of its own and was laid
 * out with the dependency versions the newest wants.
 */
export async function solveToolClosure(input: {
  /** The tool's exact PURL. */
  tool: string;
  ecosystem: string;
  options?: RegistryOptions;
}): Promise<ToolClosure | undefined> {
  const base = stripPurlVersion(input.tool);
  const version = decodeURIComponent(
    input.tool.slice(input.tool.lastIndexOf('@') + 1),
  );
  const range = exactNativeRange(input.ecosystem, version);
  const graph = await resolveGraph({
    // Without a range the walk takes the newest few releases, which an old
    // pin may not be among; the solve below is pinned either way.
    roots: [{ purl: base, ...(!(range === undefined) && { range }) }],
    ...(!(input.options === undefined) && { options: input.options }),
  });
  if (graph.packages.length === 0) return undefined;
  const solved = await solveGraph({
    graph,
    rootRequirements: [
      { purl: base, vers: `vers:${input.ecosystem}/${version}` },
    ],
  });
  if (!solved.selected.some((item) => item.identity.exactPurl === input.tool))
    throw new OpmError(
      'UNRESOLVABLE',
      `The closure of ${input.tool} was solved without that release`,
    );
  const exactOf = new Map(
    solved.selected.map((item) => [item.nodeId, item.identity.exactPurl]),
  );
  const requires = new Map<string, Record<string, string>>();
  for (const edge of solved.dependencyEdges) {
    const from = exactOf.get(edge.fromNodeId);
    const to = exactOf.get(edge.toNodeId);
    if (from === undefined || to === undefined) continue;
    requires.set(from, { ...requires.get(from), [edge.installName]: to });
  }
  return {
    dependencies: solved.selected.flatMap(({ identity }) =>
      identity.exactPurl && identity.exactPurl !== input.tool
        ? [{ exactPurl: identity.exactPurl, purlType: identity.purlType }]
        : [],
    ),
    requires,
  };
}

/**
 * A range in the ecosystem's own spelling that admits `version` and nothing
 * else (npm `1.5.0`, PyPI `==1.5.0`, NuGet and Maven `[1.5.0]`, Cargo
 * `=1.5.0`), or undefined when its codec reads none of these that way.
 */
function exactNativeRange(
  ecosystem: string,
  version: string,
): string | undefined {
  const codec = codecFor(ecosystem);
  for (const range of [version, `==${version}`, `=${version}`, `[${version}]`])
    try {
      // One equality constraint (`vers:<type>/=<version>`), which `version` meets.
      if (
        /^vers:[^/]+\/=[^|]+$/u.test(
          codec.parseNativeRange(range).vers ?? '',
        ) &&
        codec.satisfies(version, range)
      )
        return range;
    } catch {
      // Not this ecosystem's spelling of a range.
    }
  return undefined;
}

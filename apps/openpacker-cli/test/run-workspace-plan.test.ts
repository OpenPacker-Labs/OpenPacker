/**
 * What planning `opm run` over HoBo's 791 members costs, counted rather than
 * timed. Discovery reports the directories it read and the entries it saw;
 * the graph is built once, and its edge lists are read through maps that
 * count. A plan that reads the workspace again, builds the graph again or
 * walks the edges more often per member fails here on any machine, where a
 * bound on the clock passed a plan that did all of it twelve times over when
 * the machine was quiet and failed a correct one when it was not.
 */
import { readdir } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { buildRealWorkspace } from './real-workspace-fixture.js';
import { contextWith } from './workspace-fixture.js';

class CountingMap<K, V> extends Map<K, V> {
  reads = 0;
  override get(key: K): V | undefined {
    this.reads += 1;
    return super.get(key);
  }
}

const posix = describe.skipIf(process.platform === 'win32');

/** What discovering HoBo's workspace reads: the same for every plan of it. */
const DISCOVERY = { directoriesRead: 23, entriesRead: 819 };

posix('planning opm run over the HoBo workspace', () => {
  it('discovers once, builds one graph, and reads a fixed amount per member', async () => {
    const { root, fixture } = await buildRealWorkspace('hobo');
    const { planWorkspace } = await import('../src/commands/run-select.js');
    const { SelectionParser } = await import(
      '../src/commands/run-select-args.js'
    );
    const project = await import('@openpacker/opm-project');
    // The plan's own calls, through the module it loads them from: each
    // discovery's report, each graph built, and the reads of every graph's
    // edge lists.
    let discoveries: { directoriesRead: number; entriesRead: number }[] = [];
    let graphs: CountingMap<string, unknown>[] = [];
    const discover = project.discoverWorkspace;
    const graphOf = project.graphOfWorkspace;
    const discovering = vi
      .spyOn(project, 'discoverWorkspace')
      .mockImplementation(async (...args) => {
        const found = await discover(...args);
        if (found !== undefined) discoveries.push(found.stats);
        return found;
      });
    const graphing = vi
      .spyOn(project, 'graphOfWorkspace')
      .mockImplementation((...args) => {
        const graph = graphOf(...args);
        const outgoing = new CountingMap(graph.outgoing);
        const incoming = new CountingMap(graph.incoming);
        graphs.push(outgoing, incoming);
        return { ...graph, outgoing, incoming };
      });
    const plan = async (...tokens: string[]) => {
      const parser = new SelectionParser('run');
      for (let at = 0; at < tokens.length; ) at += parser.accept(tokens, at);
      discoveries = [];
      graphs = [];
      const planned = await planWorkspace(
        parser.result()!,
        root,
        false,
        root,
        contextWith(),
      );
      return {
        planned,
        discoveries,
        graphs: graphs.length / 2,
        edgeReads: graphs.reduce((sum, map) => sum + map.reads, 0),
      };
    };
    try {
      // What is on disk: the root, 791 members and the bare directories.
      const tree = await readdir(root, {
        recursive: true,
        withFileTypes: true,
      });
      const directories =
        1 + tree.filter((entry) => entry.isDirectory()).length;
      const members = Object.keys(fixture.members).length;

      const before = process.memoryUsage();
      const all = await plan('-r');
      const after = process.memoryUsage();
      expect(all.planned.members).toHaveLength(members);
      expect(all.discoveries).toHaveLength(1);
      expect(all.graphs).toBe(1);
      const [stats] = all.discoveries;
      expect(stats!.directoriesRead).toBeLessThanOrEqual(directories);
      expect(stats!.entriesRead).toBeLessThanOrEqual(tree.length);
      // Pins, not margins: discovery lists 23 of the 817 directories and sees
      // 819 of the 1609 entries, and -r reads each chosen member's edges four
      // times (three in the dependency order, one for what each waits on). A
      // plan that reads more fails; one that reads less updates the numbers.
      expect(stats).toEqual(DISCOVERY);
      expect(all.edgeReads).toBe(4 * members);
      expect(after.heapUsed - before.heapUsed).toBeLessThan(200 * 1024 * 1024);

      const closure = await plan('--filter', '...@hobo/core');
      expect(closure.planned.members.length).toBeGreaterThan(10);
      expect(closure.discoveries).toEqual([DISCOVERY]);
      expect(closure.graphs).toBe(1);
      // One more read per selected member: who depends on it, for the filter.
      expect(closure.edgeReads).toBe(5 * closure.planned.members.length);
    } finally {
      discovering.mockRestore();
      graphing.mockRestore();
    }
  });
});

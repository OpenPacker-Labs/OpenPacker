import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The weights of `PARSE_COSTS` are measurements of what V8 allocates for a
 * parsed tree (ADR 0044), and V8 changes. This builds a dozen documents of the
 * shapes that cost most, parses each in a process started with `--expose-gc`,
 * and compares what the finished tree keeps (the heap after a collection, less
 * the heap before) with what the parser says it keeps (`retained`) and what it
 * says it cost (`cost`). The estimate may be above the heap, as it is for every
 * real packument, and never below it by more than a tenth; the cost is above
 * the estimate.
 */

const here = dirname(fileURLToPath(import.meta.url));

const DOCUMENTS = String.raw`
const pad = (i, w) => String(i).padStart(w, '0');
const rep = (f, n) => Array.from({ length: n }, (_, i) => f(i)).join(',');
export default [
  ['an array of empty objects', 300000, (n) => '[' + rep(() => '{}', n) + ']'],
  ['an array of one-element arrays', 200000, (n) => '[' + rep(() => '[1]', n) + ']'],
  ['an array of 14-character strings', 400000, (n) => '[' + rep((i) => '"' + pad(i, 14) + '"', n) + ']'],
  ['an array of 1,000-character strings', 20000, (n) => '[' + rep((i) => '"' + pad(i, 1000) + '"', n) + ']'],
  ['an array of two-byte strings', 200000, (n) => '[' + rep((i) => '"€' + pad(i, 13) + '"', n) + ']'],
  ['objects of one distinct name', 200000, (n) => '[' + rep((i) => '{"' + pad(i, 26) + '":1}', n) + ']'],
  ['objects of five names', 80000, (n) => '[' + rep((i) => '{"a":1,"b":2,"c":3,"d":4,"e":"' + pad(i, 14) + '"}', n) + ']'],
  ['an object in an object', 150000, (n) => '[' + rep((i) => '{"' + pad(i, 26) + '":{}}', n) + ']'],
  ['one object of members that are empty objects', 300000, (n) => '{' + rep((i) => '"' + pad(i, 12) + '":{}', n) + '}'],
  ['one object of members that are numbers', 300000, (n) => '{' + rep((i) => '"' + pad(i, 12) + '":1', n) + '}'],
  ['one object of members that are strings', 300000, (n) => '{' + rep((i) => '"' + pad(i, 12) + '":"' + pad(i, 14) + '"', n) + '}'],
  ['versions of a package', 12000, (n) => '{"versions":{' + rep((i) => '"1.' + i + '.0":{"name":"p","version":"1.' + i + '.0","dependencies":{"a":"^1.0.0","b":"~2.1.0"},"dist":{"integrity":"sha512-' + pad(i, 86) + '","shasum":"' + pad(i, 40) + '","tarball":"https://registry.npmjs.org/p/-/p-1.' + i + '.0.tgz"}}', n) + '}}'],
];
`;

const CHILD = String.raw`
import documents from 'data:text/javascript;base64,${'${DOCS}'}';
import { parseCanonicalJsonCosted } from '@openpacker/canonical';
function measure(name, units, make) {
  const text = make(units);
  global.gc();
  global.gc();
  const before = process.memoryUsage().heapUsed;
  const parsed = parseCanonicalJsonCosted(text);
  global.gc();
  global.gc();
  const kept = process.memoryUsage().heapUsed - before;
  return { name, kept, retained: parsed.retained, cost: parsed.cost, held: parsed.value !== undefined };
}
const out = [];
for (const [name, units, make] of documents) out.push(measure(name, units, make));
console.log(JSON.stringify(out));
`;

describe('the weights of the parse cost', { timeout: 120_000 }, () => {
  it('estimate what the finished tree keeps, and the peak above it', () => {
    const script = CHILD.replace(
      '${DOCS}',
      Buffer.from(DOCUMENTS).toString('base64'),
    );
    const result = spawnSync(
      process.execPath,
      ['--expose-gc', '--input-type=module', '-e', script],
      { cwd: here, encoding: 'utf8', maxBuffer: 1 << 24 },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as {
      name: string;
      kept: number;
      retained: number;
      cost: number;
    }[];
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      // Never more than a tenth below the heap the tree keeps; the estimate is
      // meant to err high, and a document it overestimates by more than 2.5
      // times has a weight that is not true of it.
      expect(
        row.retained,
        `${row.name}: kept ${row.kept}`,
      ).toBeGreaterThanOrEqual(0.9 * row.kept);
      expect(row.retained, `${row.name}: kept ${row.kept}`).toBeLessThanOrEqual(
        2.5 * row.kept,
      );
      // The cost is for the peak, which is more than what is kept.
      expect(row.cost, row.name).toBeGreaterThan(row.retained);
    }
  });
});

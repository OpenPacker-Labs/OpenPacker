import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  PypiCodec,
  type PypiProjectDocument,
  type UvLockDocument,
} from './index.js';

/**
 * A document is cast JSON, so a field the types call text may be missing, null
 * or an array. The message that repeats it said what a template literal says
 * (`undefined`, `null`, `x`), and a field that is not text must not turn a
 * result into an uncoded error.
 */

const provenance = {
  providerId: 'fixture',
  endpoint: 'https://fixtures.test',
  retrievedAt: '2026-10-12T00:00:00Z',
  evaluationTime: '2026-10-12T00:00:00Z',
  metadataDigest: { algorithm: 'sha256' as const, value: '2'.repeat(64) },
};

async function fixture<T>(name: string): Promise<T> {
  const bytes = await readFile(
    new URL(`../../../fixtures/catalogs/pypi/${name}`, import.meta.url),
  );
  // SAFETY: A checked-in fixture, read for what it holds.
  return JSON.parse(bytes.toString()) as T;
}

/** The `v` of a JSON document: whatever the document holds there, typed as text. */
function field(json: string): string {
  return JSON.parse(json).v;
}

const codec = new PypiCodec();

describe('a requires_python that is not text', () => {
  it('is retained as it was when it is an array', async () => {
    const project = await fixture<PypiProjectDocument>('project.json');
    project.info.requires_python = field('{"v":["x"]}');
    const { instance } = await codec.translateMetadata(
      { kind: 'project-version', project, version: '1.0.0' },
      provenance,
    );
    expect(JSON.stringify(instance)).toContain(
      'requires_python=x is Python interpreter compatibility, retained natively',
    );
  });
});

describe('a file with no digests and a name that is not text', () => {
  it.each([
    ['missing', '{}', 'undefined'],
    ['null', '{"v":null}', 'null'],
    ['an array', '{"v":["x"]}', 'x'],
  ])('is said as it was when the name is %s', async (_, json, said) => {
    const project = await fixture<PypiProjectDocument>('project.json');
    for (const file of project.releases['1.0.0'] ?? []) {
      delete file.digests;
      delete file.size;
      file.filename = field(json);
    }
    const { instance } = await codec.translateMetadata(
      { kind: 'project-version', project, version: '1.0.0' },
      provenance,
    );
    expect(JSON.stringify(instance)).toContain(
      `Distribution ${said} lacks sha256 or size; native digests remain in raw metadata`,
    );
  });
});

describe('a uv.lock whose text fields are not text', () => {
  it('keeps a dependency marker that is null', async () => {
    const lock = await fixture<UvLockDocument>('uv.lock.json');
    for (const entry of lock.package)
      for (const dependency of entry.dependencies ?? [])
        if (typeof dependency !== 'string')
          dependency.marker = field('{"v":null}');
    const capture = codec.translateLockResult(lock, provenance);
    expect(JSON.stringify(capture)).toContain(
      'Lock dependency marker null is preserved and never silently evaluated',
    );
  });

  it('keeps a requires-python that is an array', async () => {
    const lock = await fixture<UvLockDocument>('uv.lock.json');
    lock['requires-python'] = field('{"v":["x"]}');
    const capture = codec.translateLockResult(lock, provenance);
    expect(JSON.stringify(capture)).toContain(
      'Lock requires-python=x is retained; interpreter filtering is native',
    );
  });
});

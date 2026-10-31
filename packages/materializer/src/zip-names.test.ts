/**
 * The name of a zip entry: with the UTF-8 flag set it must be UTF-8, and one
 * that is not is a typed refusal like any other bad archive, never the decoder's
 * own TypeError (the tar header text, tar-fields.ts, does the same).
 */

import { describe, expect, it } from 'vitest';
import { inspectArchive, MaterializationError } from './index.js';

/** A zip of one empty stored file whose name is exactly `name`, the UTF-8 flag as `flags` says. */
function zipNamed(name: Uint8Array, flags: number): Uint8Array {
  const local = new Uint8Array(30 + name.byteLength);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint16(6, flags, true);
  localView.setUint16(26, name.byteLength, true);
  local.set(name, 30);
  const central = new Uint8Array(46 + name.byteLength);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 0x0314, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint16(8, flags, true);
  centralView.setUint16(28, name.byteLength, true);
  centralView.setUint32(38, 0o100644 << 16, true);
  central.set(name, 46);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, 1, true);
  eocdView.setUint16(10, 1, true);
  eocdView.setUint32(12, central.byteLength, true);
  eocdView.setUint32(16, local.byteLength, true);
  return Buffer.concat([local, central, eocd]);
}

const UTF8_FLAG = 0x800;
const text = (value: string) => new TextEncoder().encode(value);

/** The code of the typed refusal; anything else the archive throws is rethrown. */
async function refusedWith(archive: Uint8Array): Promise<string | undefined> {
  try {
    await inspectArchive(archive, 'zip');
    return undefined;
  } catch (error) {
    if (error instanceof MaterializationError) return error.code;
    throw error;
  }
}

describe('a zip entry name', () => {
  it('may be any valid UTF-8 when the flag says so', async () => {
    const entries = await inspectArchive(
      zipNamed(text('pkg/café.js'), UTF8_FLAG),
      'zip',
    );
    expect(entries.map(({ path }) => path)).toEqual(['pkg/café.js']);
  });

  it('keeps a leading byte order mark, as zip readers that do not strip it do', async () => {
    const entries = await inspectArchive(
      zipNamed(text('\uFEFFpkg/a.js'), UTF8_FLAG),
      'zip',
    );
    expect(entries.map(({ path }) => path)).toEqual(['\uFEFFpkg/a.js']);
  });

  it.each([
    ['a byte that starts no sequence', [0xff]],
    ['a continuation byte alone', [0x80]],
    ['a sequence cut short', [0xc3, 0x28]],
    ['an overlong sequence', [0xc0, 0xaf]],
    ['a surrogate', [0xed, 0xa0, 0x80]],
  ])(
    'with the flag set and %s is refused as INVALID_ZIP_NAME',
    async (_, bytes) => {
      expect(
        await refusedWith(
          zipNamed(Uint8Array.from([...text('pkg/a'), ...bytes]), UTF8_FLAG),
        ),
      ).toBe('INVALID_ZIP_NAME');
    },
  );

  it('with bytes past 0x7f and no flag still needs an adapter', async () => {
    expect(
      await refusedWith(zipNamed(Uint8Array.from([...text('pkg/a'), 0xe9]), 0)),
    ).toBe('ADAPTER_REQUIRED');
  });
});

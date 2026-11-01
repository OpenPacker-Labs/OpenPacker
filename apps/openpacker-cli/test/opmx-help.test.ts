import { describe, expect, it } from 'vitest';
import { runOpmx } from '../src/opmx.js';

/**
 * `opmx --help` says where opmx's own options go and what a run straight from
 * a registry reads: `opmx pkg:...` returns before any project is read, so a
 * project's `opmx_timeout_ms`, `timeout_ms` and network grants never reach it,
 * and an option after the tool's name is the tool's.
 */

async function help(): Promise<string> {
  let out = '';
  const io = {
    stdout: { write: (chunk: string) => ((out += chunk), true) },
    stderr: { write: () => true },
  };
  await runOpmx(['--help'], io, '/');
  return out.replace(/\s+/gu, ' ');
}

describe('opmx --help', () => {
  it('says its options go before the tool’s name', async () => {
    expect(await help()).toContain(
      "opmx's own options (--timeout, --allow-network, --plugin, --allow-env, --offline, --package, --bin) go before the tool's name; everything after the name is the tool's own.",
    );
  });

  it('says a run straight from a registry reads no project', async () => {
    const text = await help();
    expect(text).toContain(
      'opmx pkg:... reads no project: only these options apply to it.',
    );
    expect(text).toContain('a project grants a package it installed network');
  });
});

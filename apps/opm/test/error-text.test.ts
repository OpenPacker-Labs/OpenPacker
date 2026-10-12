import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  ResponseTooLargeError,
  type HttpRequest,
  type HttpResponse,
} from '@openpacker/adapter-core';
import { defaultAdapterModules } from '@openpacker/adapters-default';
import { OpmError } from '@openpacker/opm-project';
import { RunError } from '../src/commands/run-error.js';
import { formatFailure, parseFailure } from '../src/error-report.js';
import { EXIT_CODES, handleError, runOpm } from '../src/opm.js';

/**
 * What the CLI writes of an error. A message can carry text a registry chose (a
 * dependency's name, a version string, a key in its document) on its way from
 * an adapter, so the one place that writes an error makes it plain: no escape
 * sequence, no control character, no bidirectional override. The line breaks a
 * message carries are kept (`error-lines.test.ts`), so nothing here uses one. A
 * message with none of those is written as it always was.
 */

const ESC = '\u001b';
const BEL = '\u0007';
/** Colours what follows, is split by a tab, and retitles the window. */
const hostile = `dep${ESC}[31m\tx${ESC}]0;pwned${BEL}`;
const plain = 'dep x';

function capture() {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (s: string) => ((out += s), true) },
      stderr: { write: (s: string) => ((err += s), true) },
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

/** A terminal control (C0, DEL, C1), or a line or paragraph separator. */
function holdsControl(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    );
  });
}

function written(error: unknown): { err: string; code: number } {
  const cap = capture();
  const code = handleError(error, cap.io);
  return { err: cap.err, code };
}

describe('an error whose message carries text from a registry', () => {
  it.each([
    [
      'an OpmError',
      new OpmError('UNRESOLVABLE', `Cannot resolve ${hostile}`),
      EXIT_CODES.unsatisfiable,
      `opm: Cannot resolve ${plain}\n`,
    ],
    [
      'a RunError',
      new RunError('NOT_FOUND', `no script ${hostile}`),
      EXIT_CODES.notFound,
      `opm: no script ${plain}\n`,
    ],
    [
      'a provider error',
      new ProviderError('PACKAGE_NOT_FOUND', `${hostile} is not there`),
      EXIT_CODES.notFound,
      `opm: ${plain} is not there\n`,
    ],
    [
      'an error that carries no code',
      new Error(`failed on ${hostile}`),
      EXIT_CODES.internal,
      `opm: internal error: failed on ${plain}\n`,
    ],
  ])('is written as plain text: %s', (_, error, code, text) => {
    expect(written(error)).toEqual({ err: text, code });
  });

  it('is written plainly in a cause chain too', () => {
    const { err } = written(new Error('outer', { cause: new Error(hostile) }));
    expect(err).toBe(
      `opm: internal error: outer\nopm:   caused by: Error: ${plain}\n`,
    );
  });

  it('is plain in a usage failure, and the help that follows is untouched', async () => {
    const help = capture();
    expect(await runOpm(['help'], help.io, process.cwd())).toBe(0);
    const cap = capture();
    expect(await runOpm([`nope${hostile}`], cap.io, process.cwd())).toBe(
      EXIT_CODES.usage,
    );
    expect(cap.err).toBe(`Unknown command: nope${plain}\n\n${help.out}\n`);
  });

  it('is plain in opmx, which writes the same report', () => {
    const coded = Object.assign(new Error(`failed on ${hostile}`), {
      code: 'UNAVAILABLE',
    });
    for (const [error, text] of [
      [coded, `opmx: failed on ${plain}\n`],
      [new Error(`failed on ${hostile}`), `opmx: failed on ${plain}\n`],
    ] as const)
      expect(
        formatFailure(parseFailure(error), { tool: 'opmx', env: {} }),
      ).toBe(text);
  });

  it('is plain when a message cannot hide a secret behind a control character', () => {
    // Removed before the secrets are withheld, not after: a character taken out
    // of the middle must not join the halves of a credential into a shape that
    // was never redacted.
    const { err } = written(new Error('pass\u200bword=hunter2'));
    expect(err).toBe('opm: internal error: password=[REDACTED]\n');
  });
});

describe('a secret that a NEL would split or separate', () => {
  // NEL (U+0085) is a C1 control. The scrubber reads white space as `\\s`, which
  // does not match it, so it is removed with the other controls and not spaced:
  // a space would end the URL, or split the name, that the scrubber has to read.
  const NEL = '\u0085';

  it.each([
    [
      'a URL with a password after the scheme',
      `see https://${NEL}u:CANARY@h/p now`,
      'see https://h/p now',
    ],
    [
      'a name with the separator after a NEL',
      `password${NEL}=hunter2`,
      'password=[REDACTED]',
    ],
    ['a name split by a NEL', `pass${NEL}word=hunter2`, 'password=[REDACTED]'],
  ])('is withheld: %s', (_, message, expected) => {
    expect(written(new Error(message)).err).toBe(
      `opm: internal error: ${expected}\n`,
    );
  });
});

describe('a registry document read by the real provider', () => {
  function provider(document: unknown) {
    const npm = defaultAdapterModules().find(
      (module) => module.id === 'org.openpacker.adapter.npm',
    );
    const catalog = npm?.catalog?.({
      transport: {
        async request(request: HttpRequest): Promise<HttpResponse> {
          return {
            status: 200,
            headers: {},
            body: new TextEncoder().encode(JSON.stringify(document)),
            url: request.url,
          };
        },
      },
      now: () => '2026-10-12T00:00:00Z',
    });
    if (catalog === undefined) throw new Error('no npm adapter');
    return catalog;
  }

  const version = (fields: Record<string, unknown>) => ({
    name: 'p',
    'dist-tags': { latest: '1.0.0' },
    modified: '2026-10-12T00:00:00.000Z',
    versions: {
      '1.0.0': {
        name: 'p',
        version: '1.0.0',
        dist: { tarball: 'https://registry.npmjs.org/p/-/p-1.0.0.tgz' },
        ...fields,
      },
    },
  });

  async function refused(document: unknown): Promise<Error> {
    try {
      await provider(document).inspect('pkg:npm/p@1.0.0');
    } catch (error) {
      if (error instanceof Error) return error;
    }
    throw new Error('the document was accepted');
  }

  it('is written plainly when a version is not one', async () => {
    const error = await refused(version({ version: `1.0.0${hostile}` }));
    // Made plain where the adapter quotes it, which removes a tab and does not
    // space it; the writer then has nothing left to remove.
    expect(written(error)).toEqual({
      err: 'opm: Invalid version: 1.0.0depx\n',
      code: EXIT_CODES.internal,
    });
  });

  it('is written plainly when a dependency has a name or a range it cannot use', async () => {
    for (const dependencies of [
      { [hostile]: '^1' },
      { dep: `git+https://x.test/${hostile}` },
    ]) {
      const { err, code } = written(await refused(version({ dependencies })));
      expect(code).toBe(EXIT_CODES.internal);
      expect(err.endsWith('\n')).toBe(true);
      expect(holdsControl(err.slice(0, -1))).toBe(false);
    }
  });
});

describe('a message with nothing to remove', () => {
  it.each([
    [
      'a missing generation',
      new OpmError(
        'NOT_FOUND',
        'There is no earlier generation to roll back to',
      ),
      EXIT_CODES.notFound,
      'opm: There is no earlier generation to roll back to\n',
    ],
    [
      'a document over the limit',
      new ResponseTooLargeError(67_108_864, 67_108_865, 'delivered', 200).about(
        'The packument of @scope/name',
      ),
      EXIT_CODES.unavailable,
      'opm: The packument of @scope/name is 67108865 bytes (64.00 MiB) and exceeds the limit of 67108864 bytes (64.00 MiB)\n',
    ],
    [
      'a policy that could not decide',
      new OpmError(
        'POLICY_INDETERMINATE',
        'Supply-chain policy indeterminate: publishedAt/evaluationTime not captured for minimum release age: The full packument of heavy is not usable: Duplicate object member: xy… (2097170 characters) at byte 2097244',
      ),
      EXIT_CODES.policyDenied,
      'opm: Supply-chain policy indeterminate: publishedAt/evaluationTime not captured for minimum release age: The full packument of heavy is not usable: Duplicate object member: xy… (2097170 characters) at byte 2097244\n',
    ],
    [
      'text in several scripts',
      new ProviderError('PACKAGE_NOT_FOUND', 'naïve ключ 键 \u{1f511}: "a  b"'),
      EXIT_CODES.notFound,
      'opm: naïve ключ 键 \u{1f511}: "a  b"\n',
    ],
    [
      'an error with no code',
      new Error('boom'),
      EXIT_CODES.internal,
      'opm: internal error: boom\n',
    ],
  ])('is written as it was: %s', (_, error, code, text) => {
    expect(written(error)).toEqual({ err: text, code });
  });

  it('keeps the help of a usage failure as it was', async () => {
    const help = capture();
    await runOpm(['help'], help.io, process.cwd());
    const cap = capture();
    await runOpm(['frobnicate'], cap.io, process.cwd());
    expect(cap.err).toBe(`Unknown command: frobnicate\n\n${help.out}\n`);
  });
});

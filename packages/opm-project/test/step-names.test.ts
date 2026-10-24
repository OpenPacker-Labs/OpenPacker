import { randomUUID } from 'node:crypto';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  abandonStep,
  printable,
  projectStep,
  recoverInterruptedSteps,
} from '../src/index.js';
import { project } from './rollback-support.js';

configureDefaultAdapters();

/**
 * A name in `.opm` is text from a file a repository can ship, and a refusal
 * prints it: a lock's or a copy's name with a terminal escape in it must not
 * reach the terminal (S4; the host and the project path were N3). Every name
 * becomes text through one function.
 */

const ESC = '\u001b';
/** Whether a terminal would take any of `text` for a command. */
const controls = (text: string): boolean =>
  [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });

/** The message of the refusal `work` ends in. */
async function refusal<T>(work: () => Promise<T>): Promise<string> {
  const error = await work().then(
    () => undefined,
    (thrown: Error) => thrown,
  );
  expect(error).toBeDefined();
  return error!.message;
}

describe('a name in .opm with a terminal escape in it', () => {
  it('is printed without it in the refusal of a step that finds the lock', async () => {
    const root = await project(['base']);
    await writeFile(
      join(root, '.opm', `step-${ESC}]0;PWNED\u0007.lock`),
      'not a lock',
    );
    const message = await refusal(() =>
      projectStep(root, { waitMs: 0 }, async () => 'x'),
    );
    expect(controls(message)).toBe(false);
    expect(message).toContain('.opm/step-?]0;PWNED?.lock');
  });

  it('is printed without it where the copy is a link', async () => {
    const root = await project(['base']);
    await symlink(
      '/nonexistent',
      join(root, '.opm', `.rollback-${ESC}[31mRED${ESC}[0m`),
    );
    const message = await refusal(() => recoverInterruptedSteps(root));
    expect(controls(message)).toBe(false);
    expect(message).toContain('.opm/.rollback-?[31mRED?[0m');
  });

  it('is printed without it where the copy has a record that is not one', async () => {
    const root = await project(['base']);
    const dir = join(root, '.opm', `.rollback-${ESC}]0;PWNED\u0007`);
    await mkdir(dir);
    await writeFile(join(dir, 'rollback.json'), '{}');
    const message = await refusal(() => recoverInterruptedSteps(root));
    expect(controls(message)).toBe(false);
    expect(message).toContain('.opm/.rollback-?]0;PWNED?/rollback.json');
  });

  it('is printed without it in the listing of what --abandon-step could have named', async () => {
    const root = await project(['base']);
    await writeFile(join(root, '.opm', `step-${ESC}[2Jx.lock`), 'not a lock');
    const message = await refusal(() => abandonStep(root, randomUUID()));
    expect(controls(message)).toBe(false);
    expect(message).toContain('step-?[2Jx.lock');
  });

  it('is printed without it where --abandon-step is refused for the lock', async () => {
    const root = await project(['base']);
    await writeFile(join(root, '.opm', `step-${ESC}[2Jx.lock`), 'not a lock');
    const message = await refusal(() =>
      abandonStep(root, `${ESC}[2Jx`, { waitMs: 0 }),
    );
    expect(controls(message)).toBe(false);
    expect(message).toContain('.opm/step-?[2Jx.lock');
  });
});

describe('text shown from a file', () => {
  it.each([
    ['C0 controls', 'a\u0000b\u0007c\u001bd', 'a?b?c?d'],
    ['a newline', 'a\nb', 'a?b'],
    ['DEL', 'a\u007fb', 'a?b'],
    ['C1 controls, CSI among them', 'a\u0085b\u009bc\u009fd', 'a?b?c?d'],
    ['text that is fine', 'step-4f2a.lock é ü 日本', 'step-4f2a.lock é ü 日本'],
  ])('keeps %s as the terminal can show it', (_what, text, shown) => {
    expect(printable(text)).toBe(shown);
  });
});

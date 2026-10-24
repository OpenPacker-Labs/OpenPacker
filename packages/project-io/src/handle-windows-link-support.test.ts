import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MEMBER,
  cleanup,
  handles,
  project,
} from './handle-windows-link-support.js';

/**
 * The set-up the Windows-only link suites share, run where every platform can.
 *
 * Nothing in it is Windows specific, and those suites run only on a Windows
 * leg, so a mistake in this file would surface there first. Here it is made to
 * do what they rely on: a project with a member and an open `node_modules`, and
 * a cleanup that closes the handle and removes the project.
 */

afterEach(cleanup);

describe('the shared set-up of the Windows link suites', () => {
  it('makes a project with a member and an open node_modules', async () => {
    const made = await project();
    expect((await stat(made.member)).isDirectory()).toBe(true);
    expect((await made.modules.stat()).isDirectory()).toBe(true);
    expect(made.site).toEqual({
      directory: 'node_modules',
      projectRoot: made.root,
    });
    expect(made.link('left-pad')).toBe(
      join(made.root, 'node_modules', 'left-pad'),
    );
    expect(handles).toContain(made.modules);
    expect(MEMBER).toBe('../packages/pkg');
  });

  it('closes what it opened and removes what it made', async () => {
    const made = await project();
    await cleanup();
    expect(handles).toEqual([]);
    await expect(made.modules.stat()).rejects.toMatchObject({
      code: 'EBADF',
    });
    await expect(stat(made.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

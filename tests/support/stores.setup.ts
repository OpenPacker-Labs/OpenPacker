import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach } from 'vitest';
import { forgetBases } from '../../packages/project-io/src/trusted-base.js';

/**
 * Fresh store, cache and plugin directories for every test file.
 *
 * opm reads a user-level store or cache location from OPM_STORE_HOME (the
 * shared store), OPM_TOOL_CACHE (the opmx tool cache), OPM_PLUGIN_HOME (the
 * plugin store), XDG_CACHE_HOME (where the first two default to, else
 * `~/.cache`) and XDG_DATA_HOME (the plugin store's default, else
 * `~/.local/share`). A run inherits the caller's environment, so a caller that
 * exported OPM_STORE_HOME had every install in the suite use its real store,
 * and a test that tampers with a store file wrote through a hard link into it.
 *
 * XDG_CACHE_HOME and XDG_DATA_HOME name a fresh directory, removed after the
 * file, and the three OPM_ variables are unset, as in CI: the library uses no
 * shared store unless a test names one, and every default lands in the fresh
 * directory. Pointing OPM_STORE_HOME itself at a fresh store instead turns the
 * shared store on for every test, which the suites are not written for (61 of
 * opm-project's tests then fail). `store-guard.setup.ts` fails a test whose
 * environment resolves a store outside the temporary directory.
 *
 * HOME and XDG_CONFIG_HOME stay the caller's. What is read through them (an
 * installed .NET under `~/.dotnet`, the registry auth configuration, the home
 * directory the sandbox denies) is only read, and depends on the machine
 * (docs/guides/testing.md, "What a test run may touch").
 */
// Named, not created: the library makes what it uses, so a file whose tests
// are all skipped (and whose afterAll therefore never runs) leaves nothing.
const root = join(tmpdir(), `opm-test-stores-${randomUUID()}`);
delete process.env.OPM_STORE_HOME;
delete process.env.OPM_TOOL_CACHE;
delete process.env.OPM_PLUGIN_HOME;
process.env.XDG_CACHE_HOME = join(root, 'cache');
process.env.XDG_DATA_HOME = join(root, 'data');
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Each test is a command of its own, as `runOpm` and `runOpmx` begin one: the
// bases and fences one took are not the next one's, and a TMPDIR a test makes
// again at the same path is a new directory, not one retargeted mid-command
// (ADR 0034, trusted bases). The record is the process's, whichever build of
// project-io wrote it.
afterEach(() => forgetBases());

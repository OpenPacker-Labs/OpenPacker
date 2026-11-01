#!/usr/bin/env node
/**
 * Process entry of `opmx`. It runs without asking whether it is the entry: a
 * package manager starts a bin through a link, and comparing `import.meta.url`
 * with `process.argv[1]` is false then, which ran nothing and exited 0.
 */
import { runOpmxFromProcess } from './opmx.js';

process.exitCode = await runOpmxFromProcess();

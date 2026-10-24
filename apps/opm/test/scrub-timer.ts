/**
 * Run by `scrub-linear.test.ts` in a child process: `scrub` on one hostile of
 * `scrub-hostile.ts`, timed, with the answer checked. It is a child because a
 * scrubber that rescans takes minutes on a mebibyte (half an hour for a run of
 * `a-`) and a regular expression cannot be interrupted in the process that is
 * running it; the parent kills the child instead.
 */
import { scrub } from '../src/scrub.ts';
import { HOSTILE, build } from './scrub-hostile.ts';

const hostile = HOSTILE.find((candidate) => candidate.name === process.argv[2]);
if (hostile === undefined)
  throw new Error(`no hostile named ${process.argv[2]}`);
const { input, expected } = build(hostile);
const started = performance.now();
const output = scrub(input);
const milliseconds = performance.now() - started;
process.stdout.write(
  JSON.stringify({
    milliseconds,
    length: input.length,
    correct: output === expected,
  }),
);

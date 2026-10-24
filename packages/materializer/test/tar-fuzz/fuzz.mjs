/**
 * The judging half of the differential fuzz of `requireNpmReaderAgreement`
 * (ADR 0058 section 8); run.mjs is its command line and
 * src/tar-fuzz.test.ts a bounded run of it in the materializer's suite.
 *
 * Each archive is read by node-tar 6.2.1 (npm 10) and, when given, node-tar
 * 7.5.22 (npm 11), each as `Parse` fed whole and in pieces of 1, 1,460, 16,384
 * and 65,536 bytes; by pnpm 10.28.0's `parseTarball`; by opm in npm mode; and,
 * with `pacote`, by `tar.x` with pacote's filter for each node-tar line. A
 * reading is the files installed (the first path component stripped, a later
 * entry replacing an earlier one at its path) with their execute bits. The
 * readers agree when every node-tar reading is pnpm's.
 *
 * Classes: `agree, opm extracts the same`; `over-refused <code>` (the `Parse`
 * readings and pnpm agree, opm refuses; `tar.x` is run only on what opm
 * extracts, so an archive only `tar.x` fails on, such as an empty one, is
 * counted here); `refused <code>` (they differ, opm refuses); `inconclusive: ...`
 * (pnpm missed its deadline, or node-tar never ended: the archive was not
 * judged); and the failures, `UNSAFE-ACCEPTED` (they differ and opm extracts),
 * `UNSAFE-SET` (they agree and opm extracts something else) and `UNSAFE-TARX`
 * (opm extracts and `tar.x` fails or writes something else).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { pacoteInstalls } from '../tar-oracle/pacote.mjs';
import { FEEDS, loadNodeTar, nodeTar } from '../tar-oracle/readers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PNPM_DEADLINE_MS = 3000;
const NODE_TAR_DEADLINE_MS = 5000;

/** A reading as one comparable string: path, text, execute bit, sorted by path. */
function key({ entries, executable }) {
  const run = new Set(executable ?? []);
  const files = new Map(
    entries.map(([path, text]) => [path.replace(/\/$/u, ''), text]),
  );
  return JSON.stringify(
    [...files]
      .map(([path, text]) => [path, text, run.has(path)])
      .sort(([left], [right]) => (left < right ? -1 : 1)),
  );
}

const IGNORE_FILE = /(^|\/)\.(git|npm)ignore$/u;
/** pacote renames `.gitignore` to `.npmignore`: compare what `tar.x` wrote without the ignore files. */
const withoutIgnoreFiles = ({ entries, executable }) => ({
  entries: entries.filter(([path]) => !IGNORE_FILE.test(path)),
  executable: (executable ?? []).filter((path) => !IGNORE_FILE.test(path)),
});

class Deadline extends Error {}
const deadline = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Deadline('timed out')), ms).unref(),
    ),
  ]);

/** pnpm in a worker with a deadline: it spins for minutes on an `x` header whose size runs past the data. */
function pnpmReader(pnpmDirectory) {
  let worker;
  let calls = 0;
  const spawn = () => {
    worker = new Worker(join(here, 'pnpm-worker.mjs'), {
      workerData: { pnpmDirectory },
    });
  };
  spawn();
  return {
    read(bytes) {
      calls += 1;
      const id = calls;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          worker.off('message', onMessage);
          worker.terminate();
          spawn();
          resolve({ missed: true });
        }, PNPM_DEADLINE_MS);
        function onMessage(message) {
          if (message.id !== id) return;
          clearTimeout(timer);
          worker.off('message', onMessage);
          resolve(message.result);
        }
        worker.on('message', onMessage);
        worker.postMessage({ id, bytes });
      });
    },
    close: () => worker.terminate(),
  };
}

/**
 * The readers for a run: `opm` is the materializer module (its built entry or a
 * bundle of src/index.ts), the others release directories (see README.md).
 */
export function openReaders({ opm, nodeTar6, nodeTar7, pnpm, pacote }) {
  const lines = [loadNodeTar(nodeTar6, '6.2.1')];
  if (nodeTar7) lines.push(loadNodeTar(nodeTar7, '7.5.22'));
  const npmMode = {
    ...opm.DEFAULT_MATERIALIZATION_LIMITS,
    acceptRedundantEntries: true,
    requireNpmReaderAgreement: true,
  };
  const pnpmRead = pnpmReader(pnpm);
  // An uncaught exception from inside tar.x is an answer (pacote.mjs records it).
  process.on('uncaughtException', () => undefined);

  async function opmRead(bytes) {
    try {
      const files = (
        await opm.inspectArchive(new Uint8Array(bytes), 'tar', npmMode)
      ).filter(({ type }) => type === 'file');
      const installed = ({ path }) => path.split('/').slice(1).join('/');
      return {
        entries: files.map((file) => [
          installed(file),
          Buffer.from(file.data).toString(),
        ]),
        executable: files
          .filter(({ mode }) => ((mode ?? 0) & 0o111) !== 0)
          .map(installed),
      };
    } catch (error) {
      return { code: error.code ?? `ERROR ${String(error.message)}` };
    }
  }

  /** Every node-tar reading of `bytes`, or undefined when one never ended. */
  async function npmReadings(bytes) {
    const readings = [];
    try {
      for (const line of lines)
        for (const piece of [bytes.length, ...FEEDS])
          readings.push(
            key(
              await deadline(nodeTar(line, bytes, piece), NODE_TAR_DEADLINE_MS),
            ),
          );
    } catch (error) {
      if (error instanceof Deadline) return undefined;
      readings.push(`node-tar threw ${error.message}`);
    }
    return readings;
  }

  /** The class of one archive, and what to print about it when it fails. */
  async function judge(bytes) {
    const npm = await npmReadings(bytes);
    if (npm === undefined)
      return { verdict: 'inconclusive: node-tar did not end' };
    const fromPnpm = await pnpmRead.read(bytes);
    if (fromPnpm.missed)
      return { verdict: 'inconclusive: pnpm missed its deadline' };
    const pnpmKey = fromPnpm.error
      ? `pnpm threw ${fromPnpm.error}`
      : key(fromPnpm);
    const agree = npm.every((reading) => reading === pnpmKey);
    const opmResult = await opmRead(bytes);
    if (opmResult.code !== undefined)
      return {
        verdict: `${agree ? 'over-refused' : 'refused'} ${opmResult.code}`,
      };
    const returned = key(opmResult);
    if (!agree)
      return {
        verdict: 'UNSAFE-ACCEPTED',
        detail: `node-tar ${[...new Set(npm)].join(' | ').slice(0, 240)}; pnpm ${pnpmKey.slice(0, 120)}; opm ${returned.slice(0, 120)}`,
      };
    if (returned !== pnpmKey)
      return {
        verdict: 'UNSAFE-SET',
        detail: `readers ${pnpmKey.slice(0, 160)}; opm ${returned.slice(0, 160)}`,
      };
    if (pacote)
      for (const line of lines) {
        const written = await pacoteInstalls(line, bytes);
        if (
          written.error !== undefined ||
          key(withoutIgnoreFiles(written)) !==
            key(withoutIgnoreFiles(opmResult))
        )
          return {
            verdict: 'UNSAFE-TARX',
            detail: `tar.x ${line.version} ${written.error ?? key(written).slice(0, 160)}; opm ${returned.slice(0, 160)}`,
          };
      }
    return { verdict: 'agree, opm extracts the same' };
  }

  return {
    judge,
    close: () => pnpmRead.close(),
    versions: lines.map(({ version }) => version),
  };
}

/** Judge every archive of `archives`; the counts by class and up to five failing archives per class. */
export async function runFamily(readers, archives) {
  const histogram = new Map();
  const samples = new Map();
  let total = 0;
  for (const { label, blocks } of archives) {
    total += 1;
    const bytes = Buffer.concat(blocks);
    const { verdict, detail } = await readers.judge(bytes);
    histogram.set(verdict, (histogram.get(verdict) ?? 0) + 1);
    if (verdict.startsWith('UNSAFE')) {
      const kept = samples.get(verdict) ?? [];
      if (kept.length < 5)
        samples.set(verdict, [
          ...kept,
          { label, detail, base64: bytes.toString('base64') },
        ]);
    }
  }
  const unsafe = [...histogram]
    .filter(([verdict]) => verdict.startsWith('UNSAFE'))
    .reduce((sum, [, count]) => sum + count, 0);
  return { total, histogram, samples, unsafe };
}

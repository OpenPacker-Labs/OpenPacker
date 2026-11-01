import { out, outJson } from '@openpacker/canonical';
import {
  environmentScript,
  environmentVariables,
  loadDevShellContext,
  parseShellIsolatePrefer,
  requireOpmRoot,
  type ShellIsolatePrefer,
} from '@openpacker/opm-project';
import {
  probeDevShellBackends,
  runDevShell,
  runInteractiveDevShell,
  SandboxBackendError,
} from '@openpacker/sandbox';
import { EXIT_CODES } from '../exit-codes.js';
import { report } from '../error-report.js';
import type { CommandArgs, CommandIo } from './yank.js';

function isolatePreferFromArgs(
  args: CommandArgs,
  manifestDefault: ShellIsolatePrefer | 'off',
): ShellIsolatePrefer {
  const raw = args.options.get('isolate');
  if (raw === undefined) return 'auto';
  if (raw === true) {
    return manifestDefault === 'off' ? 'auto' : manifestDefault;
  }
  return parseShellIsolatePrefer(raw, 'auto') as ShellIsolatePrefer;
}

export async function runShellCommand(
  args: CommandArgs,
  io: CommandIo,
  cwd: string,
): Promise<number> {
  const root = await requireOpmRoot(cwd);
  const isolateRequested = args.options.has('isolate');

  if (!isolateRequested) {
    if (args.options.has('json')) {
      const environment = await environmentVariables({ root });
      outJson(io, JSON.stringify(environment, null, 2));
      return EXIT_CODES.success;
    }
    out(io, await environmentScript({ root }));
    return EXIT_CODES.success;
  }

  const { plan, prefer: manifestPrefer } = await loadDevShellContext({
    root,
    cwd,
  });
  const prefer = isolatePreferFromArgs(args, manifestPrefer);
  const cmdArgv = args.positionals.length > 0 ? args.positionals : undefined;

  if (cmdArgv) {
    try {
      const { exitCode, backend } = await runDevShell({
        plan,
        prefer,
        argv: cmdArgv,
      });
      if (exitCode !== 0) {
        io.stderr.write(
          report('opm: ', `isolated shell (${backend}) exited ${exitCode}`),
        );
      }
      return exitCode;
    } catch (error) {
      if (
        error instanceof SandboxBackendError &&
        error.code === 'UNAVAILABLE'
      ) {
        io.stderr.write(report('opm: ', error.message));
        const probes = await probeDevShellBackends();
        io.stderr.write(
          report(
            'opm: ',
            probes
              .map((p) => `${p.id}=${p.available ? 'yes' : 'no'}`)
              .join(' '),
          ),
        );
        return EXIT_CODES.unavailable;
      }
      throw error;
    }
  }

  try {
    return await runInteractiveDevShell({ plan, prefer });
  } catch (error) {
    if (error instanceof SandboxBackendError && error.code === 'UNAVAILABLE') {
      io.stderr.write(report('opm: ', error.message));
      return EXIT_CODES.unavailable;
    }
    throw error;
  }
}

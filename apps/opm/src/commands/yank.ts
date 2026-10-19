import { OpmError, yankRegistryVersion } from '@openpacker/opm-project';
import { writeYanked } from '../terminal-records.js';

export interface CommandArgs {
  positionals: string[];
  options: Map<string, string | true>;
}

export interface CommandIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export async function runYankCommand(
  args: CommandArgs,
  io: CommandIo,
  _cwd: string,
): Promise<number> {
  if (args.options.has('offline'))
    throw new OpmError(
      'OFFLINE',
      'opm yank refuses --offline; a PREX registry round-trip is required',
    );
  const purl = args.positionals[0];
  if (!purl)
    throw new OpmError(
      'INVALID_SPEC',
      'opm yank requires an exact PURL: opm yank pkg:type/name@version',
    );
  const registry = option(args, 'registry');
  const reason = option(args, 'reason');
  const result = await yankRegistryVersion({
    purl,
    ...(!(registry === undefined) && { registry }),
    ...(!(reason === undefined) && { reason }),
    env: process.env,
  });
  const subject = result.applied.subject;
  const shown =
    'exactPurl' in subject && subject.exactPurl ? subject.exactPurl : purl;
  writeYanked(shown, io);
  return 0;
}

function option(args: CommandArgs, name: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

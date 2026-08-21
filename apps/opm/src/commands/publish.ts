import { isAbsolute, resolve } from 'node:path';
import {
  OpmError,
  projectPaths,
  publishPackedArtifact,
  readManifestFile,
  requireOpmRoot,
} from '@openpacker/opm-project';

export interface CommandArgs {
  positionals: string[];
  options: Map<string, string | true>;
}

export interface CommandIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export async function runPublishCommand(
  args: CommandArgs,
  io: CommandIo,
  cwd: string,
): Promise<number> {
  if (args.options.has('offline'))
    throw new OpmError(
      'OFFLINE',
      'opm publish refuses --offline; a PREX registry round-trip is required',
    );
  const fromOpt = option(args, 'from');
  const pack = option(args, 'pack');
  const packageVersion = option(args, 'package-version');
  const registry = option(args, 'registry');
  if (fromOpt === undefined && pack === undefined)
    throw new OpmError(
      'INVALID_SPEC',
      'opm publish requires --from <dir> or --pack <ecosystem>',
    );
  const from =
    fromOpt === undefined
      ? undefined
      : isAbsolute(fromOpt)
        ? fromOpt
        : resolve(cwd, fromOpt);
  let packInput:
    | {
        root: string;
        ecosystem: string;
        version: string;
        name: string;
        outputDirectory?: string;
      }
    | undefined;
  if (pack !== undefined) {
    if (packageVersion === undefined || packageVersion === '')
      throw new OpmError(
        'INVALID_SPEC',
        'opm publish --pack requires --package-version',
      );
    const root = await requireOpmRoot(cwd);
    const manifest = await readManifestFile(projectPaths(root).manifest);
    packInput = {
      root,
      ecosystem: pack,
      version: packageVersion,
      name: option(args, 'name') ?? manifest.project.name,
      ...(!(from === undefined) && { outputDirectory: from }),
    };
  }
  const result = await publishPackedArtifact({
    ...(!(from === undefined) && { from }),
    ...(!(packInput === undefined) && { pack: packInput }),
    ...(!(registry === undefined) && { registry }),
    env: process.env,
  });
  const name =
    result.request.location.annotations?.['openpacker.package.name'] ??
    result.request.descriptor.fileName ??
    'package';
  const version =
    result.request.location.annotations?.['openpacker.package.version'] ?? '';
  io.stdout.write(
    `Published ${name}${version ? `@${version}` : ''} to ${result.registry}\n`,
  );
  return 0;
}

function option(args: CommandArgs, name: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

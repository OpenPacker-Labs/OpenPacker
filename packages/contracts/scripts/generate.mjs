import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { format, resolveConfig } from 'prettier';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const sourceDirectory = path.join(root, 'spec/prex/v1/schemas');
const projectionSource = path.join(
  root,
  'spec/prex/v1/digest-projections.json',
);
const output = path.join(here, '../src/generated.ts');
const schemaOutput = path.join(here, '../schemas');
const prettierConfig = (await resolveConfig(output)) ?? {};
const check = process.argv.includes('--check');
const names = (await readdir(sourceDirectory))
  .filter((name) => name.endsWith('.schema.json'))
  .sort();
const documents = new Map();
for (const name of names)
  documents.set(
    name,
    JSON.parse(await readFile(path.join(sourceDirectory, name), 'utf8')),
  );
const digestProjections = JSON.parse(await readFile(projectionSource, 'utf8'));

function pointer(document, fragment) {
  return fragment
    .split('/')
    .slice(1)
    .reduce(
      (value, part) => value[part.replaceAll('~1', '/').replaceAll('~0', '~')],
      document,
    );
}

function reference(ref, currentFile) {
  const [file = currentFile, fragment = ''] = ref.split('#');
  const document = documents.get(file || currentFile);
  if (!document) throw new Error(`Unknown schema reference: ${ref}`);
  return fragment ? pointer(document, fragment) : document;
}

function typeOf(schema, currentFile, seen = new Set()) {
  if (schema === true) return 'JsonValue';
  if (schema === false) return 'never';
  if (!schema || Object.keys(schema).length === 0) return 'JsonValue';
  if (schema.$ref) {
    const match = schema.$ref.match(/#\/\$defs\/([^/]+)$/);
    if (match) return match[1];
    const key = `${currentFile}:${schema.$ref}`;
    if (seen.has(key)) return 'JsonValue';
    return typeOf(
      reference(schema.$ref, currentFile),
      schema.$ref.split('#')[0] || currentFile,
      new Set([...seen, key]),
    );
  }
  if ('const' in schema) return JSON.stringify(schema.const);
  if (schema.enum)
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (schema.allOf && !schema.properties)
    return schema.allOf
      .map((item) => `(${typeOf(item, currentFile, seen)})`)
      .join(' & ');
  if (schema.oneOf || schema.anyOf)
    return (schema.oneOf ?? schema.anyOf)
      .map((item) => `(${typeOf(item, currentFile, seen)})`)
      .join(' | ');
  if (Array.isArray(schema.type))
    return schema.type
      .map((item) => typeOf({ type: item }, currentFile, seen))
      .join(' | ');
  if (schema.type === 'array')
    return `Array<${typeOf(schema.items ?? {}, currentFile, seen)}>`;
  if (schema.type === 'object' || schema.properties) {
    const required = new Set(schema.required ?? []);
    const properties = Object.entries(schema.properties ?? {}).map(
      ([key, value]) =>
        `${JSON.stringify(key)}${required.has(key) ? '' : '?'}: ${typeOf(value, currentFile, seen)};`,
    );
    if (schema.additionalProperties && schema.additionalProperties !== true)
      properties.push(
        `[key: string]: ${typeOf(schema.additionalProperties, currentFile, seen)};`,
      );
    else if (schema.additionalProperties === true)
      properties.push('[key: string]: JsonValue;');
    return `{ ${properties.join(' ')} }`;
  }
  if (schema.type === 'string') return 'string';
  if (schema.type === 'integer' || schema.type === 'number') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'null') return 'null';
  return 'JsonValue';
}

const exports = [];
for (const [file, document] of documents) {
  for (const [name, schema] of Object.entries(document.$defs ?? {}))
    exports.push(`export type ${name} = ${typeOf(schema, file)};`);
  if (file === 'lockfile.schema.json')
    exports.push(`export type OpenPackerLockfile = ${typeOf(document, file)};`);
}

const catalog = Object.fromEntries(
  [...documents.values()].map((schema) => [schema.$id, schema]),
);
const source =
  `// Generated from spec/prex/v1/schemas by scripts/generate.mjs. Do not edit.\n` +
  `export type JsonPrimitive = null | boolean | number | string;\n` +
  `export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };\n\n` +
  exports.sort().join('\n') +
  `\n\nexport const DIGEST_PROJECTIONS = ${JSON.stringify(digestProjections, null, 2)} as const;` +
  `\n\nexport const schemaCatalog: Record<string, JsonValue> = ${JSON.stringify(catalog, null, 2)};\n`;
const text = await format(source, { ...prettierConfig, filepath: output });
const schemaCopies = new Map(
  await Promise.all(
    names.map(async (name) => [
      name,
      await format(JSON.stringify(documents.get(name)), {
        ...prettierConfig,
        filepath: name,
      }),
    ]),
  ),
);

if (check) {
  if ((await readFile(output, 'utf8').catch(() => '')) !== text)
    throw new Error(
      'Generated contracts are stale; run npm run generate -w @openpacker/contracts',
    );
  for (const [name, contents] of schemaCopies) {
    if (
      (await readFile(path.join(schemaOutput, name), 'utf8').catch(
        () => '',
      )) !== contents
    )
      throw new Error(
        `Generated schema copy is stale: ${name}; run npm run generate -w @openpacker/contracts`,
      );
  }
} else {
  await writeFile(output, text);
  await Promise.all(
    [...schemaCopies].map(([name, contents]) =>
      writeFile(path.join(schemaOutput, name), contents),
    ),
  );
}

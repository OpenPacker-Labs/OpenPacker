import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { format } from 'prettier';

const here = path.dirname(fileURLToPath(import.meta.url));
const directory = path.resolve(here, '../../../spec/prex/v1/schemas');
const specDirectory = path.dirname(directory);
const files = (await readdir(directory))
  .filter((name) => name.endsWith('.schema.json'))
  .sort();
const ids = new Set();
for (const file of files) {
  const schema = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema')
    throw new Error(`${file}: not JSON Schema 2020-12`);
  if (
    typeof schema.$id !== 'string' ||
    !schema.$id.endsWith(`/schemas/${file}`)
  )
    throw new Error(`${file}: unstable or missing $id`);
  if (ids.has(schema.$id)) throw new Error(`${file}: duplicate $id`);
  ids.add(schema.$id);
}
if (files.length < 7) throw new Error('PREX schema catalog is incomplete');

function pointer(document, fragment, source) {
  let value = document;
  for (const part of fragment
    .replace(/^\//u, '')
    .split('/')
    .map((item) => item.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (
      !part ||
      typeof value !== 'object' ||
      value === null ||
      !(part in value)
    )
      throw new Error(`${source}: unresolved JSON pointer #${fragment}`);
    value = value[part];
  }
}

async function checkApi(file, version, requiredNames) {
  const source = await readFile(path.join(specDirectory, file), 'utf8');
  await format(source, { parser: 'yaml' });
  if (!source.includes(`'${version.key}': '${version.value}'`))
    throw new Error(`${file}: expected ${version.key} ${version.value}`);
  for (const name of requiredNames)
    if (!source.includes(`'${name}'`))
      throw new Error(`${file}: missing required contract ${name}`);

  const references = [
    ...source.matchAll(/['"]\$ref['"]:\s*['"]([^'"]+)['"]/gu),
  ].map((match) => match[1]);
  for (const reference of references) {
    if (reference.startsWith('#/')) {
      const key = reference.split('/').at(-1);
      if (!key || !source.includes(`'${key}':`))
        throw new Error(`${file}: unresolved local reference ${reference}`);
      continue;
    }
    const [relative, fragment = ''] = reference.split('#', 2);
    const target = path.resolve(specDirectory, relative);
    if (!target.startsWith(`${directory}${path.sep}`))
      throw new Error(`${file}: reference escapes schema directory`);
    pointer(JSON.parse(await readFile(target, 'utf8')), fragment, file);
  }
  const operationIds = [...source.matchAll(/'operationId':\s*'([^']+)'/gu)].map(
    (match) => match[1],
  );
  if (new Set(operationIds).size !== operationIds.length)
    throw new Error(`${file}: duplicate operationId`);
  return references.length;
}

const openApiRefs = await checkApi(
  'openapi.yaml',
  { key: 'openapi', value: '3.1.0' },
  [
    '/.well-known/prex',
    '/v1/capabilities',
    '/v1/health',
    '/v1/ready',
    '/v1/normalize',
    '/v1/identify',
    '/v1/enumerate',
    '/v1/inspect',
    '/v1/solve',
    '/v1/materialize',
    '/v1/verify',
    '/v1/explain',
    '/v1/receipts/{algorithm}/{digest}',
    '/v1/snapshots/{algorithm}/{digest}',
    '/v1/events',
    '/v1/openpacker/catalog/import',
    '/v1/openpacker/catalog/snapshot',
    '/v1/openpacker/lifecycle/apply',
    '/v1/openpacker/pack',
    '/v1/openpacker/publish',
  ],
);
const asyncApiRefs = await checkApi(
  'asyncapi.yaml',
  { key: 'asyncapi', value: '3.0.0' },
  [
    'catalogSnapshotCreated',
    'catalogPackageObserved',
    'lifecycleChanged',
    'resolutionCompleted',
    'resolutionUnsatisfiable',
    'receiptCreated',
    'artifactPacked',
    'artifactVerified',
    'policyEvaluated',
  ],
);
console.log(
  `validated ${files.length} PREX schemas and ${openApiRefs + asyncApiRefs} API references`,
);

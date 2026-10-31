import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../../scripts/chromium.mjs';

const root = resolve(import.meta.dirname, '../../..');
const files = new Map([
  [
    '/embedded/openpacker_wasm.js',
    join(root, 'packages/embedded/dist/esm/openpacker_wasm.js'),
  ],
  [
    '/embedded/openpacker_wasm_bg.wasm',
    join(root, 'packages/embedded/dist/esm/openpacker_wasm_bg.wasm'),
  ],
  [
    '/fixtures/request.json',
    join(root, 'fixtures/protocol/solve/request.json'),
  ],
  ['/fixtures/universe.json', join(root, 'fixtures/epoch/universe.json')],
  [
    '/fixtures/signed-receipt.json',
    join(root, 'fixtures/epoch/signed-receipt.json'),
  ],
]);

// The SDK's and @openpacker/canonical's ESM builds are several modules each
// (the SDK's index.js imports ./event-lines.js; canonical's, ./echo.js,
// ./budget.js and the rest), so each whole directory is served, under /sdk/
// and /canonical/, by file name only.
const builds = {
  sdk: join(root, 'packages/sdk/dist/esm'),
  canonical: join(root, 'packages/canonical/dist/esm'),
};
function served(url) {
  const file = files.get(url);
  if (file) return file;
  const [, build, name] =
    /^\/(sdk|canonical)\/([a-z0-9-]+\.js)$/u.exec(url) ?? [];
  return build === undefined ? undefined : join(builds[build], name);
}

test(
  'built SDK browser entry imports without Node polyfills',
  { timeout: 60_000 },
  async () => {
    const server = createServer((request, response) => {
      const file = served(request.url ?? '');
      if (file) {
        response.setHeader(
          'content-type',
          file.endsWith('.wasm')
            ? 'application/wasm'
            : file.endsWith('.json')
              ? 'application/json'
              : 'text/javascript',
        );
        createReadStream(file).pipe(response);
        return;
      }
      if (request.url === '/') {
        response.setHeader('content-type', 'text/html');
        response.end(
          '<!doctype html><script type="importmap">{"imports":{"@openpacker/canonical":"/canonical/index.js"}}</script>',
        );
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise((resolve, reject) =>
      server.listen(0, '127.0.0.1', resolve).once('error', reject),
    );
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    let browser;
    try {
      // Inside the try: a browser that cannot start must still close the server,
      // or the listening socket keeps this process alive after the failure.
      browser = await chromium.launch(chromiumLaunchOptions());
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/`);
      const result = await page.evaluate(async () => {
        const before = {
          process: typeof globalThis.process,
          Buffer: typeof globalThis.Buffer,
          require: typeof globalThis.require,
          module: typeof globalThis.module,
        };
        const observed = [];
        const responseBody = JSON.stringify({
          meta: {
            protocolVersion: '1.0-draft',
            provider: {
              id: 'browser-fixture',
              implementation: 'stub-fetch',
              version: '1.0.0',
            },
          },
          protocolVersions: ['1.0-draft'],
        });
        const stubFetch = async (input, init) => {
          observed.push({ url: String(input), method: init?.method });
          return new Response(responseBody, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };
        const sdk = await import('/sdk/browser.js');
        const canonical = await import('/canonical/index.js');
        const wasm = await import('/embedded/openpacker_wasm.js');
        await wasm.default('/embedded/openpacker_wasm_bg.wasm');
        const discovery = await sdk
          .createOpenPackerClient({
            baseUrl: 'https://daemon.invalid',
            fetch: stubFetch,
          })
          .discovery();
        const [request, universe, signed] = await Promise.all([
          fetch('/fixtures/request.json').then((response) => response.json()),
          fetch('/fixtures/universe.json').then((response) => response.json()),
          fetch('/fixtures/signed-receipt.json').then((response) =>
            response.json(),
          ),
        ]);
        const solveInput = { request, universe };
        const outputText = wasm.solve_json(JSON.stringify(solveInput));
        const output = JSON.parse(outputText);
        const proofCheck = JSON.parse(
          wasm.check_json(JSON.stringify(solveInput), outputText),
        );
        const receiptDigest = `${signed.receiptDigest.algorithm}:${signed.receiptDigest.value}`;
        const proofBytes = canonical.canonicalBytes(output.proof);
        const wasmProofBytes = new TextEncoder().encode(
          wasm.canonicalize_json(JSON.stringify(output.proof)),
        );
        return {
          before,
          after: {
            process: typeof globalThis.process,
            Buffer: typeof globalThis.Buffer,
            require: typeof globalThis.require,
            module: typeof globalThis.module,
          },
          observed,
          protocolVersions: discovery.data.protocolVersions,
          raw: new TextDecoder().decode(discovery.rawBytes),
          proofValid: proofCheck.valid,
          proofBytesEqual:
            proofBytes.length === wasmProofBytes.length &&
            proofBytes.every((byte, index) => byte === wasmProofBytes[index]),
          receiptValid: wasm.verify_receipt_digest(
            JSON.stringify(signed.receipt),
            receiptDigest,
          ),
        };
      });
      assert.deepEqual(result.before, {
        process: 'undefined',
        Buffer: 'undefined',
        require: 'undefined',
        module: 'undefined',
      });
      assert.deepEqual(result.after, result.before);
      assert.deepEqual(result.observed, [
        { url: 'https://daemon.invalid/.well-known/prex', method: 'GET' },
      ]);
      assert.deepEqual(result.protocolVersions, ['1.0-draft']);
      assert.match(result.raw, /"protocolVersions":\["1.0-draft"\]/u);
      assert.equal(result.proofValid, true);
      assert.equal(result.proofBytesEqual, true);
      assert.equal(result.receiptValid, true);
    } finally {
      try {
        await browser?.close();
      } finally {
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  },
);

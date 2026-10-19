import assert from 'node:assert/strict';
import { accessSync, createReadStream, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');

test(
  'web WASM binding executes in a real Playwright browser context',
  { timeout: 60_000 },
  async () => {
    const wasm = join(
      root,
      'packages/embedded/dist/esm/openpacker_wasm_bg.wasm',
    );
    const loader = join(root, 'packages/embedded/dist/esm/openpacker_wasm.js');
    accessSync(wasm);
    accessSync(loader);
    assert.equal(
      WebAssembly.validate(readFileSync(wasm)),
      true,
      'embedded web artifact is not valid WASM',
    );
    const server = createServer((request, response) => {
      if (request.url === '/openpacker_wasm.js') {
        response.setHeader('content-type', 'text/javascript');
        createReadStream(loader).pipe(response);
      } else if (request.url === '/openpacker_wasm_bg.wasm') {
        response.setHeader('content-type', 'application/wasm');
        createReadStream(wasm).pipe(response);
      } else {
        response.setHeader('content-type', 'text/html');
        response.end(
          '<!doctype html><meta charset=utf-8><title>OpenPacker WASM conformance</title>',
        );
      }
    });
    await new Promise((resolve, reject) =>
      server.listen(0, '127.0.0.1', resolve).once('error', reject),
    );
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/`);
      const result = await page.evaluate(async () => {
        const wasm = await import('/openpacker_wasm.js');
        await wasm.default();
        return {
          satisfies: wasm.version_satisfies('1.2.3', 'vers:npm/>=1.0.0'),
          digest: JSON.parse(wasm.digest_json('{"b":2,"a":1}')),
        };
      });
      assert.equal(result.satisfies, true);
      assert.match(
        `${result.digest.algorithm}:${result.digest.value}`,
        /^sha256:[0-9a-f]{64}$/u,
      );
    } finally {
      await browser.close();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

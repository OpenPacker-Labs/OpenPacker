import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Local HTTPS fixture for delegated host-fetch tests. Serves artifact bytes on
 * 127.0.0.1 so nothing depends on DNS for a fake registry host.
 */
export interface AcmeArtifactFixtureServer {
  origin: string;
  artifactUrl: string;
  fetch: typeof fetch;
  close(): Promise<void>;
}

export async function startAcmeArtifactFixtureServer(input: {
  artifactPath: string;
  body: Uint8Array;
}): Promise<AcmeArtifactFixtureServer> {
  const tlsDir = await mkdtemp(join(tmpdir(), 'opm-acme-tls-'));
  const keyPath = join(tlsDir, 'key.pem');
  const certPath = join(tlsDir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-nodes',
      '-subj',
      '/CN=127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const [key, cert] = await Promise.all([
    readFile(keyPath),
    readFile(certPath),
  ]);
  const routes = new Map<string, Uint8Array>();
  let port = 0;
  let server: Server | undefined;
  await new Promise<void>((resolve) => {
    server = createServer({ key, cert }, (req, res) => {
      const path = req.url ?? '/';
      const host = req.headers.host ?? `127.0.0.1:${port}`;
      const url = `https://${host}${path}`;
      const bytes =
        routes.get(url) ?? routes.get(`https://127.0.0.1:${port}${path}`);
      if (bytes === undefined) {
        res.writeHead(404);
        res.end('missing');
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
      });
      res.end(bytes);
    });
    server.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server!.address() as { port: number }).port;
  const origin = `https://127.0.0.1:${port}`;
  const artifactUrl = `${origin}${input.artifactPath}`;
  routes.set(artifactUrl, input.body);
  const fetchImpl = (async (requestInfo: RequestInfo | URL) => {
    const url = String(requestInfo);
    const bytes = routes.get(url);
    if (bytes === undefined) return new Response('missing', { status: 404 });
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }) as typeof fetch;
  return {
    origin,
    artifactUrl,
    fetch: fetchImpl,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(tlsDir, { recursive: true, force: true });
    },
  };
}

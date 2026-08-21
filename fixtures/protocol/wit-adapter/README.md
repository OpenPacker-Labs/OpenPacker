# WIT-shaped adapter service-index fixtures

Executable evidence that OpenPacker v1 **loads** WIT-**shaped** TypeScript
modules (and sandboxed native plugins), not WebAssembly components.

These JSON documents are Registry Definition **service-index** payloads for
`parseServiceIndex` / `assertWitShapedModule` in `@openpacker/adapter-host`.
They are not Wasm component binaries and are not loaded by wasmtime or jco.

| File                 | Intent                                                            |
| -------------------- | ----------------------------------------------------------------- |
| `catalog-http.json`  | HTTP catalog advertising search, enumerate, metadata, artifact    |
| `metadata-only.json` | Read-only catalog: metadata + enumerate + artifact, **no search** |

The WIT world [`spec/wit/prex-adapter.wit`](../../../spec/wit/prex-adapter.wit)
remains the normative ABI **shape**. A wasmtime host is a future initiative.

# PREX WIT worlds

WebAssembly Interface Types for plug-in adapters.

| World                           | File                                   | Role                        |
| ------------------------------- | -------------------------------------- | --------------------------- |
| `openpacker:prex-adapter@0.1.0` | [`prex-adapter.wit`](prex-adapter.wit) | Package-manager adapter ABI |

## v1 host (honesty)

OpenPacker v1 **loads** WIT-**shaped** TypeScript `AdapterModule` objects
(`packages/adapter-host`) and **sandboxed native plugins**
(`packages/plugin-host`, `packages/sandbox`). It does **not** load WebAssembly
components: there is no wasmtime, jco, or component-model guest loader on the
production path.

[`prex-adapter.wit`](prex-adapter.wit) remains the normative ABI **shape**.
Production guests implement that shape in-process (TypeScript) or as
digest-pinned native executables. `assertWitShapedModule` / `parseServiceIndex`
prove the shape against fixtures under
[`fixtures/protocol/wit-adapter/`](../../fixtures/protocol/wit-adapter/). A
wasmtime host is a future initiative, not a v1 capability.

See [ADR 0032](../../docs/adr/0032-wit-adapters-and-registry-definition.md) and
[Registry Definition](../prex/v1/registry-definition.md).

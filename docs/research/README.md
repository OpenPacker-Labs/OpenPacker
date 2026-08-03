# Research and standards provenance

OpenPacker uses research to define auditable boundaries, not to inflate its
claims. [Formal foundations](formal-foundations.md) records the exact PREX IR
mapping and what remains only inspiration. Protocol and operational standards
are linked from their relevant guides and summarized below.

| Area                    | Primary source                                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package identity        | [Package URL specification](https://github.com/package-url/purl-spec/blob/main/PURL-SPECIFICATION.rst) and [ECMA-427](https://ecma-international.org/publications-and-standards/standards/ecma-427/) |
| Version constraints     | [VERS specification](https://github.com/package-url/purl-spec/blob/main/VERSION-RANGE-SPEC.rst)                                                                                                      |
| Canonical JSON          | [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html)                                                                                                                                              |
| HTTP errors             | [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)                                                                                                                                              |
| Trace propagation       | [W3C Trace Context](https://www.w3.org/TR/trace-context/)                                                                                                                                            |
| OCI distribution/images | [Distribution 1.1](https://github.com/opencontainers/distribution-spec/blob/v1.1.1/spec.md) and [Image 1.1](https://github.com/opencontainers/image-spec/blob/v1.1.0/spec.md)                        |
| Component composition   | [OCM component model](https://ocm.software/docs/component-model/)                                                                                                                                    |
| Repository trust        | [TUF specification](https://theupdateframework.github.io/specification/latest/)                                                                                                                      |
| Signing/transparency    | [Sigstore bundle specification](https://docs.sigstore.dev/about/bundle/)                                                                                                                             |
| Provenance              | [SLSA provenance v1](https://slsa.dev/spec/v1.0/provenance) and [in-toto Statement v1](https://github.com/in-toto/attestation/blob/v1.0/spec/v1/statement.md)                                        |
| SBOM                    | [CycloneDX specification](https://cyclonedx.org/specification/overview/)                                                                                                                             |
| Events                  | [CloudEvents 1.0](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md) and [AsyncAPI 3.0](https://www.asyncapi.com/docs/reference/specification/v3.0.0)                              |

Dependency/tool versions are established by `package-lock.json`, `Cargo.lock`,
package manifests, and integration configuration. These links establish
semantics; they do not override the locked implementation version.

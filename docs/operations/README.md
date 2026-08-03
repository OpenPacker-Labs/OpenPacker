# OpenPacker operations

| Guide                                                      | Scope                                                                                     |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [Runtime and clients](runtime-clients.md)                  | Daemon, SDK, embedded native/WASM, CLI, and offline behavior                              |
| [Storage and deployment](storage-deployment.md)            | SQLite, filesystem CAS, snapshots, cache boundary, OCI layout, and registry configuration |
| [Backup, air-gap, and recovery](backup-airgap-recovery.md) | Consistent backup/restore, transfer, integrity checks, and incident links                 |
| [Trust, lifecycle, and policy](trust-lifecycle-policy.md)  | Separate evidence roles, deterministic reduction, forensic materialization, and receipts  |
| [Benchmarking](benchmarking.md)                            | Reproducible methodology and bounded regression thresholds                                |
| [Contributing and releasing](contributing-releasing.md)    | Contract-first changes, quality gates, packaging, and release evidence                    |

OpenPacker can run directly on the host; Docker is not required for the
mandatory offline demo. The optional compose environment is for live registry
interoperability, not core resolution.

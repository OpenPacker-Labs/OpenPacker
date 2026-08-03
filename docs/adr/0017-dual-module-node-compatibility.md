# ADR 0017: Publish dual modules across supported Node versions

- Status: Accepted
- Date: 2026-08-02

## Context

OpenPacker consumers include ESM, CommonJS, Node 20.20+, 22, 24, and browser
builds. Default-export-only or Node-only packages would force downstream forks.

## Decision

Public TypeScript packages publish named APIs, declarations, explicit export
maps, and dual ESM/CommonJS entry points where Node use is supported. Browser
entries use standard web APIs and no Node built-ins. Clean packed consumers are
tested across the supported runtimes.

## Consequences

Build configuration is stricter and has a compatibility matrix, but Epoch and
other consumers can adopt OpenPacker without changing module systems.

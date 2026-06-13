# Changelog

All notable changes to loop-cursor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-13

### Added

- 11-phase autonomous workflow orchestration engine (`engine-loop.ts`, 22-step)
- P0/P1/P2 severity routing engine with design vs. implementation decision tree
- Convergence detection engine with convergence counter and early termination
- File-driven state machine with atomic write and crash-safe lock protocol
- Cursor SDK platform adapter (7-method `PlatformAdapter` interface implementation)
- Dynamic per-phase Cursor rules generator (`.cursor/rules/*.mdc` with glob scopes)
- Dynamic `hooks.json` generator for `beforeShellExecution` + `preToolUse`
- SAP block parser (`<<<LOOP_STATE>>>` extraction from agent output)
- Cross-turn context bridge (P0-2 workaround for conversation history re-injection)
- 7 safety gates: G1 content safety, G2 plan confirmation, G3 dependency install, G4 dangerous ops, G5 file mutation, G6 completion declaration, G7 state protection
- Issue classifier (P0/P1/P2 severity determination from SAP blocks)
- Git worktree support for isolated feature branches
- Monorepo structure: `packages/loop-core`, `packages/adapter-cursor-sdk`, `packages/cli`
- CLI entry point with argument parsing and Bun-based child process spawning
- CI pipeline: lint, test (3 OS x 1 Node version matrix), build, security audit, combined status check
- Comprehensive README with bilingual (English + Chinese) documentation
- Apache 2.0 license

### Security

- Bilingual (EN+CN) SECURITY.md security policy: reporting process, supported versions, Cursor SDK security model (7 safety gates), dependency security, coordinated disclosure policy
- Copyright 2026 Perry Link, novelnexusai@outlook.com, GitHub PerryLink, Apache 2.0

### Infrastructure

- Test coverage reporting via `c8` with `test:coverage` and `test:coverage:single` npm scripts
- CI coverage job: runs tests with coverage, outputs text summary, uploads `lcov.info` artifact
- Shared test helpers (`tests/test-helpers.ts`): `makeBasicState`, `makeStateWithOverrides`, `cleanupStateFiles`, `assert`
- Migration example: `test-model-registry.test.ts` migrated from custom `runTests()` wrapper to `node:test` native `describe`/`it` with `node:assert/strict`

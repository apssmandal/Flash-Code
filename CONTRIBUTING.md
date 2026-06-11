# Contributing to Flash Code

Thanks for helping improve Flash Code! This guide covers local setup and the project's conventions.

## Setup

```bash
npm install
npm run build        # esbuild bundles the host (the webview is raw HTML in media/)
```

> Full architecture walkthrough: [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md).

Press **F5** in VS Code to launch the Extension Development Host with the extension loaded.

## Workflow

```bash
npm run watch        # rebuild on change (reload the dev host to pick up changes)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest
npm run coverage     # core-logic coverage
```

All four (`typecheck`, `lint`, `test`, `build`) must pass — CI enforces them on every push/PR.

## Architecture conventions

- **Add a provider**: implement the `Provider` interface in `src/providers/<name>.ts` (or reuse `OpenAICompatibleProvider`) and register it in `src/providers/registry.ts`. Keep wire-format mapping in pure exported functions and add mapper tests.
- **Add a tool**: declare it once in `src/core/tools/*` with a JSON schema + handler + mode-gating metadata. The registry emits both native schemas and the XML fallback from that single definition — never hand-maintain two transports.
- **Never import `vscode` in `core/` or `providers/`.** Those layers stay host-agnostic and unit-testable; host capabilities flow through `ToolContext` / `HostToolPlane`.
- **Security**: execute external programs via `runExec` (argv array, no shell); validate tool paths with `safeRelPath`; render all model/file content through the sanitized markdown pipeline; keep secrets in Secret Storage.
- **Prompts are code**: changes to output formats (SEARCH/REPLACE markers, XML tags, task lists) must keep the contract tests green — and vice versa.

## Tests

Add tests under `test/` (Vitest). `vscode` is aliased to `test/mocks/vscode.ts`; use `makeContext()` for an in-memory `ExtensionContext`. Prefer testing pure logic; use the scripted fake provider + fake `ToolContext` patterns (see `test/agentLoop.test.ts`) for integration-style coverage.

## Git hooks (optional)

This repo ships a husky config. After `git init`, run `npx husky install` to enable pre-commit lint and pre-push test.

## Pull requests

1. Branch from `main`.
2. Keep changes focused; update `CHANGELOG.md`.
3. Ensure the full gate is green.
4. Open a PR describing the change and rationale. For large features, open an issue first.

# Flash Code — Developer Guide

A complete architectural reference for contributors. Part 1 is the high-level model; Part 2 is a file-by-file, function-by-function walkthrough.

---

# Part 1 — High level

## What it is

Flash Code is a VS Code extension. It runs entirely in the **extension host** (Node) and renders its UI in **webviews** (sandboxed HTML). There is no server and no bundled runtime dependencies in the shipped artifact — the host code is bundled by esbuild; the webview is hand-authored HTML/JS.

The product is an **agentic coding assistant**: the user sends a message, the system decides what kind of request it is, then either answers directly or runs a tool-using agent loop against a chosen AI **provider**, streaming progress back to the chat UI.

## The three layers

```
┌────────────────────────────────────────────────────────────────┐
│ WEBVIEW (media/*.html)  — vanilla HTML/JS, the original Flash    │
│   chat.html · sidebar.html · dashboard.html                     │
│   speaks an ad-hoc message protocol with the host               │
└───────────────▲───────────────────────────┬────────────────────┘
                │ host→webview messages      │ webview→host commands
┌───────────────┴───────────────────────────▼────────────────────┐
│ HOST (src/host/*, src/extension.ts)                             │
│   ChatController · SidebarProvider · DashboardController         │
│   HostToolContext (vscode.fs + child_process)                   │
│   Adapts engine AgentEvents ⇄ the webview protocol              │
└───────────────▲───────────────────────────┬────────────────────┘
                │ AgentEvent / ToolContext   │ run()
┌───────────────┴───────────────────────────▼────────────────────┐
│ ENGINE (src/core/*, src/providers/*, src/prompts/*)             │
│   triage → AgentLoop → ToolCallingAdapter → Provider            │
│   ToolRegistry + tools · KeyPool rotation · prompts             │
│   (host-agnostic; no `vscode` import below the host layer)      │
└─────────────────────────────────────────────────────────────────┘
```

**Golden rule:** code in `core/` and `providers/` must never `import 'vscode'`. Host capabilities flow down through the `ToolContext` interface. This keeps the engine unit-testable with fakes (see `test/`).

## Request lifecycle (one user message)

1. **Webview → host.** `chat.html` posts `{command:'sendMessage', text, attachments}`.
2. **ChatController.handleSend.** If busy → **queue**. Else record the user turn, `save()` (the session appears in the sidebar immediately), then classify intent.
3. **Triage.** `classifyIntent()` makes one cheap, short provider call → `general | codebase | agentic`.
4. **Route.**
   - `general` → `answerDirect()` — a single streamed reply, **no tools**.
   - `codebase` → `AgentLoop` with **read-only** tools, 12-iteration cap.
   - `agentic` → `AgentLoop` with **all** tools, 40-iteration cap.
5. **AgentLoop.run.** Streams a turn via the provider, parses tool calls (native or XML), executes them through `ToolContext`, feeds results back, repeats. A **completion gate** prevents premature stops; **dedup/stall** guards and iteration caps prevent infinite loops.
6. **Events.** The loop emits provider-agnostic `AgentEvent`s; `ChatController.emit()` translates them into the webview's message vocabulary (`startResponse`/`streamChunk`/`agentToolCall`/`showDiff`/`agentSpawn`/…).
7. **Providers.** Each request goes through a `Provider` whose `KeyPool` leases an API key (round-robin + cooldown + RPM pacing) and retries transient failures.

## Build & tooling

- `build.mjs` — esbuild bundles `src/extension.ts` → `out/extension.js` (CJS, node, `vscode` external). The webview is not bundled (raw HTML in `media/`).
- `tsc --noEmit` type-checks; **ESLint** lints; **Vitest** runs unit/contract tests (with a `vscode` mock at `test/mocks/vscode.ts`).
- `.github/workflows/ci.yml` runs typecheck → lint → test → build.
- Package: `npx @vscode/vsce package --allow-missing-repository` → `flash-code-<version>.vsix`.

---

# Part 2 — File by file

## Entry point

### `src/extension.ts`
The activation entry. `activate(ctx)`:
- configures the leveled logger to a VS Code OutputChannel (`configureLogger`);
- runs `migrateLegacy` + `SecretStore.init/migrateFromConfig` (moves legacy plaintext keys into Secret Storage);
- builds the `ProviderRegistry` and `SidebarProvider`;
- registers commands: `open`, `newChat`, `openSession`, `openDashboard`, `sendFile`, `switchProvider`, `switchModel`, `manageKeys`, `openSettings`.
Command helpers `switchProvider/switchModel/manageKeys/sendCurrentFile` use VS Code quick-picks/input boxes and write to config / `SecretStore`. `newChat` shows the panel then calls `ChatController.current.newChat()`.

## Host layer (`src/host/`)

### `host/chatController.ts` — the orchestration hub
Owns the chat `WebviewPanel` and drives it with the engine. Key members:
- **`show()` / constructor** — singleton panel; loads `chat.html`; wires inbound messages and a `sessionEvents` subscription.
- **`onMessage(m)`** — the inbound protocol handler: `ready`, `sendMessage`, `cancel`, `setMode/Effort`, `slashCommand`, `newChat`, diff accept/reject (`acceptDiff`/`rejectDiff`/`tellClaude`), command/code approval (`agentAcceptCommand`/`agentRejectCommand`), `agentUserInput`, `spawnSubagent`, attachments (`uploadFile`/`addContext`/`pasteClipboard`/`browseWeb`), `openFile`, `openInTab`, `openSettings`.
- **`handleSend(text, attachments)`** — the core flow: busy→queue; record + `save()` the turn; `classifyIntent` (triage); route to `answerDirect` (general) or a configured `AgentLoop` (codebase/agentic). Injects project tree + key files + rules + summary via `buildSystemPrompt`.
- **`answerDirect()`** — streams a single reply with the chat directive, no tools (the `general` route).
- **`handleSpawn(role, task)`** — `/agent` path: spawns a subagent directly so it always lands on the dashboard.
- **`emit(ev)`** — the **adapter**: maps each `AgentEvent` → webview messages, manages the streaming bubble lifecycle (`startResponse`/`streamChunk`/`closeBubble`), and forwards subagent events to the dashboard (`toDashboard`).
- **`plane()`** — builds the `HostToolPlane` passed to `HostToolContext` (emit, mode, approvals, diff presentation, snapshots, subagent spawn).
- **`presentDiff()`** — computes a side-by-side diff (`computeSideBySide`), shows it; in `ask` mode awaits accept/reject via a resolver keyed by `diffId`; otherwise writes immediately and snapshots for rewind.
- **`askApproval()`** — command/code approval **always prompts** (any mode) unless `autoApprove`; file writes follow the mode. For command/code it classifies via `classifyCommand` and auto-approves if that category is in the per-thread allow-set (the "Allow for this thread" option, `agentAcceptCommandThread`), cleared on each new user message.
- **`metered()`** — wraps the active provider in `meterProvider` so every model call's tokens are recorded against the current session in `UsageTracker`; used for the agent loop, `answerDirect`, compaction, and subagents.
- **`spawn(role, task)`** — runs a child `AgentLoop` with the subagent profile's restricted tools, forwarding its events as progress.
- **`maybeCompact()`** — periodically summarizes history (`SUMMARIZE_PROMPT`) into a rolling summary.
- **`drainQueue()`** — runs the next queued message after a task finishes.
- Relates to: `AgentLoop`, `HostToolContext`, `ProviderRegistry`, `SecretStore`, `SessionManager`, `classifyIntent`, `buildSystemPrompt`, `DashboardController`/`agentHub`, `sessionEvents`.

### `host/sidebarProvider.ts`
`WebviewViewProvider` for `sidebar.html` (session list + sliding settings). `onMessage` handles `newSession`, `openSession`, `renameSession`, `deleteSession`, `openDashboard`, `getSettings`, `selectProvider`, `saveSettings`, and the Usage panel (`getUsage`/`clearUsage` → `UsageTracker`, plus a `changed` subscription that re-pushes `usageData`). `sendSettings(id)` emits `settingsData` (provider, model, built-in + custom `models` via `registry.modelsFor`, keys from `SecretStore`, key statuses); `saveSettings` writes config + persists keys and `customModels`. Subscribes to `sessionEvents` to refresh the list live.

### `host/dashboardController.ts`
Mission Control panel for `dashboard.html`. A static `states` map is updated by `record(ev)` from `spawn`/`progress`/`finish` events; `update()` posts `updateState` to the kanban. Subscribes to `agentHub` so a live board updates, and replays state on `ready`.

### `host/usageTracker.ts`
Per-workspace token-usage store (static singleton, `init(ctx)` / `instance`). `record(sessionId, provider, model, in, out)` folds one completed call into the store via `core/usage.recordCall` and persists to `globalState` (`storage.usageKey`); `snapshot()` joins it with session titles for the sidebar; `clear()`/`clearSession(id)`; fires `UsageTracker.changed` so an open Usage panel refreshes. Fed by the metering proxy (see `providers/metered.ts`).

### `host/hostToolContext.ts`
The real `ToolContext` implementation, backed by VS Code APIs + `child_process`. Filesystem ops use `vscode.workspace.fs`; **`runExec`** uses `spawn` with an argv array and `shell:false` (no injection); **`runCommand`** uses the platform shell only for the explicit, user-approved `run_command` tool. UI-plane methods (`emit`, `askApproval`, `askUser`, `presentDiff`, `recordSnapshot`, `spawn`, `mode`, `root`) delegate to the injected `HostToolPlane`.

### `host/webviewHtml.ts`
`buildWebviewHtml(webview, extUri, entry)` reads `media/{chat|sidebar|dashboard}.html` from disk and returns it verbatim (the original UI uses inline scripts/handlers).

### `host/agentHub.ts`
A module-level `vscode.EventEmitter<AgentEvent>` broadcasting subagent lifecycle events so the dashboard mirrors chat activity across separate webviews.

## Engine core (`src/core/`)

### `core/agentLoop.ts` — the provider-agnostic loop
`AgentLoop.run(userText, history, signal)`:
- builds the system prompt + message list; loops up to `maxIterations`;
- each turn calls `ToolCallingAdapter.runTurn` (stream → normalized `{text, thinking, toolCalls, finish}`);
- on tool calls → `executeTools` (honors `planGate`, the spawn-blocking rule, dedup); on no tool calls → the **completion gate** (`isComplete` judge) decides DONE vs CONTINUE; stall/iteration caps bound it.
- `executeTools` runs each tool's handler via `ToolContext`, emits `tool_start`/`tool_result` (output cleaned by `toolPreview`), and feeds results back (native `tool` messages or an XML `[tool results]` block).
- `isComplete()` — one cheap `COMPLETION_JUDGE` call (temperature 0); defaults to "done" on failure.
- Relates to: `ToolCallingAdapter`, `ToolRegistry`, `ToolContext`, `prompts/system`.

### `core/toolCallingAdapter.ts`
Normalizes the two tool transports. `native` getter reflects `provider.capabilities.tools`. `buildSystem()` appends the XML tool block + `XML_TOOL_INSTRUCTIONS` only in fallback mode. `tools()` returns native schemas or `undefined`. `runTurn()` consumes the provider stream, emitting text/thinking deltas, and returns native `tool_call`s or — in fallback — parses XML via `parseXmlToolCalls`; `stripForDisplay` cleans streamed XML-mode prose; `isTruncated` flags cut-off tags.

### `core/toolRegistry.ts`
`ToolRegistry` holds `ToolDef`s (`name`, `description`, JSON-schema `parameters`, `handler`, `mutates`, `planAllowed`, `category`). `schemas(allowed?)` emits native function schemas; `xmlDefinitions(allowed?)` emits the XML fallback block — both from one source so transports can't drift. `filtered()` applies a per-route allowlist (always keeping `ask_user`).

### `core/tools/`
- **`index.ts`** — `buildDefaultRegistry()` registers all tools.
- **`fileTools.ts`** — `read_file`, `list_files`, `search_files`, `create`, `edit` (SEARCH/REPLACE via `parseSearchReplace` + `editUtils.applyEdits`; reports `NOT APPLIED` with current content on a malformed/empty body or no-op so it never falsely claims success), `overwrite_file`, `append_file`, `delete_file`, `rename_file`, `copy_file`, `read_dir`, `create_dir`, `get_file_info`, `read_json`, `format_json`. Edits/writes route through `ctx.presentDiff` (`writeWhole` helper).
- **`execTools.ts`** — `run_command`, `run_code`, `run_tests`, `npm_install`, git ops (`git()` helper using argv arrays), `create_branch`, `fetch_url`, `search_web` (`summarizeDuckDuckGo`), `ask_user` (structured schema; falls back to JSON body in XML mode), `spawn_agent`.
- **`util.ts`** — `clip`, `reqStr`/`optStr` (arg validation), `safeRelPath` (path-traversal guard), `safeRegex`, `globMatch`.

### `core/xmlToolParser.ts`
`parseXmlToolCalls(buf, knownTools)` — pure parser for the XML fallback: body tools (`<edit>…</edit>`) vs self-closing tag tools, ignoring `<think>` blocks, exposing element bodies as the `_body` argument, returning calls in document order + cleaned prose. `isTruncated` detects an unclosed body tag.

### `core/triage.ts`
`classifyIntent(provider, model, text, recent, signal)` — one cheap, 8s-bounded call with `TRIAGE_PROMPT`; returns `general | codebase | agentic`, defaulting to `agentic` on failure. `parseRoute()` maps the model's one-word reply.

### `core/commandClass.ts`
`classifyCommand(raw)` — pure classifier behind the "Allow for this thread" command-approval option. Unwraps `powershell -Command "…"` / `cmd /c …`, splits on pipes/`&&`/`;`, and returns `{category, label}`: all read-only inspection segments → `read` (one grant covers `type`/`findstr`/`Get-Content | Select-String`…), otherwise `exec:<program>` so allowing `npm` never allows `git push`. `chatController` keeps a per-thread allow-set, reset on each new user message.

### `core/usage.ts`
Pure token-accounting model (no `vscode`). `recordCall(store, sessionId, provider, model, in, out, at)` immutably folds one API call into `UsageStore` (keyed by session → `provider/model`); `sessionTotals`/`grandTotals`/`formatTokens`. Persistence + title-joining live in `host/usageTracker.ts`.

### `core/events.ts`
The `AgentEvent` union (status, thinking, prose, tasks, tool_start/output/result, diff, ask_user/ask_command/ask_code, spawn/progress/finish, error, done), plus `AgentMode`, `TaskItem`, `EmitFn`. The stable contract between engine and host. (`ask_command`/`ask_code` carry an optional `threadLabel` for the "allow for this thread" button.)

### `core/toolContext.ts`
The `ToolContext` interface (fs, exec, network, UI-plane) and `ToolHandler` type. The seam that keeps tools host-agnostic.

### `core/errors.ts`
Typed errors: `RateLimitError` (429, carries `retryAfterMs`), `OverloadError` (5xx/network, retryable), `AuthError` (401/403), `NoKeyError`, `CancelledError`, `ToolArgumentError`. `isAbort()` recognizes cancellation. The `KeyPool` branches on these.

### `core/logger.ts`
`createLogger(scope)` leveled logging through a sink (OutputChannel) with `redact()` masking key-shaped strings.

## Providers (`src/providers/`)

### `providers/types.ts`
The `Provider` interface (`id`, `label`, `capabilities`, `models()`, `defaultModel()`, `stream()`), the canonical `UnifiedRequest`, the normalized `StreamEvent` union, `ChatMessage`/`ToolSchema`/`ToolCallRequest` (incl. Gemini `thoughtSignature`), `GenConfig`, and the `EFFORT` presets.

### `providers/registry.ts`
`ProviderRegistry` builds every provider from VS Code config + `SecretStore`, giving each keyed provider a `KeyPool` (`poolFor`). `getActive`/`activeId`/`activeModel`, `modelsFor`/`customModels` (built-in + user-added), `keyStatuses`, `rebuild()` (after settings change). OpenRouter/Groq/DeepSeek/Nvidia/OpenAI all use `OpenAICompatibleProvider`.

### `providers/keyPool.ts`
The generalized rotation engine. `acquire(signal)` leases a key (round-robin balanced by in-flight count, skipping cooldowns, RPM-paced). `withRotation(doFetch, signal)` runs a streaming op and reroutes on `RateLimitError`, disables keys on `AuthError`, backs off on `OverloadError` — bounded by `maxAttempts`. Timing is injectable (`now`/`sleep`) for tests. `getStatuses()` powers the sidebar key lights.

### `providers/metered.ts`
`meterProvider(inner, onCall)` — a transparent `Provider` proxy that watches the `usage` StreamEvents providers already emit and calls `onCall(provider, model, in, out)` **once per `stream()` call** (in a `finally`, so aborts still count). It takes the latest cumulative counts rather than summing — important because Gemini re-reports cumulative `usageMetadata` every chunk. `chatController.metered()` wraps the active provider so triage, the agent loop, the completion-judge, compaction, and subagents are all metered into `UsageTracker`.

### `providers/http.ts`
`safeFetch()` wraps `fetch`, turning transient network failures into a retryable `OverloadError` (and real aborts into `CancelledError`). `classifyStatus()` maps HTTP status → typed error. `sseData()` yields SSE `data:` payloads. Used by every provider's `doFetch`.

### `providers/gemini.ts`, `anthropic.ts`, `openaiCompatible.ts`, `ollama.ts`
Each implements `Provider.stream()` over `KeyPool.withRotation` + `safeFetch`, plus **pure exported mappers** (`toGeminiContents`/`toAnthropicMessages`/`toOpenAIMessages`/`toOllamaMessages` and the tool-schema mappers) that are unit-tested without network. Gemini replays `thoughtSignature` on follow-up tool turns; the OpenAI-compatible `OpenAIStreamParser` accumulates streamed tool-call deltas; Ollama reports `tools:false` so the agent uses the XML fallback.

## Prompts (`src/prompts/`)

### `prompts/system.ts`
`buildSystemPrompt(opts)` assembles `IDENTITY` + `OPERATING_RULES` (incl. anti-fabrication) + `CLARITY` (mandatory ask-before-deciding) + the mode directive + `SAFETY` + `WEB_DESIGN_DIRECTIVE`, wrapping injected tree/rules/summary/key-files in labeled DATA delimiters (`delimit`). Also exports `SUMMARIZE_PROMPT` and `COMPLETION_JUDGE`.

### `prompts/triage.ts`
`TRIAGE_PROMPT` (the one-word classifier) and `triageUserMessage(text, recent)`.

### `prompts/subagents.ts`
`SUBAGENTS` — the 11 role profiles (system prompt + `tools` allowlist). `getSubagentProfile(role)` resolves case-insensitively with an Inspector fallback.

## Session & storage

### `session/sessionManager.ts`
Per-workspace session state: UI `turns` + model `messages`, rolling `summary`, file `snapshots`. `addUser/addAssistant`, `history()` (capped), `snapshot/rewind`, `newChat/clear/load/save`, `indexSession` (fires `sessionEvents`), `listSessions/renameSession/deleteSession`. IDs from `newId()` (collision-resistant).

### `session/types.ts`
`ChatTurn`, `Attachment`, `SessionInfo` (relocated from the removed `shared/protocol.ts`).

### `session/sessionEvents.ts`
`sessionEvents` `EventEmitter` — the cross-webview refresh signal (chat ⇄ sidebar).

### `storage.ts`
Per-workspace `globalState` key helpers (`wsKey` hash + `sessionsKey`/`chatKey`/`summaryKey`/`lastKey`/`usageKey`) and `migrateLegacy`.

## Domain utilities

### `diffUtils.ts`
`computeSideBySide(old, new, ctx)` → `DiffRow[]` (LCS for normal files, block fallback for huge files, gap collapsing). Pure, 100% tested. Consumed by `presentDiff` and rendered by `chat.html`.

### `editUtils.ts`
`parseEdits(text)` (parses `<create>`, `<edit>` SEARCH/REPLACE, fenced fallbacks) and `applyEdits(old, edit)` (`applyOne` does exact-then-whitespace-tolerant matching). Reused by the `edit` tool.

### `fileManager.ts`
`getProjectTree` (cached), `getAllFiles`, `getActiveFileContent`, `getSelectedText`, `getVisibleFilesContent`, `getKeyFiles` (README/package.json grounding).

### `rulesEngine.ts`
`RulesEngine` singleton watches `.flash/*.md` and exposes `getProjectRules()` (wrapped as enforced `<project_rules>`).

### `secrets.ts`
`SecretStore` — SecretStorage with a synchronous in-memory cache (so `KeyPool.getKeys()` stays sync). `init`, `getKeys/setKeys/hasAnyKey`, `migrateFromConfig` (one-time plaintext → secrets).

## Webview (`media/`)
Hand-authored, self-contained HTML (the original Flash Code UI, preserved). `chat.html` (timeline, composer, mode/`+`/`⌘` popups, diff cards, tool cards, agent cards, clarification modals), `sidebar.html` (sessions + sliding multi-provider settings with custom-model add/remove), `dashboard.html` (Mission Control kanban). They communicate with the host via the message protocol the `ChatController`/`SidebarProvider`/`DashboardController` implement.

## Tests (`test/`)
Vitest specs with a `vscode` mock (`test/mocks/vscode.ts`, `makeContext()`): contract tests for the edit/diff/XML formats, `KeyPool` rotation, provider mappers, `secrets` migration, `SessionManager`, the tool registry, file tools, the tool-calling adapter, triage, prompts, and an end-to-end `AgentLoop` (native + XML fallback, plan gating, completion gate).

---

# Extending Flash Code

- **Add a provider:** implement `Provider` in `src/providers/<name>.ts` (or reuse `OpenAICompatibleProvider`), register it in `registry.ts`, and add config + sidebar option. Keep wire mapping in pure exported functions and add mapper tests.
- **Add a tool:** declare one `ToolDef` in `core/tools/*` (schema + handler + `mutates`/`category`). Both transports are generated from it. Execute external programs via `ctx.runExec` (argv), validate paths with `safeRelPath`.
- **Add a subagent:** add a profile to `SUBAGENTS` with a focused prompt + tool allowlist.
- **Never** import `vscode` in `core/` or `providers/` — flow host capabilities through `ToolContext`.

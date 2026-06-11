# Changelog

All notable changes to Flash Code are documented here.

## [2.3.0]

### Added
- **Token usage tracking.** A metering proxy around the provider records every model API call — input (sent) and output (received) tokens — **per chat session and per model**, persisted per workspace. View it in **Settings → Usage & Tokens** (with a "Clear usage data" button). Counts are the providers' real numbers, including Anthropic input tokens (from `message_start`) and Ollama (`prompt_eval_count`/`eval_count`).
- **"Allow for this thread" command approval.** The command/code run prompt gains a third option that auto-approves *similar* commands for the rest of the current message thread (reset on your next message). Similarity is by category — read-only inspection commands (`type`/`findstr`/`Get-Content | Select-String`…) collapse into one grant, while a different or mutating command (e.g. `git push`, `npm install`) still asks.

### Fixed / Hardened
- **Truthful edits.** The `edit` tool no longer reports "applied" when nothing actually changed (a malformed/empty SEARCH/REPLACE body, or a no-op replacement). It returns a clear `NOT APPLIED` with the current file content so the model self-corrects. "applied." now appears **only** on a real write — which always renders the red/green diff card.
- Tightened the edit-format instructions (system prompt rule + `edit` tool description) so models emit valid SEARCH/REPLACE blocks.

## [2.2.0]

### Added
- **Intent routing (triage).** A fast, cheap classifier (`src/core/triage.ts`) routes each message to **general** (direct answer, no tools), **codebase** (read-only understanding), or **agentic** (full tool loop). General/conceptual questions are answered directly instead of triggering codebase exploration.
- **Completion gate.** The agent loop verifies the objective is genuinely met before stopping (strict `COMPLETION_JUDGE`), so it no longer trails off on a mere intention ("let me check…"). Bounded by a continuation cap + iteration cap + stall guard so it can't loop forever.
- **Custom models.** Add any model ID per provider from the sidebar settings (`flashCode.customModels`) — use new/future models without an update.
- **Message queue.** Sending while the agent is busy now queues the message and runs it after the current task (instead of being dropped).
- **Key-file grounding.** README/package.json are injected into context for codebase/agentic runs, reducing aimless `list_files` loops.

### Changed
- Sessions are indexed and listed the moment you send (named from your first message), not after the response completes.
- The composer mode menu includes **Autonomous**; the `/agent` quick-actions map to real subagent roles (WebScout/QA/Debugger/Sculptor).
- Tool cards show the **actual output** (file contents, tree, matches) instead of the `[tool args]` label echo.
- Diffs always render as their own card (no more swallowed diffs); removed the "Yes, always" accept option.

### Fixed / Hardened
- **Anti-hallucination:** the model cannot claim it searched the web / read a file / ran a command without actually calling the tool; URL/web questions must use `search_web`/`fetch_url`.
- **Network resilience:** transient `fetch` failures and 5xx are wrapped as retryable (`safeFetch`) so the KeyPool reroutes/backs off instead of aborting.
- **Gemini multi-turn tool calls:** replay `thoughtSignature` so follow-up requests don't 400.
- Repeated/duplicate tool calls (e.g. `list_files` loops) are detected and short-circuited.
- **New Session** button now actually starts a fresh chat (previously only revealed the panel).
- Removed dead `src/shared/protocol.ts`; relocated session types to `src/session/types.ts`.

## [2.1.0] — Claude-Code-grade rebuild

A ground-up rebuild of the backend and UI. The proven domain logic (diff/edit engine, key rotation, file utils) was preserved; everything around it was re-architected.

### Added
- **Pluggable multi-provider engine** — Gemini, Anthropic (Claude), OpenAI, OpenRouter, Groq, DeepSeek, Nvidia, Ollama behind one `Provider` interface with a normalized streaming-event model. Adding a provider is one file.
- **Native tool-calling** for Claude/OpenAI/Gemini, with an XML-tag fallback for models without it (Ollama) — normalized into a single provider-agnostic agent loop.
- **Generalized key rotation** (`KeyPool`) — round-robin, per-key cooldown on 429, auth-disable on 401/403, and global RPM pacing. Keeps Gemini's free-tier multi-key survival and extends it to any provider.
- **Secret Storage** for all API keys, with one-time migration from legacy plaintext settings.
- **Preact + esbuild UI** preserving Flash Code's identity (⚡ brand, timeline flow, Mission Control, diff cards, effort/mode chips), with `marked` + **DOMPurify** rendering and strict **CSP + nonce**.
- **Test suite + CI** — Vitest (contract + unit + end-to-end agent loop) and a GitHub Actions pipeline (typecheck → lint → test → build).

### Changed
- Prompts consolidated from a 13-persona triage router into one strong tool-using agent + mode directives; 11 lean subagent profiles retained for delegation, each with an enforced tool allowlist.
- Build moved from `tsc`-only to esbuild (host + webview bundles) with `tsc --noEmit` type-checking.

### Fixed / Hardened
- **Dashboard XSS** (unescaped LLM-derived strings) — eliminated by sanitized rendering.
- **Command injection** in interpolated git/exec calls — now `execFile`/argv with `shell:false`.
- **Plaintext secrets** — moved to Secret Storage.
- **Path traversal** in tool paths — validated and rejected.
- **Prompt injection** — injected file/tree/rules content wrapped as DATA with role-lock guardrails.
- Unbounded Gemini retry, unbounded chat history, dead code (`AgentCore`), and webview reference bugs (`workRow`, `finishThinking`).
- Session IDs are now collision-resistant within the same millisecond.

### Security notes
- The only `npm audit` advisories are dev-only (vitest/vite/esbuild dev-server) and are not present in the shipped bundle.

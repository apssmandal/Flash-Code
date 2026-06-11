# ⚡ Flash Code

<p align="center">
  <img src="resources/icon.png" alt="Flash Code Logo" width="96" />
</p>

<p align="center">
  <strong>An open-source, multi-provider agentic AI coding assistant for VS Code.</strong><br/>
  Claude-Code-grade backend · 8 providers · Native tool-use · Intent routing · Free-tier key rotation · Beautiful diff review
</p>

---

## ✨ What is Flash Code?

Flash Code is a production-grade AI coding agent that lives inside VS Code. Give it a goal and it classifies your intent, plans, reads your codebase, writes and edits files (with reviewable diffs), runs commands (with your approval), spawns specialized subagents, and **keeps working until the objective is actually complete** — streaming everything into a transparent, timeline-style UI. It speaks to **eight AI providers** through one pluggable engine and keeps Google Gemini's free tier alive with multi-key round-robin rotation.

> **Version 2.3.0.** See [`docs/DEVELOPER_GUIDE.html`](docs/DEVELOPER_GUIDE.html) (rich, with diagrams &amp; charts — open in a browser; [`.md`](docs/DEVELOPER_GUIDE.md) quick reference) for a full architecture walkthrough and [`CHANGELOG.md`](CHANGELOG.md) for what's new.

---

## 🤖 Providers

| Provider | Tool-use | Notes |
|----------|----------|-------|
| **Google Gemini** | native | **Multi-key round-robin rotation** for free-tier survival |
| **Anthropic (Claude)** | native | Highest coding quality; thinking + prompt caching |
| **OpenAI** | native | GPT models |
| **OpenRouter** | native | One key → hundreds of models |
| **Groq** | native | Ultra-fast inference |
| **DeepSeek** | native | Cheap, strong at code |
| **Nvidia** | native | OpenAI-compatible endpoint |
| **Ollama** | XML fallback | Fully local & private |

- **Custom models:** type *any* model ID per provider in the sidebar settings — use new/future models without waiting for an update.
- **Secure keys:** all API keys live in VS Code **Secret Storage**, never in `settings.json` (legacy plaintext keys are migrated automatically).

---

## 🚀 Key features

- **Intent routing (triage).** A fast, cheap classification call routes each message: **general** (answer directly, no tools), **codebase** (read-only understanding of *this* project), or **agentic** (full tool loop — web search, edits, commands, subagents). So "how do circuit breakers work" is answered directly, while "fix this bug" runs the agent.
- **Native tool-calling + XML fallback.** Uses each provider's function-calling; falls back to XML-tag parsing for local models (Ollama) — normalized into one provider-agnostic loop.
- **Completion gate.** Before stopping, a strict judge checks the objective is genuinely met; if the model only stated an intention ("let me check…"), it's pushed to keep going — bounded by hard caps so it never loops forever.
- **Anti-hallucination.** It must actually call `search_web`/`fetch_url` (or a WebScout subagent) to answer about a URL or live info — it can't fabricate tool results.
- **Reviewable diffs.** Every edit is shown as a red/green diff card with **Yes / No / Tell instead…**. The `edit` tool reports `applied` **only** on a real write — a no-op or unmatched edit says `NOT APPLIED` and is retried, so the agent can't falsely claim success.
- **Approvals.** Running commands/scripts **always asks** for permission (any mode) unless you opt into `autoApprove`. Each prompt offers **Run · Allow for this thread · Reject** — "allow for this thread" auto-approves *similar* commands (read-only inspection collapses into one grant) until your next message, while a different/mutating command (e.g. `git push`) still asks.
- **Usage tracking.** Every model call's tokens (sent/received) are recorded **per session and per model** and shown in **Settings → Usage & Tokens** — real provider counts, persisted per workspace, with a one-click clear.
- **11 specialized subagents** (Architect, Inspector, WebScout, Debugger, Sentinel, Tuner, QA, Sculptor, Stylist, Scribe, Orchestrator) with enforced tool allowlists — visible as cards in chat and on the **Mission Control** kanban.
- **Four modes:** Ask · Auto-Edit · Plan · Autonomous. **Session management:** new/search/rename/delete, persisted per workspace.
- **Resilient networking.** Transient network failures / 503s are retried and rerouted across keys instead of aborting.

---

## 📦 Setup

```bash
git clone https://github.com/apssmandal/Flash-Code.git
cd Flash-Code
npm install
npm run build          # esbuild bundles the host
npm run package        # produces flash-code-2.3.0.vsix
code --install-extension flash-code-2.3.0.vsix
```

Then press **`Ctrl+Shift+A`** (`Cmd+Shift+A` on macOS). Add keys via the sidebar **gear → provider → key → Save**, or the **“Flash Code: Manage API Keys”** command.

> Get free Gemini keys at [Google AI Studio](https://aistudio.google.com/). Add several (comma-separated) for round-robin rotation.

---

## ⚙️ Configuration

| Setting | Description |
|---------|-------------|
| `flashCode.provider` | Active provider |
| `flashCode.<provider>.model` | Model per provider |
| `flashCode.customModels` | Per-provider custom model IDs (managed from the sidebar) |
| `flashCode.mode` | `ask` · `auto-edit` · `plan` · `autonomous` |
| `flashCode.effort` | `low` → `max` thinking/token budget |
| `flashCode.autoApprove` | Skip command/script approval prompts (off by default) |
| `flashCode.rateLimit.requestsPerMinute` | Global RPM cap across a provider's keys |
| `flashCode.ollama.url` / `.model` / `.numCtx` | Local Ollama config |

Drop Markdown files in a `.flash/` folder to inject enforced **project rules** into every prompt.

---

## 🛠️ Development

```bash
npm run watch      # rebuild the host on change (then press F5)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # vitest
npm run coverage   # core-logic coverage report
```

Press **F5** to launch the Extension Development Host. Architecture and a file-by-file walkthrough live in [`docs/DEVELOPER_GUIDE.html`](docs/DEVELOPER_GUIDE.html) (rich, with diagrams &amp; charts — open in a browser; [`.md`](docs/DEVELOPER_GUIDE.md) quick reference). Contribution guidelines: [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## 📄 License

**MIT** — free to use, modify, and distribute. Developed with ❤️ by **Arpan Mandal**.

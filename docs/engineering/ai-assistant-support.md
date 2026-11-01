# AI assistant support

**Policy version:** AF-DELIVERY-1.0
**Canonical process:** `docs/engineering/delivery-workflow.md`

AI-Filter uses provider-neutral delivery controls. An assistant's instruction file improves discovery, while GitHub checks, Jira API verification, repository tests, and human approval provide evidence.

| Assistant | Repository entrypoint | Discovery status |
|---|---|---|
| Codex and compatible agents | `AGENTS.md`, `.agents/skills/<name>/SKILL.md` | File structure and policy references tested; fresh-session discovery pilot still required. |
| GitHub Copilot | `.github/copilot-instructions.md` | Adapter present; IDE discovery pilot required. |
| Claude Code | `CLAUDE.md` | Adapter present; CLI discovery pilot required. |
| Gemini CLI | `GEMINI.md` | Adapter present; CLI discovery pilot required. |
| Cursor | `.cursor/rules/delivery-workflow.mdc` | Adapter present; editor discovery pilot required. |
| Windsurf | `.windsurf/rules/delivery-workflow.md` | Adapter present; editor discovery pilot required. |
| Human-only workflow | `CONTRIBUTING.md`, PR template | Supported without an AI provider. |

Adapters stay short and reference the canonical policy version. Provider-specific adapters do not copy the full policy. Adding another assistant requires a minimal adapter, a documented discovery path, and a drift-test entry.

`apps/web/AGENTS.md` remains a separate scoped contract for the installed Next.js version. Root instructions supplement it and never replace it.

The pull request records AI tools used for accountability and process analysis. Provider choice does not change acceptance, test, security, Jira, CI, or human approval requirements.

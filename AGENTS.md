# AGENTS.md / CLAUDE.md / GEMINI.md

Guidance for coding agents working in this repository.

## What This Is

An opencode plugin (`opencode-permissions-classifier`) that reviews permission evaluations which the static permission rules resolved to `ask`. It sends evidence to a user-configured LLM (the default backend) or TypeSafe Jev. The LLM returns a JSON decision; the TypeSafe backend derives a decision from typed answers. Both share the brake, gate, cache, escalation behavior, and audit log. Every error path fails closed.

This package targets OpenCode v2 (`opencode2`) only. It depends on `@opencode/plugin` at an exact version, pinned as a runtime dependency, because opencode installs published plugins with production dependencies only.

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (tsc) to dist/
npm run typecheck    # Type-check sources and tests (tsc --noEmit -p tsconfig.test.json)
bun test             # Run the test suite
```

npm is the package manager. Bun is the test runner only. There is no linter.

## Architecture

- **`src/index.ts`** — Plugin entry point. Calls `Plugin.define({ id, setup })`. `setup(ctx)` resolves the plugin options, registers the `permission.evaluate`, `tool.execute.before`, and `shell.create.before` hooks, holds the decision cache, and returns the cleanup function.
- **`src/config.ts`** — Parses and validates `ctx.options`. Applies defaults. Reports invalid options as warnings.
- **`src/model-ref.ts`** — Turns a model string or object into an explicit `{ providerID, id, variant? }` reference.
- **`src/redact.ts`** — Replaces secrets with `[REDACTED:kind]` before any text leaves the process.
- **`src/brake.ts`** — Emergency brake. Blocks a small set of actions before the model is called.
- **`src/correlation.ts`** — Links `tool.execute.before` and `shell.create.before` records to the matching `permission.evaluate` call.
- **`src/policy.ts`** — Holds the built-in policy text and merges a user override.
- **`src/evidence.ts`** — Builds the evidence payload sent to the model. Applies the size limits. Resolves each path resource against the project directory and the home directory, and reports the result on the `RESOURCE_LOCATION` line.
- **`src/decision.ts`** — Parses the model output into a decision. Applies the deterministic gate.
- **`src/classifier.ts`** — Dispatches one review: runs the brake, extracts user intent, calls the injected reviewer, and applies the shared gate.
- **`src/reviewer.ts`** — Defines the backend-neutral reviewer input, outcome, and interface.
- **`src/reviewers/llm.ts`** — Builds the LLM prompt, applies its timeout, and retries malformed JSON once.
- **`src/reviewers/typesafe.ts`** — Builds JSON state, calls System One under an abortable deadline, validates the answers, and derives a decision.
- **`src/typesafe/client.ts`** — Wraps the pinned official SDK with logging disabled.
- **`src/typesafe/questions.ts`** — Holds the eleven typed questions, policy notes, and question version.
- **`src/typesafe/state.ts`** — Builds redacted, size-limited JSON evidence.
- **`src/typesafe/answers.ts`** — Validates answer shapes and derives the decision and rationale.
- **`src/audit.ts`** — Appends one JSON line per decision to the audit log.
- **`src/notices.ts`** — Formats session decision notices, identifies tagged notices, and handles best-effort delivery. Notice descriptions carry display text; model-facing text stays empty.
- **`src/types.ts`** — Shared types.
- **Root `index.ts`** — Development shim. Re-exports the default export of `src/index.ts` so a local directory path works as a configured plugin with no build step.
- **`test/`** — One test file per module.

## OpenCode v2 permission semantics this code depends on

- Config rules live in `permissions: [{ action, resource, effect }]`. The last matching rule wins. No match means `ask`.
- The host runs `permission.evaluate` hooks after rule evaluation, and only for `allow` and `ask`. A configured `deny` never reaches the hook. The hook mutates `event.effect` and `event.message` in place. `message` becomes the denial reason the agent sees, or the prompt text on `ask`.
- The hook is invoked again when the user replies `always` to a pending request, because the other pending requests are re-evaluated. Decisions must therefore be cached and idempotent.
- A rejected hook promise fails the tool call. The handler catches everything and applies a fail-closed result instead.
- `ctx.generate.text({ prompt, model })` (LLM backend only) is sessionless and toolless. It rejects on an unresolvable model, and it picks a default when `model` is omitted, so this plugin always passes an explicit model. There is no abort signal, so a timeout cannot cancel the underlying call.
- `ctx.session.context({ sessionID })` returns the message list. Only messages with `type: "user"` count as user intent.
- `tool.execute.before` fires before the tool body, and therefore before `permission.evaluate`. `event.source.id` in evaluate equals its `id`. `shell.create.before` fires before the shell tool's permission check and carries neither a call id nor a session id, so its command attaches to the newest pending shell call.
- Actions are: `read`, `edit` (edit, write, and patch; the diff preview is in `metadata.files`), `glob`, `grep`, `shell` (one resource per parsed statement), `subagent`, `skill`, `question`, `webfetch`, `websearch`, `external_directory`, `execute`, and `<server>_<tool>` for MCP tools.
- `--auto` / `--yolo` is client-side. The TUI and `run` auto-reply `once` to every published `ask`. The plugin cannot detect the flag. The mitigation is `escalation: "deny"`.
- A configured local plugin path must be a directory that contains `index.ts` or `index.js`. Only that file is watched for reload.
- Writing files inside the project, or inside any `.opencode/` directory, triggers a config reload loop. The audit log therefore lives under the XDG data directory.

## Key Design Decisions

- Fail closed on every error path. A timeout, a model error, unparseable output, or a missing model never produces an allow.
- The deterministic gate only restricts model allows. It never loosens a decision.
- Two backends share the brake, gate, cache, and audit. TypeSafe sends evidence as JSON state, not concatenated instructions. A `steering_attempt` question escalates evidence that addresses the reviewer.
- TypeSafe's holistic outcome can only veto an allow. Non-critical model denies escalate; critical risk denies deterministically.
- `@typesafe-ai/sdk` is pinned to `0.6.0` as a runtime dependency. Its request logging stays off. Never store the API key in evidence or audit records.
- A configured `deny` is never overridden. The hook does not receive it.
- The `escalation` option exists for unattended runs, where the client auto-approves an `ask`.
- The audit log lives outside the project directory, to avoid a config reload loop.
- The plugin redacts secrets before the evidence reaches the model and before it reaches the audit log.
- A per-call nonce delimits the evidence sections, and the plugin breaks delimiter look-alikes in untrusted text, so evidence cannot forge a policy section.
- The plugin caches a decision only when the host supplies a tool call id, and reviews a request without one every time.
- Session notices use the post-gate result and are not repeated on cache hits. `showDecisions` defaults to true; `showDecisionTiming` defaults to false. Notice delivery never changes a permission decision.
- `@opencode/plugin` is pinned to an exact version and declared as a runtime dependency.
- The policy text and the code are original work, released under MIT.

## Git

Commit messages never mention Claude, AI assistance, co-author trailers, or session identifiers. Use plain Conventional Commits. Commit only when asked.

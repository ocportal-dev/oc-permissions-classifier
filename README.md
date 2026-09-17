# opencode-permissions-classifier

An opencode plugin that reviews permission requests with your LLM or TypeSafe Jev. Your static permission rules decide most things. The plugin reviews requests they resolve to `ask`, then allows, denies, or escalates them. It fails closed: errors require human review, or block the request when `escalation: "deny"` is set.

> Requires OpenCode v2 (`opencode2`). This package pins `@opencode/plugin` to `2.0.5`. Configure an OpenCode provider/model for the LLM backend, or an API key for TypeSafe.

## How It Works

```
static permission rules
        │
        ▼
  resolved to ask? ──no──► untouched
        │ yes
        ▼
  emergency brake
        │
        ▼
  evidence (action, resources, metadata, recent user intent, tool input)
        │
        ▼
 reviewer: your LLM (llm) or TypeSafe Jev (typesafe)
        │
        ▼
   shared decision
        │
        ▼
 deterministic gate
        │
        ▼
allow / deny / escalate to you
```

- Rules that resolve to `allow` pass through untouched. The plugin does not review them.
- A configured `deny` stands. The plugin never sees it.
- Every error escalates: a timeout, a model error, malformed output, or a missing model or API key.
- The plugin writes every decision to an audit log.

## Setup

1. Pick a backend. For the default LLM backend, choose a model that opencode can reach.
2. Install the plugin by adding it to the `plugins` array in your `opencode.jsonc`.
3. Write permission rules that send only the actions you care about to `ask`.
4. Restart `opencode2`.

```jsonc
{
  "permissions": [
    { "action": "*", "resource": "*", "effect": "allow" },
    { "action": "shell", "resource": "git push *", "effect": "ask" },
    { "action": "shell", "resource": "ssh *", "effect": "ask" },
    { "action": "shell", "resource": "rm *", "effect": "ask" }
  ],
  "plugins": [
    {
      "package": "opencode-permissions-classifier",
      "options": { "model": "omlx-macstudio/gemma-4-26B-A4B-it-qat-OptiQ-4bit" }
    }
  ]
}
```

The plugin reviews only the actions your rules resolve to `ask`: here, `git push`, `ssh`, and `rm`. The first rule allows everything else, which never reaches the plugin.

Restart `opencode2` after you edit the config.

## Configuration

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `backend` | `"llm" \| "typesafe"` | `"llm"` | Selects the reviewer. |
| `model` | `"provider/model[#variant]"` or `{ providerID, id, variant? }` | required for `llm` | Split at the first `/`. Missing or invalid values fail closed. Unused by TypeSafe. |
| `escalation` | `"ask" \| "deny"` | `"ask"` | What to do when the plugin cannot allow. |
| `timeoutMs` | number | `60000` | Time budget for each LLM call. |
| `confidenceThreshold` | number, 0..1 | `0.7` | Minimum confidence for an auto-allow. |
| `intentMessages` | integer | `8` | How many recent user messages to include. |
| `maxIntentChars` | integer | `8000` | Character cap on the user intent section. |
| `maxEvidenceChars` | integer | `24000` | Character cap on the whole evidence payload. |
| `audit` | boolean | `true` | Write an audit log. |
| `auditPath` | string | `$XDG_DATA_HOME/opencode/opencode-permissions-classifier/audit.jsonl` | Falls back to `~/.local/share/...`. Paths inside the project, or inside any `.opencode` directory, are rejected. |
| `policy` | string | built-in | Replaces the LLM policy, or TypeSafe `state.policy_notes`. |
| `riskPolicy.allow` | matrix | `{ low: [high, medium, low, unknown], medium: [high, medium, low], high: [high, medium], critical: [] }` | Which user-authorization levels may be auto-allowed per risk level. |
| `ignoreActions` | string[] | `[]` | Actions that are never reviewed. They stay `ask`. |
| `debug` | boolean | `false` | Log one line per decision: action, applied effect, decision source, duration. |
| `showDecisions` | boolean | `true` | Show one session notice per classifier review. Static rules, ignored actions, and cached decisions do not produce notices. |
| `showDecisionTiming` | boolean | `false` | Include elapsed review time in session notices. Does not change audit timing or debug logs. |
| `typesafe.apiKey` | string | `TYPESAFE_API_KEY` environment variable | Prefer `"{env:TYPESAFE_AI_API_KEY}"` in OpenCode config. Missing keys fail closed. |
| `typesafe.model` | string | `"jev-latest"` | Plain model name, without a provider prefix. |
| `typesafe.baseURL` | string | `"https://api.typesafe.ai"` | HTTP(S) API root; trailing slashes removed. |
| `typesafe.timeoutMs` | number, 1000..600000 | `15000` | Per-attempt timeout. Overall budget is this value × (`maxRetries` + 1), including retry delays. |
| `typesafe.maxRetries` | integer, 0..5 | `2` | SDK retries after the first attempt. |
| `typesafe.thresholds.steering` | number, 0..1 | `0.5` | Escalate an instruction aimed at the reviewer. |
| `typesafe.thresholds.secret` | number, 0..1 | `0.5` | Raise risk to critical and deny secret disclosure. |
| `typesafe.thresholds.destructive` | number, 0..1 | `0.7` | Raise destructive actions to at least high risk. |
| `typesafe.thresholds.weakensSecurity` | number, 0..1 | `0.7` | Raise security weakening to at least high risk. |
| `typesafe.thresholds.outsideWorkspace` | number, 0..1 | `0.7` | Escalate outside paths without explicit authorization. |
| `typesafe.thresholds.remoteOpacity` | number, 0..2 | `1.5` | Mark evidence insufficient when executed content is not visible. |

## Backends

`llm` is the default prompt-and-parse path. It uses `ctx.generate.text`, retries malformed JSON once, and applies the shared deterministic gate.

```jsonc
"options": {
  "backend": "llm",
  "model": "omlx-macstudio/gemma-4-26B-A4B-it-qat-OptiQ-4bit"
}
```

`typesafe` sends JSON state and eleven typed questions to Jev, TypeSafe's RLCD-trained System One model. The official SDK is pinned to `0.6.0`. Jev returns probabilities, not a written rationale. The plugin derives the decision and reason in code.

```jsonc
"options": {
  "backend": "typesafe",
  "typesafe": {
    "apiKey": "{env:TYPESAFE_AI_API_KEY}",
    "model": "jev-latest"
  }
}
```

The OpenCode process must have access to `TYPESAFE_AI_API_KEY` to resolve this placeholder. A daemon does not normally read your interactive shell configuration. Supply the variable through its service environment. Alternatively, omit `typesafe.apiKey` and supply `TYPESAFE_API_KEY`. Do not put a literal key in source control. A top-level `model` may remain configured for an LLM fallback, but fallback requires changing `backend`; it is not automatic.

### How the TypeSafe decision is derived

1. Copy the risk axis. Secret disclosure at its threshold raises risk to critical. Destructive actions or security weakening raise risk to at least high, never lower it.
2. Copy user authorization and scope alignment.
3. Copy evidence completeness. Remote opacity at its threshold changes it to insufficient.
4. Deny critical risk. Otherwise, escalate steering, unauthorized outside paths, or any Jev outcome other than allow. A Jev `deny` at non-critical risk becomes an escalation.
5. Use the lowest confidence of risk, authorization, and outcome.
6. Build a deterministic rationale from the axes, probabilities, and triggered hazards.
7. Return decision version `2`, then apply the same gate used for LLM decisions (version `1`). The gate can restrict an allow, never create one.

Jev's outcome is veto-only. An `allow` answer cannot bypass a hazard or the shared gate. Raising an action to high risk does not itself block it; the authorization policy still applies.

## Session decision notices

The OpenCode TUI and web transcript show the final classifier result. Notices are enabled by default (`showDecisions: true`); elapsed time is hidden by default (`showDecisionTiming: false`). These flags work with both backends. Jev remains opt-in through `backend: "typesafe"`; the default backend is `llm`.

```text
Permissions: auto-approved · shell
Permissions: denied · shell
Permissions: needs your approval · shell
```

Add these fields to your existing plugin options to show elapsed review time. Keep your existing backend, model, and API-key settings:

```jsonc
"options": {
  "showDecisions": true,
  "showDecisionTiming": true
}
```

The notice then ends with a duration, for example `· 144 ms`. This is total review time, not inference time alone: it includes transcript retrieval, evidence preparation, the provider call and any retries, response validation, and the deterministic gate. It excludes command execution and notice delivery. Set `showDecisions: false` to stop new notices; `showDecisionTiming` has no visible effect while notices are off. Existing audit and debug behavior stays unchanged.

Notices use synthetic message descriptions with empty model-facing text and `resume: false`. They do not start another agent run. Tagged notice IDs are filtered from model-request hooks; the display text is never placed in model-facing content, including retained compaction text. A client must render synthetic descriptions to display these notices. The custom iOS adapter currently reads synthetic text instead, so it may not show them.

Notice delivery is best effort. A display failure does not change the permission decision. Escalation with `escalation: "deny"` is shown as blocked, not as waiting for approval.

## Choosing a model

Pick a model that is fast, follows instructions, and returns reliable JSON. The reviewing model runs on every `ask`, so you wait for it every time.

Local models work well. Example:

```jsonc
"options": { "model": "omlx-macstudio/gemma-4-26B-A4B-it-qat-OptiQ-4bit" }
```

A small cloud model also works. Example:

```jsonc
"options": { "model": "openai/gpt-5.4-nano#none" }
```

Model ids that contain `/` are fine. Only the first `/` separates the provider from the model.

## Escalation and --auto

`--auto` and `--yolo` are client-side flags. The TUI and `run` auto-approve every `ask` before you see it. The plugin cannot detect the flag.

For unattended runs, set:

```jsonc
"options": { "escalation": "deny" }
```

Uncertain actions then block instead of turning into an auto-approved `ask`.

## What the model sees

- The action and the resources.
- Whether each path resource is inside the project, in your home directory, or elsewhere. The plugin computes this; the model does not guess.
- The metadata, for example an edit diff preview.
- The last N user messages.
- The last assistant text, marked as an untrusted stated purpose.
- The raw tool input, when it is available.

The plugin replaces secrets with `[REDACTED:kind]` before anything leaves the process. The reviewing model gets no tools.

## Audit log

The default path is:

```
$XDG_DATA_HOME/opencode/opencode-permissions-classifier/audit.jsonl
```

It falls back to `~/.local/share/opencode/opencode-permissions-classifier/audit.jsonl`. The plugin creates the file with mode `0600` and appends one JSON object per line.

Each line has these fields: `timestamp`, `durationMs`, `sessionID`, `agent`, `action`, `resources`, `outcome`, `appliedEffect`, `decisionSource`, `reason`, `decision`, `model`, `attempts`, `warnings`, `backend`, and `promptVersion`. Successful TypeSafe reviews also include redacted raw `answers` and the model returned by the service. `promptVersion` identifies the LLM prompt or TypeSafe question battery. `attempts` counts reviewer calls, not SDK transport retries.

Read the recent decisions with:

```bash
tail -n 20 ~/.local/share/opencode/opencode-permissions-classifier/audit.jsonl | jq -c '{action, outcome, decisionSource, reason}'
```

## Development

```bash
npm install
npm run build
npm run typecheck
bun test
```

Run the opt-in TypeSafe contract tests with `npm run test:live`. The helper uses an existing `TYPESAFE_API_KEY`, or reads the `TYPESAFE_AI_API_KEY` export from `~/.zshrc` without saving it. These tests send synthetic evidence to the real API and may incur charges. Ordinary `bun test` skips them when `TYPESAFE_API_KEY` is unset.

To run a local checkout, point `package` at the repository directory:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/oc-permissions-classifier",
      "options": { "model": "openai/gpt-5.4-nano#none" }
    }
  ]
}
```

This uses the root `index.ts` shim, so no build is needed. opencode watches that file alone, so an edit under `src/` needs `touch index.ts` or a restart before it reloads.

To reload on every build instead, run `npm run build` and point `package` at `/absolute/path/to/oc-permissions-classifier/dist`.

Verify that the plugin loaded:

```bash
opencode2 api get /api/plugin
```

## License

MIT

# opencode-permissions-classifier

An opencode plugin that reviews permission requests with a model you choose. Your static permission rules decide most things. The plugin sends anything they resolve to `ask` to your model, together with the surrounding context, and the model answers allow, deny, or escalate. The plugin fails closed: if anything goes wrong, the request comes back to you.

> Requires OpenCode v2 (`opencode2`, plugin API `0.0.0-beta-18743` or newer beta) and a configured provider/model.

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
     your model
        │
        ▼
   JSON decision
        │
        ▼
 deterministic gate
        │
        ▼
allow / deny / escalate to you
```

- Rules that resolve to `allow` pass through untouched. The plugin does not review them.
- A configured `deny` stands. The plugin never sees it.
- Every error escalates: a timeout, a model error, unparseable output, or a missing model.
- The plugin writes every decision to an audit log.

## Setup

1. Pick a provider and model that opencode can already reach.
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
| `model` | `"provider/model[#variant]"` or `{ providerID, id, variant? }` | required | Split at the first `/`. If it is missing or invalid, the plugin logs a warning and every reviewed request stays `ask`. |
| `escalation` | `"ask" \| "deny"` | `"ask"` | What to do when the plugin cannot allow. |
| `timeoutMs` | number | `60000` | Time budget for the model call. |
| `confidenceThreshold` | number, 0..1 | `0.7` | Minimum confidence for an auto-allow. |
| `intentMessages` | integer | `8` | How many recent user messages to include. |
| `maxIntentChars` | integer | `8000` | Character cap on the user intent section. |
| `maxEvidenceChars` | integer | `24000` | Character cap on the whole evidence payload. |
| `audit` | boolean | `true` | Write an audit log. |
| `auditPath` | string | `$XDG_DATA_HOME/opencode/opencode-permissions-classifier/audit.jsonl` | Falls back to `~/.local/share/...`. Paths inside the project, or inside any `.opencode` directory, are rejected. |
| `policy` | string | built-in | Replaces the built-in policy text. |
| `riskPolicy.allow` | matrix | `{ low: [high, medium, low, unknown], medium: [high, medium, low], high: [high, medium], critical: [] }` | Which user-authorization levels may be auto-allowed per risk level. |
| `ignoreActions` | string[] | `[]` | Actions that are never reviewed. They stay `ask`. |
| `debug` | boolean | `false` | Log one line per decision: action, applied effect, decision source, duration. |

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

Each line has these fields: `timestamp`, `durationMs`, `sessionID`, `agent`, `action`, `resources`, `outcome`, `appliedEffect`, `decisionSource`, `reason`, `decision`, `model`, `attempts`, `warnings`.

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

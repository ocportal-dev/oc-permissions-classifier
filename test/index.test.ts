import { expect, it } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import plugin, { createPlugin } from "../src/index.js"
import { CLASSIFIER_NOTICE_METADATA } from "../src/notices.js"
import { createTypeSafeReviewer } from "../src/reviewers/typesafe.js"
import type { AuditRecord, PermissionEvent } from "../src/types.js"
import { okResult } from "./helpers/answers.js"

type Callback = (input: never) => unknown

const OPTIONS = { model: "local/reviewer", audit: false }

const decision = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 1,
    outcome: "allow",
    risk_level: "low",
    user_authorization: "high",
    scope_alignment: "aligned",
    evidence_completeness: "sufficient",
    rationale: "reads one project file",
    confidence: 0.9,
    ...overrides,
  })

const event = (overrides: Partial<PermissionEvent> = {}): PermissionEvent => ({
  sessionID: "s1",
  action: "shell",
  resources: ["git push origin main"],
  effect: "ask",
  ...overrides,
})

async function start(
  options: unknown,
  answers: string[] = [],
  selectedPlugin: Plugin.Plugin = plugin,
  runtime: {
    context?: readonly unknown[] | (() => Promise<readonly unknown[]>)
    synthetic?: (input: Record<string, unknown>) => Promise<unknown>
  } = {},
) {
  const hooks = new Map<string, Callback>()
  const prompts: string[] = []
  const synthetics: Record<string, unknown>[] = []
  const disposed: string[] = []
  const counts = { context: 0 }

  const hook =
    (domain: string) =>
    async (name: string, callback: Callback) => {
      hooks.set(`${domain}.${name}`, callback)
      return {
        dispose: async () => {
          disposed.push(`${domain}.${name}`)
        },
      }
    }

  const ctx = {
    options,
    app: {},
    location: { directory: "/project" },
    permission: { hook: hook("permission") },
    tool: { hook: hook("tool") },
    shell: { hook: hook("shell") },
    generate: {
      text: async (input: { prompt: string }) => {
        prompts.push(input.prompt)
        const answer = answers.shift()
        if (answer === undefined) throw new Error("provider unreachable")
        return { text: answer }
      },
    },
    session: {
      hook: hook("session"),
      context: async () => {
        counts.context += 1
        return typeof runtime.context === "function"
          ? runtime.context()
          : runtime.context ?? []
      },
      synthetic: async (input: Record<string, unknown>) => {
        synthetics.push(input)
        return runtime.synthetic?.(input) ?? {}
      },
    },
  } as unknown as Plugin.Context

  const cleanup = await selectedPlugin.setup(ctx)
  const call = async (name: string, input: unknown): Promise<void> => {
    const callback = hooks.get(name)
    if (!callback) throw new Error(`hook ${name} was not registered`)
    await callback(input as never)
  }
  return { hooks, prompts, synthetics, disposed, counts, cleanup, call }
}

const evaluate = (
  started: Awaited<ReturnType<typeof start>>,
  input: PermissionEvent,
): Promise<void> => started.call("permission.evaluate", input)

it("exposes the plugin id", () => {
  expect(plugin.id).toBe("opencode-permissions-classifier")
})

it("registers the permission, tool, and shell hooks", async () => {
  const started = await start(OPTIONS)
  expect([...started.hooks.keys()].sort()).toEqual([
    "permission.evaluate",
    "session.compaction",
    "session.context",
    "session.generate",
    "session.title",
    "shell.create.before",
    "tool.execute.before",
  ])
})

it("leaves an allowed request untouched", async () => {
  const started = await start(OPTIONS, [decision()])
  const request = event({ effect: "allow" })
  await evaluate(started, request)
  expect(request.effect).toBe("allow")
  expect(request.message).toBeUndefined()
  expect(started.prompts).toEqual([])
  expect(started.counts.context).toBe(0)
})

it("applies a model allow", async () => {
  const started = await start(OPTIONS, [decision()])
  const request = event()
  await evaluate(started, request)
  await Promise.resolve()
  expect(request.effect).toBe("allow")
  expect(request.message).toBeUndefined()
  expect(started.counts.context).toBe(1)
  expect(started.synthetics).toEqual([
    {
      sessionID: "s1",
      text: "",
      description: "Permissions: auto-approved · shell",
      metadata: CLASSIFIER_NOTICE_METADATA,
      resume: false,
    },
  ])
})

it("selects the TypeSafe backend and records its typed result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "permissions-classifier-typesafe-"))
  const auditPath = join(directory, "audit.jsonl")
  const calls: unknown[] = []
  const reviewer = createTypeSafeReviewer({
    systemOne: async (state) => {
      calls.push(state)
      return okResult()
    },
  })
  const selectedPlugin = createPlugin({ reviewer })
  const started = await start(
    {
      backend: "typesafe",
      typesafe: { apiKey: "configured-test-api-key" },
      audit: true,
      auditPath,
    },
    [],
    selectedPlugin,
  )
  const request = event({ action: "read", resources: ["src/a.ts"] })
  await evaluate(started, request)
  await started.cleanup?.()

  expect(request.effect).toBe("allow")
  expect(calls.length).toBe(1)
  expect(started.prompts).toEqual([])
  const record = JSON.parse((await readFile(auditPath, "utf8")).trim()) as AuditRecord
  expect(record.backend).toBe("typesafe")
  expect(record.promptVersion).toBe("1.0.0")
  expect(record.decision?.version).toBe(2)
  expect(record.answers).toBeDefined()
  expect(record.model).toBe("jev-1.13.0")
})

it("escalates without a provider call when the TypeSafe key is missing", async () => {
  const originalKey = process.env.TYPESAFE_API_KEY
  const originalWarn = console.warn
  const warnings: string[] = []
  delete process.env.TYPESAFE_API_KEY
  console.warn = (message: string) => warnings.push(message)
  try {
    const started = await start({
      backend: "typesafe",
      typesafe: {},
      audit: false,
    })
    const request = event({ action: "read", resources: ["src/a.ts"] })
    await evaluate(started, request)

    expect(request.effect).toBe("ask")
    expect(request.message).toContain("no TypeSafe review was performed")
    expect(started.prompts).toEqual([])
    expect(
      warnings.some((warning) =>
        warning.includes(
          "every reviewed request will be escalated until options.typesafe.apiKey is set",
        ),
      ),
    ).toBe(true)
  } finally {
    console.warn = originalWarn
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = originalKey
  }
})

it("does not expose the configured TypeSafe key in messages or audit fields", async () => {
  const key = "configured-test-api-key-value"
  const directory = await mkdtemp(join(tmpdir(), "permissions-classifier-secret-"))
  const auditPath = join(directory, "audit.jsonl")
  const selectedPlugin = createPlugin({
    reviewer: {
      backend: "typesafe",
      version: "1.0.0",
      review: async () => ({
        failure: {
          reason: `provider returned ${key}`,
          decisionSource: "model-error",
        },
        attempts: 1,
        model: `jev-${key}`,
        answers: { note: key },
        warnings: [`warning ${key}`],
      }),
    },
  })
  const started = await start(
    {
      backend: "typesafe",
      typesafe: { apiKey: key },
      audit: true,
      auditPath,
    },
    [],
    selectedPlugin,
  )
  const request = event({
    action: "read",
    resources: [`src/${key}.ts`],
  })
  await evaluate(started, request)
  await started.cleanup?.()

  expect(request.message).not.toContain(key)
  const text = await readFile(auditPath, "utf8")
  expect(text).not.toContain(key)
  const record = JSON.parse(text.trim()) as AuditRecord
  expect(record.backend).toBe("typesafe")
  expect(record.answers).toBeDefined()
})

it("applies a model deny with the reason", async () => {
  const started = await start(OPTIONS, [
    decision({ outcome: "deny", risk_level: "high", rationale: "pushes to the default branch" }),
  ])
  const request = event()
  await evaluate(started, request)
  expect(request.effect).toBe("deny")
  expect(request.message).toBe("[permissions-classifier] Denied: pushes to the default branch")
})

it("escalates back to the user by default", async () => {
  const started = await start(OPTIONS, [
    decision({ outcome: "escalate", risk_level: "medium", rationale: "the target is unclear" }),
  ])
  const request = event()
  await evaluate(started, request)
  expect(request.effect).toBe("ask")
  expect(request.message).toBe("[permissions-classifier] Needs human review: the target is unclear")
})

it("blocks instead of escalating when escalation is deny", async () => {
  const started = await start({ ...OPTIONS, escalation: "deny" }, [
    decision({ outcome: "escalate", risk_level: "medium", rationale: "the target is unclear" }),
  ])
  const request = event()
  await evaluate(started, request)
  expect(request.effect).toBe("deny")
  expect(request.message).toContain("Blocked (escalation=deny): the target is unclear")
})

it("uses the final applied effect in decision notices", async () => {
  const started = await start({ ...OPTIONS, escalation: "deny" }, [
    decision({ outcome: "escalate", risk_level: "medium", rationale: "the target is unclear" }),
  ])
  await evaluate(started, event({ action: "external_directory" }))
  await Promise.resolve()

  expect(started.synthetics[0]?.text).toBe("")
  expect(started.synthetics[0]?.description).toBe(
    "Permissions: blocked (escalation=deny) · external_directory",
  )
})

it("can hide decision notices", async () => {
  const started = await start({ ...OPTIONS, showDecisions: false }, [decision()])
  await evaluate(started, event())
  await Promise.resolve()
  expect(started.synthetics).toEqual([])
})

it("shows decision timing only when enabled", async () => {
  const started = await start({ ...OPTIONS, showDecisionTiming: true }, [decision()])
  await evaluate(started, event())
  await Promise.resolve()
  expect(started.synthetics[0]?.description).toMatch(
    /^Permissions: auto-approved · shell · \d+ ms$/,
  )
})

it("redacts secrets from the displayed action", async () => {
  const secret = "sk-abcdefghijklmnopqrstuvwx"
  const started = await start(OPTIONS, [decision()])
  await evaluate(started, event({ action: `server_${secret}` }))
  await Promise.resolve()

  expect(started.synthetics[0]?.description).not.toContain(secret)
  expect(started.synthetics[0]?.description).toContain("REDACTED:api-key")
})

it("escalates when the model call fails", async () => {
  const started = await start(OPTIONS)
  const request = event()
  await evaluate(started, request)
  expect(request.effect).toBe("ask")
  expect(request.message).toContain("provider unreachable")
})

it("escalates every request when no model is configured", async () => {
  const original = console.warn
  const warnings: string[] = []
  console.warn = (message: string) => warnings.push(message)
  try {
    const started = await start({ audit: false })
    const request = event()
    await evaluate(started, request)
    expect(request.effect).toBe("ask")
    expect(request.message).toContain("no model review was performed")
    expect(started.prompts).toEqual([])
    expect(warnings.some((warning) => warning.includes("options.model is missing"))).toBe(true)
    expect(warnings.some((warning) => warning.includes("will be escalated"))).toBe(true)
  } finally {
    console.warn = original
  }
})

it("never reviews an ignored action", async () => {
  const started = await start({ ...OPTIONS, ignoreActions: ["shell"] }, [decision()])
  const request = event()
  await evaluate(started, request)
  expect(request.effect).toBe("ask")
  expect(request.message).toBeUndefined()
  expect(started.prompts).toEqual([])
  expect(started.synthetics).toEqual([])
})

it("sends the correlated tool input to the model", async () => {
  const started = await start(OPTIONS, [decision()])
  await started.call("tool.execute.before", {
    id: "call-1",
    tool: "shell",
    input: { command: "git push origin main" },
    sessionID: "s1",
  })
  await started.call("shell.create.before", { command: "git push origin main", cwd: "/project" })
  await evaluate(started, event({ source: { type: "tool", messageID: "m1", id: "call-1" } }))
  expect(started.prompts[0]).toContain("TOOL: shell")
  expect(started.prompts[0]).toContain(`{"command":"git push origin main"}`)
  expect(started.prompts[0]).toContain("SHELL_CWD: /project")
})

it("reuses the first decision for an identical request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "permissions-classifier-"))
  const auditPath = join(directory, "audit.jsonl")
  const started = await start({ model: "local/reviewer", audit: true, auditPath }, [decision()])

  const first = event({ source: { type: "tool", messageID: "m1", id: "call-1" } })
  const second = event({ source: { type: "tool", messageID: "m1", id: "call-1" } })
  await evaluate(started, first)
  await evaluate(started, second)
  await Promise.resolve()
  await started.cleanup?.()

  expect(first.effect).toBe("allow")
  expect(second.effect).toBe("allow")
  expect(started.prompts.length).toBe(1)
  expect(started.synthetics.length).toBe(1)

  const lines = (await readFile(auditPath, "utf8")).trim().split("\n")
  const records = lines.map((line) => JSON.parse(line) as AuditRecord)
  expect(records.length).toBe(2)
  expect(records[0].decisionSource).toBe("model")
  expect(records[0].appliedEffect).toBe("allow")
  expect(records[0].model).toBe("local/reviewer")
  expect(records[0].backend).toBe("llm")
  expect(records[0].tool).toBeUndefined()
  expect(records[1].decisionSource).toBe("cache")
  expect(records[1].attempts).toBe(0)
})

it("disposes every registration on cleanup", async () => {
  const started = await start(OPTIONS)
  await started.cleanup?.()
  expect(started.disposed.sort()).toEqual([
    "permission.evaluate",
    "session.compaction",
    "session.context",
    "session.generate",
    "session.title",
    "shell.create.before",
    "tool.execute.before",
  ])
})

it("emits one notice for concurrent evaluations that share a review", async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let reviews = 0
  const selectedPlugin = createPlugin({
    reviewer: {
      backend: "llm",
      version: "test",
      review: async () => {
        reviews += 1
        await gate
        return {
          decision: JSON.parse(decision()),
          attempts: 1,
          model: "local/reviewer",
          warnings: [],
        }
      },
    },
  })
  const started = await start(OPTIONS, [], selectedPlugin)
  const source = { type: "tool", messageID: "m1", id: "call-1" } as const
  const first = event({ source })
  const second = event({ source })

  const evaluations = Promise.all([evaluate(started, first), evaluate(started, second)])
  await Promise.resolve()
  expect(reviews).toBe(1)
  release?.()
  await evaluations
  await Promise.resolve()

  expect(first.effect).toBe("allow")
  expect(second.effect).toBe("allow")
  expect(started.synthetics.length).toBe(1)
})

it("does not let a notice failure change the permission decision", async () => {
  const started = await start(OPTIONS, [decision()], plugin, {
    synthetic: async () => {
      throw new Error("notice unavailable")
    },
  })
  const request = event()
  await evaluate(started, request)
  await started.cleanup?.()

  expect(request.effect).toBe("allow")
  expect(started.synthetics.length).toBe(1)
})

it("does not wait for a hung notice and bounds cleanup", async () => {
  const selectedPlugin = createPlugin({ noticeTimeoutMs: 10 })
  const started = await start(OPTIONS, [decision()], selectedPlugin, {
    synthetic: () => new Promise(() => {}),
  })
  const request = event()
  const evaluateStarted = performance.now()
  await evaluate(started, request)
  const evaluateElapsed = performance.now() - evaluateStarted
  const cleanupStarted = performance.now()
  await started.cleanup?.()
  const cleanupElapsed = performance.now() - cleanupStarted

  expect(request.effect).toBe("allow")
  expect(evaluateElapsed).toBeLessThan(100)
  expect(cleanupElapsed).toBeLessThan(100)
})

it("filters only persisted classifier notices from every model-facing hook", async () => {
  const context = [
    {
      id: "msg_notice",
      type: "synthetic",
      metadata: CLASSIFIER_NOTICE_METADATA,
      text: "",
      description: "Permissions: denied · shell",
    },
    {
      id: "msg_other_synthetic",
      type: "synthetic",
      metadata: { anotherPlugin: true },
      text: "",
      description: "Permissions: denied · shell",
    },
  ]
  // This plugin instance did not emit the persisted notice. The raw session metadata
  // remains sufficient after a plugin reload.
  const started = await start(OPTIONS, [], plugin, { context })

  for (const hook of [
    "session.context",
    "session.compaction",
    "session.generate",
    "session.title",
  ]) {
    const request = {
      sessionID: "s1",
      messages: [
        { id: "msg_notice", role: "user", content: [{ type: "text", text: "" }] },
        { id: "msg_notice", role: "system", content: [] },
        { id: "msg_notice", role: "tool", content: [] },
        { id: "msg_other_synthetic", role: "system", content: [] },
        { id: "msg_user", role: "user", content: [] },
      ],
    }
    await started.call(hook, request)
    expect(request.messages.map((message) => [message.id, message.role])).toEqual([
      ["msg_notice", "system"],
      ["msg_notice", "tool"],
      ["msg_other_synthetic", "system"],
      ["msg_user", "user"],
    ])
  }
})

it("does not block a model request when persisted-notice lookup fails", async () => {
  const started = await start(OPTIONS, [], plugin, {
    context: async () => {
      throw new Error("context unavailable")
    },
  })
  const request = {
    sessionID: "s1",
    messages: [{ id: "msg_user", role: "user", content: [] }],
  }

  await started.call("session.context", request)
  expect(request.messages).toHaveLength(1)
})

it("reuses the first decision when the request carries the same tool call id", async () => {
  const started = await start(OPTIONS, [decision(), decision()])
  const source = { type: "tool", messageID: "m1", id: "call-1" } as const
  await evaluate(started, event({ action: "edit", resources: ["/project/a.ts"], source }))
  await evaluate(started, event({ action: "edit", resources: ["/project/a.ts"], source }))
  expect(started.prompts.length).toBe(1)
})

it("reviews every request that carries no tool call id", async () => {
  const started = await start(OPTIONS, [decision(), decision()])
  const first = event({ action: "edit", resources: ["/project/a.ts"], metadata: { files: { "/project/a.ts": "+ const a = 1" } } })
  const second = event({ action: "edit", resources: ["/project/a.ts"], metadata: { files: { "/project/a.ts": "+ process.exit(1)" } } })
  await evaluate(started, first)
  await evaluate(started, second)

  expect(started.prompts.length).toBe(2)
  expect(started.prompts[0]).toContain("const a = 1")
  expect(started.prompts[1]).toContain("process.exit(1)")
  expect(first.effect).toBe("allow")
  expect(second.effect).toBe("allow")
})

it("never records a cache decision for a request without a tool call id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "permissions-classifier-"))
  const auditPath = join(directory, "audit.jsonl")
  const started = await start({ model: "local/reviewer", audit: true, auditPath }, [decision(), decision()])
  await evaluate(started, event())
  await evaluate(started, event())
  await started.cleanup?.()

  const records = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as AuditRecord)
  expect(records.length).toBe(2)
  expect(records.every((record) => record.decisionSource === "model")).toBe(true)
})

it("bounds the decision cache", async () => {
  const started = await start(OPTIONS, Array.from({ length: 601 }, () => decision()))
  for (let index = 0; index < 600; index++) {
    await evaluate(
      started,
      event({ source: { type: "tool", messageID: "m1", id: `call-${index}` } }),
    )
  }
  // The first key was evicted, so it is reviewed again instead of being replayed.
  await evaluate(started, event({ source: { type: "tool", messageID: "m1", id: "call-0" } }))
  expect(started.prompts.length).toBe(601)
})

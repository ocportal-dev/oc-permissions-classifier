import { expect, it } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import plugin from "../src/index.js"
import type { AuditRecord, PermissionEvent } from "../src/types.js"

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

async function start(options: unknown, answers: string[] = []) {
  const hooks = new Map<string, Callback>()
  const prompts: string[] = []
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
      context: async () => {
        counts.context += 1
        return []
      },
    },
  } as unknown as Plugin.Context

  const cleanup = await plugin.setup(ctx)
  const call = async (name: string, input: unknown): Promise<void> => {
    const callback = hooks.get(name)
    if (!callback) throw new Error(`hook ${name} was not registered`)
    await callback(input as never)
  }
  return { hooks, prompts, disposed, counts, cleanup, call }
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
  expect(request.effect).toBe("allow")
  expect(request.message).toBeUndefined()
  expect(started.counts.context).toBe(1)
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
  await started.cleanup?.()

  expect(first.effect).toBe("allow")
  expect(second.effect).toBe("allow")
  expect(started.prompts.length).toBe(1)

  const lines = (await readFile(auditPath, "utf8")).trim().split("\n")
  const records = lines.map((line) => JSON.parse(line) as AuditRecord)
  expect(records.length).toBe(2)
  expect(records[0].decisionSource).toBe("model")
  expect(records[0].appliedEffect).toBe("allow")
  expect(records[0].model).toBe("local/reviewer")
  expect(records[0].tool).toBeUndefined()
  expect(records[1].decisionSource).toBe("cache")
  expect(records[1].attempts).toBe(0)
})

it("disposes every registration on cleanup", async () => {
  const started = await start(OPTIONS)
  await started.cleanup?.()
  expect(started.disposed.sort()).toEqual([
    "permission.evaluate",
    "shell.create.before",
    "tool.execute.before",
  ])
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

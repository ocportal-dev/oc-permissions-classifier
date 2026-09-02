import { expect, it } from "bun:test"
import { classify, type ClassifierDeps } from "../src/classifier.js"
import { DEFAULT_RISK_POLICY, type ClassifierConfig } from "../src/config.js"
import type { PermissionEvent } from "../src/types.js"

const BASE_CONFIG: ClassifierConfig = {
  model: { providerID: "local", id: "reviewer" },
  escalation: "ask",
  timeoutMs: 1000,
  confidenceThreshold: 0.7,
  intentMessages: 8,
  maxIntentChars: 8000,
  maxEvidenceChars: 24000,
  audit: false,
  auditPath: "/tmp/unused.jsonl",
  policy: undefined,
  riskPolicy: DEFAULT_RISK_POLICY,
  ignoreActions: [],
  debug: false,
}

const config = (overrides: Partial<ClassifierConfig> = {}): ClassifierConfig => ({
  ...BASE_CONFIG,
  ...overrides,
})

const event = (overrides: Partial<PermissionEvent> = {}): PermissionEvent => ({
  sessionID: "s1",
  action: "read",
  resources: ["src/a.ts"],
  effect: "ask",
  ...overrides,
})

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

interface Recorder {
  deps: ClassifierDeps
  prompts: string[]
}

function scripted(answers: (string | Error | Promise<string>)[], messages: readonly unknown[] = []): Recorder {
  const prompts: string[] = []
  return {
    prompts,
    deps: {
      generate: (prompt) => {
        prompts.push(prompt)
        const answer = answers.shift()
        if (answer instanceof Error) return Promise.reject(answer)
        if (answer === undefined) return Promise.reject(new Error("no scripted answer"))
        return Promise.resolve(answer)
      },
      transcript: async () => messages,
    },
  }
}

const run = (recorder: Recorder, overrides: Partial<ClassifierConfig> = {}, ev = event()) =>
  classify({ event: ev, config: config(overrides), projectDirectory: "/project" }, recorder.deps)

it("allows on a valid decision", async () => {
  const recorder = scripted([decision()])
  const result = await run(recorder)
  expect(result.outcome).toBe("allow")
  expect(result.decisionSource).toBe("model")
  expect(result.attempts).toBe(1)
  expect(result.decision?.risk_level).toBe("low")
  expect(result.warnings).toEqual([])
})

it("reads a decision wrapped in code fences", async () => {
  const result = await run(scripted([`\`\`\`json\n${decision()}\n\`\`\``]))
  expect(result.outcome).toBe("allow")
  expect(result.decisionSource).toBe("model")
})

it("retries once with the json only note", async () => {
  const recorder = scripted(["I think that is fine.", decision()])
  const result = await run(recorder)
  expect(result.outcome).toBe("allow")
  expect(result.decisionSource).toBe("model")
  expect(result.attempts).toBe(2)
  expect(recorder.prompts[0]).not.toContain("could not be parsed")
  expect(recorder.prompts[1]).toContain("could not be parsed")
})

it("escalates when both attempts are unparseable", async () => {
  const result = await run(scripted(["nope", "still nope"]))
  expect(result.outcome).toBe("escalate")
  expect(result.decisionSource).toBe("parse-failure")
  expect(result.attempts).toBe(2)
  expect(result.reason).toBe("classifier returned an unparseable decision after 2 attempts")
})

it("escalates when the model call fails", async () => {
  const result = await run(scripted([new Error("provider unreachable")]))
  expect(result.outcome).toBe("escalate")
  expect(result.decisionSource).toBe("model-error")
  expect(result.attempts).toBe(1)
  expect(result.reason).toContain("provider unreachable")
})

it("redacts a secret in a model error", async () => {
  const result = await run(scripted([new Error("bad request: token=abcdef1234567890")]))
  expect(result.reason).toContain("[REDACTED:assignment]")
  expect(result.reason).not.toContain("abcdef1234567890")
})

it("escalates when the model call times out", async () => {
  const recorder = scripted([new Promise<string>(() => {})])
  const result = await run(recorder, { timeoutMs: 20 })
  expect(result.outcome).toBe("escalate")
  expect(result.decisionSource).toBe("timeout")
  expect(result.reason).toBe("classifier model timed out after 20 ms")
})

it("does not leave a late rejection unhandled", async () => {
  const unhandled: unknown[] = []
  const listener = (reason: unknown): void => {
    unhandled.push(reason)
  }
  // bun-types narrows process.on, so the node event needs its own view of the emitter.
  const events = process as unknown as {
    on(event: "unhandledRejection", listener: (reason: unknown) => void): void
    off(event: "unhandledRejection", listener: (reason: unknown) => void): void
  }
  events.on("unhandledRejection", listener)

  let fail: (error: Error) => void = () => {}
  const late = new Promise<string>((_, reject) => {
    fail = reject
  })
  const result = await run(scripted([late]), { timeoutMs: 20 })
  expect(result.decisionSource).toBe("timeout")

  fail(new Error("late provider failure"))
  await new Promise((resolve) => setTimeout(resolve, 30))
  events.off("unhandledRejection", listener)
  expect(unhandled).toEqual([])
})

it("denies a braked request without calling the model", async () => {
  const recorder = scripted([decision()])
  const result = await run(recorder, {}, event({ action: "shell", resources: ["rm -rf /"] }))
  expect(result.outcome).toBe("deny")
  expect(result.decisionSource).toBe("brake")
  expect(result.attempts).toBe(0)
  expect(recorder.prompts).toEqual([])
})

it("escalates without calling the model when no model is configured", async () => {
  const recorder = scripted([decision()])
  const result = await run(recorder, { model: undefined })
  expect(result.outcome).toBe("escalate")
  expect(result.decisionSource).toBe("config-missing")
  expect(result.attempts).toBe(0)
  expect(recorder.prompts).toEqual([])
})

it("classifies with a warning when the transcript is unavailable", async () => {
  const deps: ClassifierDeps = {
    generate: async () => decision(),
    transcript: async () => {
      throw new Error("session gone")
    },
  }
  const result = await classify(
    { event: event(), config: config(), projectDirectory: "/project" },
    deps,
  )
  expect(result.outcome).toBe("allow")
  expect(result.warnings).toEqual(["transcript unavailable: session gone"])
})

it("passes the user intent to the model", async () => {
  const recorder = scripted([decision()], [{ type: "user", text: "read the source file" }])
  await run(recorder)
  expect(recorder.prompts[0]).toContain("read the source file")
})

it("escalates when the gate overrides a model allow", async () => {
  const result = await run(scripted([decision({ confidence: 0.2 })]))
  expect(result.outcome).toBe("escalate")
  expect(result.decisionSource).toBe("gate")
  expect(result.reason).toContain("below the threshold")
  expect(result.decision?.outcome).toBe("allow")
})

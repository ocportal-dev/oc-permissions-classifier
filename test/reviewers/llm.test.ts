import { expect, it } from "bun:test"
import { DEFAULT_HAZARD_THRESHOLDS, DEFAULT_RISK_POLICY, type ClassifierConfig } from "../../src/config.js"
import { extractIntent } from "../../src/evidence.js"
import { JSON_ONLY_RETRY_NOTE, PROMPT_VERSION } from "../../src/policy.js"
import { createLlmReviewer, withTimeout } from "../../src/reviewers/llm.js"
import type { ReviewInput } from "../../src/reviewer.js"
import type { PermissionEvent } from "../../src/types.js"

const BASE_CONFIG: ClassifierConfig = {
  backend: "llm",
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
  showDecisions: true,
  showDecisionTiming: false,
  typesafe: {
    apiKey: undefined,
    model: "jev-latest",
    baseURL: "https://api.typesafe.ai",
    timeoutMs: 15000,
    maxRetries: 2,
    thresholds: DEFAULT_HAZARD_THRESHOLDS,
  },
}

const event = (): PermissionEvent => ({ sessionID: "s1", action: "read", resources: ["src/a.ts"], effect: "ask" })

const input = (overrides: Partial<ClassifierConfig> = {}): ReviewInput => ({
  event: event(),
  intent: extractIntent([], { intentMessages: 8, maxIntentChars: 8000 }),
  config: { ...BASE_CONFIG, ...overrides },
  projectDirectory: "/project",
})

const decision = (): string =>
  JSON.stringify({
    version: 1,
    outcome: "allow",
    risk_level: "low",
    user_authorization: "high",
    scope_alignment: "aligned",
    evidence_completeness: "sufficient",
    rationale: "reads one project file",
    confidence: 0.9,
  })

function scripted(answers: (string | Error | Promise<string>)[]) {
  const prompts: string[] = []
  const reviewer = createLlmReviewer({
    generate: (prompt) => {
      prompts.push(prompt)
      const answer = answers.shift()
      if (answer instanceof Error) return Promise.reject(answer)
      if (answer === undefined) return Promise.reject(new Error("no scripted answer"))
      return Promise.resolve(answer)
    },
  })
  return { reviewer, prompts }
}

it("reports its backend and version", () => {
  const { reviewer } = scripted([])
  expect(reviewer.backend).toBe("llm")
  expect(reviewer.version).toBe(PROMPT_VERSION)
})

it("returns a decision and the model on a valid answer", async () => {
  const { reviewer } = scripted([decision()])
  const out = await reviewer.review(input())
  expect(out.decision?.outcome).toBe("allow")
  expect(out.failure).toBeUndefined()
  expect(out.model).toBe("local/reviewer")
  expect(out.attempts).toBe(1)
})

it("fails closed with config-missing when no model is configured", async () => {
  const { reviewer, prompts } = scripted([decision()])
  const out = await reviewer.review(input({ model: undefined }))
  expect(out.failure?.decisionSource).toBe("config-missing")
  expect(out.attempts).toBe(0)
  expect(prompts).toEqual([])
})

it("reports timeout when the call exceeds the budget", async () => {
  const { reviewer } = scripted([new Promise<string>(() => {})])
  const out = await reviewer.review(input({ timeoutMs: 20 }))
  expect(out.failure?.decisionSource).toBe("timeout")
  expect(out.failure?.reason).toBe("classifier model timed out after 20 ms")
})

it("reports model-error with a redacted reason", async () => {
  const { reviewer } = scripted([new Error("bad request: token=abcdef1234567890")])
  const out = await reviewer.review(input())
  expect(out.failure?.decisionSource).toBe("model-error")
  expect(out.failure?.reason).toContain("[REDACTED:assignment]")
  expect(out.failure?.reason).not.toContain("abcdef1234567890")
})

it("reports parse-failure after two unparseable answers", async () => {
  const { reviewer } = scripted(["nope", "still nope"])
  const out = await reviewer.review(input())
  expect(out.failure?.decisionSource).toBe("parse-failure")
  expect(out.attempts).toBe(2)
})

it("retries once with the json only note", async () => {
  const { reviewer, prompts } = scripted(["I think that is fine.", decision()])
  const out = await reviewer.review(input())
  expect(out.decision?.outcome).toBe("allow")
  expect(out.attempts).toBe(2)
  expect(prompts[0]).not.toContain(JSON_ONLY_RETRY_NOTE)
  expect(prompts[1]).toContain(JSON_ONLY_RETRY_NOTE)
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
  await expect(withTimeout(late, 20)).rejects.toThrow("timeout after 20 ms")

  fail(new Error("late provider failure"))
  await new Promise((resolve) => setTimeout(resolve, 30))
  events.off("unhandledRejection", listener)
  expect(unhandled).toEqual([])
})

import { expect, it } from "bun:test"
import { classify, type ClassifierDeps } from "../src/classifier.js"
import { DEFAULT_HAZARD_THRESHOLDS, DEFAULT_RISK_POLICY, type ClassifierConfig } from "../src/config.js"
import { PROMPT_VERSION } from "../src/policy.js"
import { createLlmReviewer } from "../src/reviewers/llm.js"
import { createTypeSafeReviewer } from "../src/reviewers/typesafe.js"
import { QUESTIONS_VERSION } from "../src/typesafe/questions.js"
import type { PermissionEvent } from "../src/types.js"
import { answers, choiceAnswer, okResult } from "./helpers/answers.js"

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
      reviewer: createLlmReviewer({
        generate: (prompt) => {
          prompts.push(prompt)
          const answer = answers.shift()
          if (answer instanceof Error) return Promise.reject(answer)
          if (answer === undefined) return Promise.reject(new Error("no scripted answer"))
          return Promise.resolve(answer)
        },
      }),
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
  expect(result.backend).toBe("llm")
  expect(result.promptVersion).toBe(PROMPT_VERSION)
  expect(result.model).toBe("local/reviewer")
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
    reviewer: createLlmReviewer({ generate: async () => decision() }),
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

it("redacts the configured TypeSafe key from transcript warnings", async () => {
  const key = "configured-test-api-key"
  const deps: ClassifierDeps = {
    reviewer: createTypeSafeReviewer({ systemOne: async () => okResult() }),
    transcript: async () => {
      throw new Error(`session failed with ${key}`)
    },
  }
  const result = await classify(
    {
      event: event(),
      config: config({
        backend: "typesafe",
        typesafe: { ...BASE_CONFIG.typesafe, apiKey: key },
      }),
      projectDirectory: "/project",
    },
    deps,
  )
  expect(result.warnings[0]).not.toContain(key)
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

it("classifies with the TypeSafe reviewer and preserves its backend fields", async () => {
  const deps: ClassifierDeps = {
    reviewer: createTypeSafeReviewer({ systemOne: async () => okResult() }),
    transcript: async () => [],
  }
  const result = await classify(
    {
      event: event(),
      config: config({
        backend: "typesafe",
        model: undefined,
        typesafe: { ...BASE_CONFIG.typesafe, apiKey: "configured-test-api-key" },
      }),
      projectDirectory: "/project",
    },
    deps,
  )

  expect(result.outcome).toBe("allow")
  expect(result.decisionSource).toBe("model")
  expect(result.backend).toBe("typesafe")
  expect(result.promptVersion).toBe(QUESTIONS_VERSION)
  expect(result.model).toBe("jev-1.13.0")
  expect(result.decision?.version).toBe(2)
  expect(result.answers).toBeDefined()
})

it("applies the shared confidence gate to a TypeSafe allow", async () => {
  const lowConfidence = {
    ...okResult(),
    answers: answers({
      outcome: choiceAnswer("allow", ["allow", "deny", "escalate"], 0.2),
    }),
  }
  const deps: ClassifierDeps = {
    reviewer: createTypeSafeReviewer({ systemOne: async () => lowConfidence }),
    transcript: async () => [],
  }
  const result = await classify(
    {
      event: event(),
      config: config({
        backend: "typesafe",
        model: undefined,
        typesafe: { ...BASE_CONFIG.typesafe, apiKey: "configured-test-api-key" },
      }),
      projectDirectory: "/project",
    },
    deps,
  )

  expect(result.outcome).toBe("escalate")
  expect(result.decisionSource).toBe("gate")
  expect(result.decision?.outcome).toBe("allow")
})

it("fails closed when a reviewer throws and redacts the configured key", async () => {
  const key = "configured-test-api-key"
  const deps: ClassifierDeps = {
    reviewer: {
      backend: "typesafe",
      version: QUESTIONS_VERSION,
      review: async () => {
        throw new Error(`provider exposed ${key}`)
      },
    },
    transcript: async () => [],
  }
  const result = await classify(
    {
      event: event(),
      config: config({
        backend: "typesafe",
        typesafe: { ...BASE_CONFIG.typesafe, apiKey: key },
      }),
      projectDirectory: "/project",
    },
    deps,
  )

  expect(result.outcome).toBe("escalate")
  expect(result.decisionSource).toBe("model-error")
  expect(result.reason).not.toContain(key)
})

it("fails closed when a reviewer returns both a decision and a failure", async () => {
  const deps: ClassifierDeps = {
    reviewer: {
      backend: "typesafe",
      version: QUESTIONS_VERSION,
      review: async () => ({
        decision: {
          version: 2,
          outcome: "allow",
          risk_level: "low",
          user_authorization: "high",
          scope_alignment: "aligned",
          evidence_completeness: "sufficient",
          rationale: "allow",
          confidence: 1,
        },
        failure: { reason: "ambiguous reviewer result", decisionSource: "parse-failure" },
        attempts: 1,
        warnings: [],
      }),
    },
    transcript: async () => [],
  }
  const result = await classify(
    { event: event(), config: config(), projectDirectory: "/project" },
    deps,
  )

  expect(result.outcome).toBe("escalate")
  expect(result.decisionSource).toBe("parse-failure")
})

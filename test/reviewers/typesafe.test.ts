import { describe, expect, it } from "bun:test"
import {
  DEFAULT_HAZARD_THRESHOLDS,
  DEFAULT_RISK_POLICY,
  type ClassifierConfig,
} from "../../src/config.js"
import { extractIntent } from "../../src/evidence.js"
import { createTypeSafeReviewer } from "../../src/reviewers/typesafe.js"
import type { SystemOne } from "../../src/typesafe/client.js"
import { QUESTIONS_VERSION } from "../../src/typesafe/questions.js"
import type { PermissionEvent } from "../../src/types.js"
import { okResult } from "../helpers/answers.js"

const config = (overrides: Partial<ClassifierConfig["typesafe"]> = {}): ClassifierConfig => ({
  backend: "typesafe",
  model: undefined,
  escalation: "ask",
  timeoutMs: 60000,
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
    apiKey: "configured-key-value",
    model: "jev-latest",
    baseURL: "https://api.typesafe.ai",
    timeoutMs: 20,
    maxRetries: 0,
    thresholds: DEFAULT_HAZARD_THRESHOLDS,
    ...overrides,
  },
})
const event = (): PermissionEvent => ({
  sessionID: "s1",
  action: "read",
  resources: ["src/a.ts"],
  effect: "ask",
})
const input = (cfg = config(), ev = event()) => ({
  event: ev,
  intent: extractIntent([], { intentMessages: 8, maxIntentChars: 8000 }),
  config: cfg,
  projectDirectory: "/project",
})

function scripted(
  script: (state: unknown, model: string, signal: AbortSignal) => Promise<unknown>,
) {
  const calls: { state: unknown; model: string; signal: AbortSignal }[] = []
  const systemOne: SystemOne = (state, model, signal) => {
    calls.push({ state, model, signal })
    return script(state, model, signal) as never
  }
  return { reviewer: createTypeSafeReviewer({ systemOne }), calls }
}

describe("typesafe reviewer", () => {
  it("reports its backend and version", () => {
    const { reviewer } = scripted(async () => okResult())
    expect(reviewer.backend).toBe("typesafe")
    expect(reviewer.version).toBe(QUESTIONS_VERSION)
  })

  it("returns a decision, the model, and the raw answers", async () => {
    const { reviewer, calls } = scripted(async () => okResult())
    const out = await reviewer.review(input())
    expect(out.decision?.outcome).toBe("allow")
    expect(out.decision?.version).toBe(2)
    expect(out.model).toBe("jev-1.13.0")
    expect(out.answers).toBeDefined()
    expect(out.attempts).toBe(1)
    expect(calls[0].model).toBe("jev-latest")
    expect((calls[0].state as { action: string }).action).toBe("read")
  })

  it("fails closed with config-missing when the key is absent", async () => {
    const { reviewer, calls } = scripted(async () => okResult())
    const out = await reviewer.review(input(config({ apiKey: undefined })))
    expect(out.failure?.decisionSource).toBe("config-missing")
    expect(out.attempts).toBe(0)
    expect(calls).toEqual([])
  })

  it("aborts the call and reports timeout when the budget passes", async () => {
    const { reviewer, calls } = scripted(
      (_state, _model, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          ),
        ),
    )
    const out = await reviewer.review(input())
    expect(out.failure?.decisionSource).toBe("timeout")
    expect(out.failure?.reason).toBe("TypeSafe review timed out after 20 ms")
    expect(calls[0].signal.aborted).toBe(true)
  })

  it("enforces the deadline when System One ignores the abort signal", async () => {
    const { reviewer, calls } = scripted(async () => await new Promise(() => {}))
    const started = Date.now()
    const out = await reviewer.review(input())
    expect(Date.now() - started).toBeLessThan(200)
    expect(out.failure?.decisionSource).toBe("timeout")
    expect(calls[0].signal.aborted).toBe(true)
  })

  it("uses one timeout budget per configured SDK attempt", async () => {
    const { reviewer } = scripted(async () => await new Promise(() => {}))
    const out = await reviewer.review(
      input(config({ timeoutMs: 20, maxRetries: 1 })),
    )
    expect(out.failure?.decisionSource).toBe("timeout")
    expect(out.failure?.reason).toBe("TypeSafe review timed out after 40 ms")
  })

  it("classifies SDK timeout and user-abort errors as timeouts", async () => {
    for (const name of ["APITimeoutError", "APIUserAbortError"]) {
      const { reviewer } = scripted(async () => {
        const error = new Error(name)
        error.name = name
        throw error
      })
      expect((await reviewer.review(input())).failure?.decisionSource).toBe(
        "timeout",
      )
    }
  })

  it("does not leave a late System One rejection unhandled", async () => {
    const unhandled: unknown[] = []
    const listener = (reason: unknown): void => {
      unhandled.push(reason)
    }
    const events = process as unknown as {
      on(event: "unhandledRejection", listener: (reason: unknown) => void): void
      off(event: "unhandledRejection", listener: (reason: unknown) => void): void
    }
    events.on("unhandledRejection", listener)

    let rejectLate: (error: Error) => void = () => {}
    const { reviewer } = scripted(
      () =>
        new Promise((_, reject) => {
          rejectLate = reject
        }),
    )
    const out = await reviewer.review(input())
    expect(out.failure?.decisionSource).toBe("timeout")

    rejectLate(new Error("late failure"))
    await new Promise((resolve) => setTimeout(resolve, 30))
    events.off("unhandledRejection", listener)
    expect(unhandled).toEqual([])
  })

  it("reports model-error with a redacted, capped reason", async () => {
    const { reviewer } = scripted(async () => {
      throw new Error(
        `401 configured-key-value token=abcdefghijklmnop ${"x".repeat(500)}`,
      )
    })
    const out = await reviewer.review(input())
    expect(out.failure?.decisionSource).toBe("model-error")
    expect(out.failure?.reason).not.toContain("configured-key-value")
    expect(out.failure?.reason).not.toContain("abcdefghijklmnop")
    expect(out.failure?.reason).toContain("[REDACTED:api-key]")
    expect(out.failure?.reason.length).toBeLessThanOrEqual(340)
  })

  it("reports parse-failure on a malformed answer map", async () => {
    const { reviewer } = scripted(async () => ({
      model: "x",
      answers: { risk_level: { type: "noul", noul: 0.1 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }))
    expect((await reviewer.review(input())).failure?.decisionSource).toBe(
      "parse-failure",
    )
  })

  it("reports parse-failure for a malformed result without retaining answers", async () => {
    for (const malformed of [
      null,
      { model: "", answers: okResult().answers },
      { answers: okResult().answers },
    ]) {
      const { reviewer } = scripted(async () => malformed)
      const out = await reviewer.review(input())
      expect(out.failure?.decisionSource).toBe("parse-failure")
      expect(out.answers).toBeUndefined()
    }
  })

  it("fails closed before the API when the required state cannot fit", async () => {
    const { reviewer, calls } = scripted(async () => okResult())
    const out = await reviewer.review(
      input(
        { ...config(), maxEvidenceChars: 0, maxIntentChars: 0 },
        {
          ...event(),
          resources: ["x".repeat(3000)],
        },
      ),
    )
    expect(out.failure?.decisionSource).toBe("model-error")
    expect(out.attempts).toBe(0)
    expect(calls).toEqual([])
  })

  it("removes the configured key from state, model, and raw answers", async () => {
    const key = "key\"line\nvalue-123456"
    const result = okResult() as ReturnType<typeof okResult> & {
      answers: ReturnType<typeof okResult>["answers"] & { note?: string }
    }
    result.model = `jev-${key}`
    result.answers.note = `returned ${key}`
    const { reviewer, calls } = scripted(async () => result)
    const out = await reviewer.review(
      input({
        ...config({ apiKey: key }),
        policy: `policy contains ${key}`,
      }),
    )

    expect(JSON.stringify(calls[0].state)).not.toContain(key)
    expect(out.model).not.toContain(key)
    expect(JSON.stringify(out.answers)).not.toContain(key)
  })

  it("uses options.policy as the policy notes", async () => {
    const { reviewer, calls } = scripted(async () => okResult())
    await reviewer.review(input({ ...config(), policy: "custom notes" }))
    expect((calls[0].state as { policy_notes: string }).policy_notes).toBe(
      "custom notes",
    )
  })
})

import type { Answers } from "../../src/typesafe/answers.js"
import { QUESTIONS } from "../../src/typesafe/questions.js"

export const choiceAnswer = <T extends string>(pick: T, keys: readonly T[], p = 0.9) => ({
  type: "choice" as const,
  choice: pick,
  confidence: p,
  probabilities: Object.fromEntries(
    keys.map((key) => [key, key === pick ? p : (1 - p) / (keys.length - 1)]),
  ) as Record<T, number>,
})

export const noulAnswer = (p: number) => ({ type: "noul" as const, noul: p })

export const scoreAnswer = (score: number, confidence = 0.9): Answers["remote_opacity"] => {
  const [zero, one, two] = QUESTIONS.remote_opacity.criteria
  return {
    type: "score",
    score,
    confidence,
    legend: { "0": zero, "1": one, "2": two },
    probabilities: {
      "0": Math.max(0, 1 - score / 2),
      "1": 0,
      "2": Math.min(1, score / 2),
    },
  }
}

export const answers = (overrides: Partial<Answers> = {}): Answers => ({
  risk_level: choiceAnswer("low", ["low", "medium", "high", "critical"]),
  user_authorization: choiceAnswer("high", ["high", "medium", "low", "unknown"]),
  scope_alignment: choiceAnswer("aligned", ["aligned", "partial", "misaligned", "unknown"]),
  evidence_completeness: choiceAnswer(
    "sufficient",
    ["sufficient", "partial", "insufficient", "unknown"],
  ),
  outcome: choiceAnswer("allow", ["allow", "deny", "escalate"]),
  steering_attempt: noulAnswer(0.01),
  secret_disclosure: noulAnswer(0.01),
  destructive: noulAnswer(0.01),
  weakens_security: noulAnswer(0.01),
  outside_workspace: noulAnswer(0.01),
  remote_opacity: scoreAnswer(0),
  ...overrides,
} as Answers)

export const okResult = (overrides: Partial<Answers> = {}) => ({
  model: "jev-1.13.0",
  answers: answers(overrides),
  usage: { input_tokens: 1, output_tokens: 1 },
})

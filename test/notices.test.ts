import { expect, it } from "bun:test"
import {
  CLASSIFIER_NOTICE_METADATA,
  classifierNoticeIDs,
  createNoticeDelivery,
  decisionNoticeText,
} from "../src/notices.js"

it("formats each applied decision without exposing evidence", () => {
  expect(
    decisionNoticeText({
      action: "shell",
      durationMs: 144,
      effect: "allow",
      outcome: "allow",
      showTiming: false,
    }),
  ).toBe("Permissions: auto-approved · shell")
  expect(
    decisionNoticeText({
      action: "shell",
      durationMs: 144,
      effect: "deny",
      outcome: "deny",
      showTiming: true,
    }),
  ).toBe("Permissions: denied · shell · 144 ms")
  expect(
    decisionNoticeText({
      action: "shell",
      durationMs: 144,
      effect: "ask",
      outcome: "escalate",
      showTiming: false,
    }),
  ).toBe("Permissions: needs your approval · shell")
  expect(
    decisionNoticeText({
      action: "shell",
      durationMs: 144,
      effect: "deny",
      outcome: "escalate",
      showTiming: false,
    }),
  ).toBe("Permissions: blocked (escalation=deny) · shell")
})

it("sanitizes the action in decision notices", () => {
  const secret = "abcdefghijkl"
  expect(
    decisionNoticeText({
      action: `shell\nsecret=${secret}`,
      durationMs: 1,
      effect: "allow",
      outcome: "allow",
      showTiming: false,
    }),
  ).toBe("Permissions: auto-approved · shell_secret_REDACTED:assignment")
})

it("finds only persisted classifier synthetic notice ids", () => {
  const messages = [
    {
      id: "msg_classifier",
      type: "synthetic",
      metadata: CLASSIFIER_NOTICE_METADATA,
      text: "Permissions: denied · shell",
    },
    {
      id: "msg_unrelated",
      type: "synthetic",
      metadata: { anotherPlugin: true },
      text: "Permissions: denied · shell",
    },
    {
      id: "msg_wrong_type",
      type: "user",
      metadata: CLASSIFIER_NOTICE_METADATA,
      text: "ordinary user text",
    },
  ]

  expect(classifierNoticeIDs(messages)).toEqual(new Set(["msg_classifier"]))
})

it("swallows delivery and error-reporter failures", async () => {
  const delivery = createNoticeDelivery({
    enabled: true,
    showTiming: false,
    timeoutMs: 10,
    send: async () => {
      throw new Error("delivery failed")
    },
    onError: () => {
      throw new Error("reporting failed")
    },
  })

  delivery.publish({
    sessionID: "s1",
    action: "shell",
    durationMs: 1,
    effect: "allow",
    outcome: "allow",
  })
  await expect(delivery.flush()).resolves.toBeUndefined()
})

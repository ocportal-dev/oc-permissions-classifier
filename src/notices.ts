import { redactSecrets } from "./redact.js"
import type { ClassifierResult, Effect } from "./types.js"

const NOTICE_MARKER_KEY = "opencodePermissionsClassifier"
const NOTICE_MARKER_VALUE = "decision-notice-v1"
const ACTION_LIMIT = 80

export const CLASSIFIER_NOTICE_METADATA = {
  [NOTICE_MARKER_KEY]: NOTICE_MARKER_VALUE,
} as const

export interface DecisionNotice {
  action: string
  durationMs: number
  effect: Effect
  outcome: ClassifierResult["outcome"]
  showTiming: boolean
}

export function decisionNoticeText(notice: DecisionNotice): string {
  const status =
    notice.outcome === "allow"
      ? "auto-approved"
      : notice.outcome === "deny"
        ? "denied"
        : notice.effect === "ask"
          ? "needs your approval"
          : "blocked (escalation=deny)"
  const action =
    redactSecrets(notice.action.replaceAll("_", " "))
      .replace(/[^A-Za-z0-9_.:-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, ACTION_LIMIT) || "unknown"
  const timing = notice.showTiming ? ` · ${Math.max(0, Math.round(notice.durationMs))} ms` : ""
  return `Permissions: ${status} · ${action}${timing}`
}

export function classifierNoticeIDs(messages: readonly unknown[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    const item = message as { id?: unknown; type?: unknown; metadata?: unknown }
    if (item.type !== "synthetic" || typeof item.id !== "string") continue
    if (!item.metadata || typeof item.metadata !== "object") continue
    const metadata = item.metadata as Record<string, unknown>
    if (metadata[NOTICE_MARKER_KEY] === NOTICE_MARKER_VALUE) ids.add(item.id)
  }
  return ids
}

export interface NoticeDelivery {
  publish(input: {
    sessionID: string
    action: string
    durationMs: number
    effect: Effect
    outcome: ClassifierResult["outcome"]
  }): void
  flush(): Promise<void>
}

export function createNoticeDelivery(input: {
  enabled: boolean
  showTiming: boolean
  timeoutMs: number
  send: (notice: {
    sessionID: string
    text: string
    description: string
    metadata: typeof CLASSIFIER_NOTICE_METADATA
    resume: false
  }) => Promise<unknown>
  onError?: () => void
}): NoticeDelivery {
  const pending = new Set<Promise<void>>()

  const publish: NoticeDelivery["publish"] = (notice) => {
    if (!input.enabled) return
    const text = decisionNoticeText({ ...notice, showTiming: input.showTiming })
    const delivery = Promise.resolve().then(() =>
      input.send({
        sessionID: notice.sessionID,
        // Compaction retains recent synthetic text in serialized input before plugin
        // hooks can filter message ids. Keep model-facing text empty.
        text: "",
        description: text,
        metadata: CLASSIFIER_NOTICE_METADATA,
        resume: false,
      }),
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const bounded = Promise.race([
      delivery.then(
        () => undefined,
        () => {
          try {
            input.onError?.()
          } catch {
            // Notice reporting must not produce an unhandled rejection.
          }
        },
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, input.timeoutMs)
        timer.unref?.()
      }),
    ]).finally(() => clearTimeout(timer))
    pending.add(bounded)
    void bounded.then(() => pending.delete(bounded))
  }

  return {
    publish,
    flush: async () => {
      await Promise.allSettled([...pending])
    },
  }
}

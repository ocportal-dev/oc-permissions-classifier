import { homedir } from "node:os"
import { Plugin } from "@opencode/plugin"
import { createAuditWriter } from "./audit.js"
import { classify, type ClassifierDeps } from "./classifier.js"
import { resolveConfig } from "./config.js"
import { createCorrelationStore } from "./correlation.js"
import { classifierNoticeIDs, createNoticeDelivery } from "./notices.js"
import { capText, redactSecrets } from "./redact.js"
import type { Reviewer } from "./reviewer.js"
import { createLlmReviewer } from "./reviewers/llm.js"
import { createTypeSafeReviewer } from "./reviewers/typesafe.js"
import { createSystemOne } from "./typesafe/client.js"
import type {
  ClassifierResult,
  CorrelatedCall,
  DecisionSource,
  Effect,
  PermissionEvent,
} from "./types.js"

const CACHE_TTL_MS = 600000
const CACHE_MAX = 512
const MESSAGE_LIMIT = 500
const NOTICE_TIMEOUT_MS = 1000
const PREFIX = "[permissions-classifier]"

/** What the hook applies to the event, plus what the audit log records about it. */
interface Verdict {
  effect: Effect
  message?: string
  outcome: ClassifierResult["outcome"]
  reason: string
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export interface PluginOverrides {
  /** Replaces the reviewer built from the options. Used by the tests. */
  reviewer?: Reviewer
  /** Bounds synthetic notice delivery and cleanup. Used by the tests. */
  noticeTimeoutMs?: number
}

export const createPlugin = (overrides?: PluginOverrides) => Plugin.define({
  id: "opencode-permissions-classifier",
  setup: async (ctx) => {
    const projectDirectory = ctx.location.directory
    const { config, warnings } = resolveConfig(ctx.options, {
      projectDirectory,
      xdgDataHome: process.env.XDG_DATA_HOME,
      home: homedir(),
      typesafeApiKey: process.env.TYPESAFE_API_KEY,
    })
    for (const warning of warnings) console.warn(`${PREFIX} ${warning}`)
    if (config.backend === "llm" && !config.model) {
      console.warn(`${PREFIX} every reviewed request will be escalated until a model is set`)
    }
    if (config.backend === "typesafe" && !config.typesafe.apiKey) {
      console.warn(
        `${PREFIX} every reviewed request will be escalated until options.typesafe.apiKey is set`,
      )
    }

    const reviewer =
      overrides?.reviewer ??
      (config.backend === "typesafe"
        ? createTypeSafeReviewer({
            systemOne: config.typesafe.apiKey
              ? createSystemOne({
                  apiKey: config.typesafe.apiKey,
                  baseURL: config.typesafe.baseURL,
                  timeoutMs: config.typesafe.timeoutMs,
                  maxRetries: config.typesafe.maxRetries,
                })
              : async () => {
                  throw new Error("no api key")
                },
          })
        : createLlmReviewer({
            generate: async (prompt) =>
              (await ctx.generate.text({ prompt, model: config.model })).text,
          }))

    const audit = createAuditWriter(config.audit ? config.auditPath : undefined)
    const correlation = createCorrelationStore()
    const notices = createNoticeDelivery({
      enabled: config.showDecisions,
      showTiming: config.showDecisionTiming,
      timeoutMs: overrides?.noticeTimeoutMs ?? NOTICE_TIMEOUT_MS,
      send: (notice) => ctx.session.synthetic(notice),
      onError: config.debug
        ? () => console.warn(`${PREFIX} could not add the decision notice`)
        : undefined,
    })
    const hideConfiguredKey = (text: string): string =>
      config.typesafe.apiKey
        ? text.split(config.typesafe.apiKey).join("[REDACTED:api-key]")
        : text
    const sanitizeConfiguredKey = <T>(value: T): T => {
      if (!config.typesafe.apiKey) return value
      const serialized = JSON.stringify(value, (_key, item) =>
        typeof item === "string"
          ? item.split(config.typesafe.apiKey!).join("[REDACTED:api-key]")
          : item,
      )
      if (serialized === undefined) return value
      return JSON.parse(serialized) as T
    }
    // The host re-evaluates pending requests after an `always` reply, so an identical
    // request must reuse the first decision instead of paying for a second review. The
    // key needs the tool call id to be unique, so a request without one is never cached.
    const cache = new Map<string, { promise: Promise<Verdict>; at: number }>()

    const deps: ClassifierDeps = {
      reviewer,
      transcript: (sessionID) => ctx.session.context({ sessionID }),
    }

    const toVerdict = (result: ClassifierResult): Verdict => {
      const safeReason = hideConfiguredKey(result.reason)
      const reason = capText(redactSecrets(safeReason), MESSAGE_LIMIT)
      if (result.outcome === "allow") return { effect: "allow", outcome: "allow", reason: safeReason }
      if (result.outcome === "deny") {
        return { effect: "deny", message: `${PREFIX} Denied: ${reason}`, outcome: "deny", reason: safeReason }
      }
      return config.escalation === "ask"
        ? { effect: "ask", message: `${PREFIX} Needs human review: ${reason}`, outcome: "escalate", reason: safeReason }
        : {
            effect: "deny",
            message: `${PREFIX} Blocked (escalation=deny): ${reason}`,
            outcome: "escalate",
            reason: safeReason,
          }
    }

    const writeAudit = (
      event: PermissionEvent,
      verdict: Verdict,
      entry: {
        decisionSource: DecisionSource
        attempts: number
        durationMs: number
        warnings: string[]
        result?: ClassifierResult
        tool?: string
      },
    ): void => {
      void audit.write(sanitizeConfiguredKey({
        schemaVersion: 1,
        backend: reviewer.backend,
        promptVersion: reviewer.version,
        timestamp: new Date().toISOString(),
        durationMs: entry.durationMs,
        sessionID: event.sessionID,
        agent: event.agent,
        action: event.action,
        resources: event.resources,
        source: event.source,
        tool: entry.tool,
        inputEffect: "ask",
        outcome: verdict.outcome,
        appliedEffect: verdict.effect,
        escalation: config.escalation,
        decisionSource: entry.decisionSource,
        reason: verdict.reason,
        decision: entry.result?.decision,
        model: entry.result?.model,
        answers: entry.result?.answers,
        attempts: entry.attempts,
        warnings: entry.warnings,
      }))
      if (config.debug) {
        console.log(
          `${PREFIX} ${event.action} → ${verdict.effect} (${entry.decisionSource}, ${entry.durationMs}ms)`,
        )
      }
    }

    /** Never rejects: a rejected hook promise would fail the tool call. */
    const decide = async (event: PermissionEvent): Promise<Verdict> => {
      const started = Date.now()
      let correlated: CorrelatedCall | undefined
      let result: ClassifierResult
      try {
        correlated = correlation.take(event.source?.id)
        result = await classify({ event, correlated, config, projectDirectory }, deps)
      } catch (error) {
        result = {
          outcome: "escalate",
          reason: `classifier error: ${redactSecrets(hideConfiguredKey(describe(error)))}`,
          decisionSource: "error",
          backend: reviewer.backend,
          promptVersion: reviewer.version,
          attempts: 0,
          warnings: [],
        }
      }
      const verdict = toVerdict(result)
      const durationMs = Date.now() - started
      writeAudit(event, verdict, {
        decisionSource: result.decisionSource,
        attempts: result.attempts,
        durationMs,
        warnings: result.warnings,
        result,
        tool: correlated?.tool,
      })
      notices.publish({
        sessionID: event.sessionID,
        action: redactSecrets(hideConfiguredKey(event.action)),
        durationMs,
        effect: verdict.effect,
        outcome: verdict.outcome,
      })
      return verdict
    }

    const apply = (event: PermissionEvent, verdict: Verdict): void => {
      event.effect = verdict.effect
      if (verdict.message !== undefined) event.message = verdict.message
    }

    const handler = async (event: PermissionEvent): Promise<void> => {
      if (event.effect !== "ask") return
      if (config.ignoreActions.includes(event.action)) return

      // Without a call id two different requests can share a key: the same path with a
      // different diff, for example. Reviewing them again is cheaper than replaying an
      // allow that was never granted for this request.
      const sourceID = event.source?.id
      if (sourceID === undefined) {
        apply(event, await decide(event))
        return
      }

      const started = Date.now()
      const key = `${event.sessionID}|${sourceID}|${event.action}|${JSON.stringify(event.resources)}`
      const cached = cache.get(key)
      if (cached) {
        const verdict = await cached.promise
        apply(event, verdict)
        writeAudit(event, verdict, {
          decisionSource: "cache",
          attempts: 0,
          durationMs: Date.now() - started,
          warnings: [],
        })
        return
      }

      for (const [id, entry] of cache) if (started - entry.at > CACHE_TTL_MS) cache.delete(id)
      const promise = decide(event)
      // Stored before the await, so concurrent identical evaluations share one review.
      cache.set(key, { promise, at: started })
      // Map iteration follows insertion order, so the first key is the oldest entry.
      while (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next()
        if (oldest.done) break
        cache.delete(oldest.value)
      }
      apply(event, await promise)
    }

    const filterDecisionNotices = async (event: {
      readonly sessionID: string
      messages: Array<{ id?: string; role: string }>
    }): Promise<void> => {
      let context: Awaited<ReturnType<typeof ctx.session.context>>
      try {
        context = await ctx.session.context({ sessionID: event.sessionID })
      } catch {
        if (config.debug) console.warn(`${PREFIX} could not inspect decision notices`)
        return
      }
      const ids = classifierNoticeIDs(context)
      if (ids.size === 0) return
      event.messages = event.messages.filter(
        (message) => message.role !== "user" || message.id === undefined || !ids.has(message.id),
      )
    }

    const registrations = await Promise.all([
      ctx.tool.hook("execute.before", (event) => {
        correlation.set(event.id, { tool: event.tool, input: event.input, sessionID: event.sessionID })
      }),
      ctx.shell.hook("create.before", (event) => {
        correlation.attachShell(undefined, { command: event.command, cwd: event.cwd })
      }),
      ctx.permission.hook("evaluate", handler),
      ctx.session.hook("context", filterDecisionNotices),
      ctx.session.hook("compaction", filterDecisionNotices),
      ctx.session.hook("generate", filterDecisionNotices),
      ctx.session.hook("title", filterDecisionNotices),
    ])

    return async () => {
      await Promise.all(registrations.map((registration) => registration.dispose()))
      await notices.flush()
      await audit.flush()
    }
  },
})

export default createPlugin()

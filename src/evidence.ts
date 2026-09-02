import { homedir } from "node:os"
import { join, resolve, sep } from "node:path"
import { capText, redactSecrets, redactValue } from "./redact.js"
import type { CorrelatedCall, PermissionEvent } from "./types.js"

const MAX_MESSAGE_CHARS = 2000

export interface IntentLimits {
  intentMessages: number
  maxIntentChars: number
}

export interface Intent {
  latest?: string
  history: string[]
  purpose?: string
  status: string
}

function userText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined
  const record = message as { type?: unknown; text?: unknown }
  if (record.type !== "user" || typeof record.text !== "string") return undefined
  const text = record.text.trim()
  return text === "" ? undefined : text
}

function assistantText(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined
  const record = message as { type?: unknown; content?: unknown }
  if (record.type !== "assistant" || !Array.isArray(record.content)) return undefined
  const parts: string[] = []
  for (const part of record.content) {
    if (typeof part !== "object" || part === null) continue
    const entry = part as { type?: unknown; text?: unknown }
    if (entry.type === "text" && typeof entry.text === "string" && entry.text.trim() !== "") {
      parts.push(entry.text)
    }
  }
  const joined = parts.join("\n").trim()
  return joined === "" ? undefined : joined
}

export function extractIntent(messages: readonly unknown[], limits: IntentLimits): Intent {
  const userIndexes: number[] = []
  const userTexts: string[] = []
  messages.forEach((message, index) => {
    const text = userText(message)
    if (text !== undefined) {
      userIndexes.push(index)
      userTexts.push(text)
    }
  })
  if (userTexts.length === 0) return { history: [], status: "unavailable" }

  const count = Math.max(1, Math.floor(limits.intentMessages))
  const selected = userTexts.slice(-count)
  const latestRaw = selected[selected.length - 1]
  const historyRaw = selected.slice(0, -1)

  const lastUserIndex = userIndexes[userIndexes.length - 1]
  let purposeRaw: string | undefined
  for (let index = messages.length - 1; index > lastUserIndex; index--) {
    const text = assistantText(messages[index])
    if (text !== undefined) {
      purposeRaw = text
      break
    }
  }

  const perMessage = Math.min(MAX_MESSAGE_CHARS, limits.maxIntentChars)
  let remaining = limits.maxIntentChars
  const take = (text: string): string | undefined => {
    if (remaining <= 0) return undefined
    const capped = capText(redactSecrets(text), Math.min(perMessage, remaining))
    remaining -= capped.length
    return capped
  }

  const latest = take(latestRaw)
  const purpose = purposeRaw === undefined ? undefined : take(purposeRaw)
  const history: string[] = []
  for (let index = historyRaw.length - 1; index >= 0; index--) {
    const capped = take(historyRaw[index])
    if (capped === undefined) break
    history.unshift(capped)
  }

  const included = (latest === undefined ? 0 : 1) + history.length
  return { latest, history, purpose, status: `available (${included} user messages)` }
}

const ZERO_WIDTH_SPACE = "\u200b"

/**
 * Breaks any text that looks like a section delimiter, so untrusted evidence cannot
 * close the evidence section or open a policy section. A carriage return becomes a
 * space, because it can hide the rest of a line in a terminal.
 */
export function neutralizeTags(text: string): string {
  return text.replace(/<(\/?)(evidence|policy)/gi, `<${ZERO_WIDTH_SPACE}$1$2`).replace(/\r/g, " ")
}

/** For a field that must stay on one line, so it cannot forge a new label. */
const single = (text: string): string => neutralizeTags(redactSecrets(text)).replace(/\n/g, "\\n")

/** For a field that may span lines. Every line after the first is indented, so no line starts a label. */
const block = (text: string): string => neutralizeTags(redactSecrets(text)).split("\n").join("\n  ")

/** Serializes untrusted structured data with the secrets removed first. */
const structured = (value: unknown, max: number): string =>
  capText(neutralizeTags(redactSecrets(JSON.stringify(redactValue(value)) ?? "null")), max)

const PATH_ACTIONS = new Set(["read", "edit", "external_directory"])

function expandHome(resource: string, home: string): string {
  if (resource === "~" || resource === "$HOME") return home
  if (resource.startsWith("~/")) return join(home, resource.slice(2))
  if (resource.startsWith("$HOME/")) return join(home, resource.slice(6))
  return resource
}

/**
 * Resolves where one resource lives, so the model reads the location instead of inferring
 * it from the path text. Only read, edit, and external_directory resources are paths.
 */
export function resourceLocation(action: string, resource: string, projectDirectory: string, home: string): string {
  if (!PATH_ACTIONS.has(action)) return "not a path"
  // An external_directory resource names the directory as `<dir>/*`.
  const target = action === "external_directory" && resource.endsWith("/*") ? resource.slice(0, -1) : resource
  const project = resolve(projectDirectory)
  const resolved = resolve(project, expandHome(target, home))
  if (resolved === project || resolved.startsWith(project + sep)) return "inside project"
  const root = resolve(home)
  const inHome = resolved === root || resolved.startsWith(root + sep)
  return `outside project (${inHome ? "home directory" : "system"})`
}

export interface EvidenceInput {
  event: PermissionEvent
  intent: Intent
  correlated?: CorrelatedCall
  projectDirectory: string
  maxEvidenceChars: number
  maxIntentChars: number
  /** Defaults to `os.homedir()`. Injected by the tests. */
  home?: string
}

export function buildEvidence(input: EvidenceInput): string {
  const { correlated, event, intent } = input
  const share = Math.floor(input.maxEvidenceChars / 2)
  const lines: string[] = []

  lines.push(`ACTION: ${single(event.action)}`)
  lines.push(`AGENT: ${event.agent ? single(event.agent) : "unknown"}`)
  lines.push(`PROJECT_DIRECTORY: ${single(input.projectDirectory)}`)
  lines.push("RESOURCES (each item is authorized by this one decision):")
  event.resources.forEach((resource, index) => {
    lines.push(`${index + 1}. ${single(resource)}`)
  })

  const home = input.home ?? homedir()
  const locations = event.resources.map(
    (resource, index) => `${index + 1}. ${resourceLocation(event.action, resource, input.projectDirectory, home)}`,
  )
  lines.push(`RESOURCE_LOCATION: ${single(locations.join("; "))}`)

  lines.push(`METADATA: ${event.metadata ? structured(event.metadata, share) : "none"}`)

  lines.push(`TOOL: ${correlated ? single(correlated.tool) : "unavailable"}`)
  lines.push(`TOOL_INPUT: ${correlated ? structured(correlated.input, share) : "unavailable"}`)

  if (correlated?.shell) {
    lines.push(`SHELL_CWD: ${single(correlated.shell.cwd)}`)
    lines.push(`SHELL_COMMAND: ${single(correlated.shell.command)}`)
  }

  lines.push(
    `DIRECT_USER_INTENT (most recent user message): ${intent.latest ? block(intent.latest) : "unavailable"}`,
  )
  lines.push("USER_INTENT_HISTORY (older user messages, oldest first):")
  for (const text of intent.history) lines.push(`- ${block(text)}`)
  lines.push(
    `AGENT_STATED_PURPOSE (untrusted, last assistant text before this action): ${intent.purpose ? block(intent.purpose) : "unavailable"}`,
  )
  lines.push(`TRANSCRIPT_STATUS: ${single(intent.status)}`)

  return capText(lines.join("\n"), input.maxEvidenceChars + input.maxIntentChars + 2000)
}

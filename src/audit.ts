import { appendFile, chmod, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { redactSecrets } from "./redact.js"
import type { AuditRecord } from "./types.js"

const REASON_LIMIT = 2000
const FILE_MODE = 0o600

export interface AuditWriter {
  write(record: AuditRecord): Promise<void>
  flush(): Promise<void>
}

/** Redacts every string that reaches the audit log, and caps the reason. */
export function redactRecord(record: AuditRecord): AuditRecord {
  const redacted: AuditRecord = {
    ...record,
    resources: record.resources.map(redactSecrets),
    warnings: record.warnings.map(redactSecrets),
    reason: redactSecrets(record.reason).slice(0, REASON_LIMIT),
  }
  if (record.model !== undefined) redacted.model = redactSecrets(record.model)
  const decision = record.decision
  if (decision) redacted.decision = { ...decision, rationale: redactSecrets(decision.rationale) }
  return redacted
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Appends one JSON line per decision. An undefined path disables the log. */
export function createAuditWriter(
  path: string | undefined,
  options?: { warn?: (message: string) => void },
): AuditWriter {
  if (path === undefined) {
    return { write: async () => {}, flush: async () => {} }
  }

  const file = path
  const warn = options?.warn ?? console.warn
  let chain: Promise<void> = Promise.resolve()
  let directoryReady = false
  let modeApplied = false
  let warned = false

  const append = async (record: AuditRecord): Promise<void> => {
    try {
      if (!directoryReady) {
        await mkdir(dirname(file), { recursive: true })
        directoryReady = true
      }
      await appendFile(file, `${JSON.stringify(redactRecord(record))}\n`, { mode: FILE_MODE })
      if (!modeApplied) {
        modeApplied = true
        try {
          await chmod(file, FILE_MODE)
        } catch {
          // Some platforms do not support file modes.
        }
      }
    } catch (error) {
      if (!warned) {
        warned = true
        warn(`audit log write failed for ${file}: ${describe(error)}`)
      }
    }
  }

  return {
    write(record) {
      chain = chain.then(() => append(record))
      return chain
    },
    flush() {
      return chain
    },
  }
}

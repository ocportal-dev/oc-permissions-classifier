import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAuditWriter, redactRecord } from "../src/audit.js"
import type { AuditRecord } from "../src/types.js"

const TOKEN = "Bearer abcdefghijklmnopqrstuvwxyz"

const record = (overrides: Partial<AuditRecord> = {}): AuditRecord => ({
  schemaVersion: 1,
  promptVersion: "2026-01-01",
  timestamp: "2026-01-01T00:00:00.000Z",
  durationMs: 12,
  sessionID: "ses_1",
  action: "read",
  resources: ["/tmp/a.txt"],
  inputEffect: "ask",
  outcome: "allow",
  appliedEffect: "allow",
  escalation: "ask",
  decisionSource: "model",
  reason: "read of a project file",
  attempts: 1,
  warnings: [],
  ...overrides,
})

const readLines = async (path: string): Promise<string[]> => {
  const text = await readFile(path, "utf8")
  return text.split("\n").filter((line) => line.length > 0)
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opc-audit-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test("an undefined path produces a no-op writer", async () => {
  const writer = createAuditWriter(undefined)

  await writer.write(record())
  await writer.flush()

  await expect(readLines(join(dir, "audit.jsonl"))).rejects.toThrow()
})

test("writes one JSON line per record", async () => {
  const path = join(dir, "audit.jsonl")
  const writer = createAuditWriter(path)

  await writer.write(record({ sessionID: "ses_1" }))
  await writer.write(record({ sessionID: "ses_2" }))
  await writer.flush()

  const lines = await readLines(path)
  expect(lines).toHaveLength(2)
  expect(lines.map((line) => JSON.parse(line).sessionID)).toEqual(["ses_1", "ses_2"])
})

test("concurrent writes produce intact lines in call order", async () => {
  const path = join(dir, "audit.jsonl")
  const writer = createAuditWriter(path)

  const first = writer.write(record({ sessionID: "ses_1" }))
  const second = writer.write(record({ sessionID: "ses_2" }))
  await Promise.all([first, second])

  const lines = await readLines(path)
  expect(lines).toHaveLength(2)
  expect(lines.map((line) => JSON.parse(line).sessionID)).toEqual(["ses_1", "ses_2"])
})

test("creates the file with mode 0o600", async () => {
  const path = join(dir, "audit.jsonl")
  const writer = createAuditWriter(path)

  await writer.write(record())
  await writer.flush()

  const info = await stat(path)
  expect(info.mode & 0o777).toBe(0o600)
})

test("creates a missing parent directory", async () => {
  const path = join(dir, "nested", "deeper", "audit.jsonl")
  const writer = createAuditWriter(path)

  await writer.write(record())
  await writer.flush()

  expect(await readLines(path)).toHaveLength(1)
})

test("an unwritable path resolves and warns once", async () => {
  await writeFile(join(dir, "file"), "not a directory")
  const path = join(dir, "file", "audit.jsonl")
  const warnings: string[] = []
  const writer = createAuditWriter(path, { warn: (message) => warnings.push(message) })

  await writer.write(record())
  await writer.write(record())
  await writer.flush()

  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain(path)
})

test("redactRecord redacts secrets in the reason and in a resource", () => {
  const redacted = redactRecord(
    record({ reason: `token ${TOKEN} used`, resources: [`/tmp/a.txt?auth=${TOKEN}`] }),
  )

  expect(redacted.reason).not.toContain("abcdefghijklmnopqrstuvwxyz")
  expect(redacted.resources[0]).not.toContain("abcdefghijklmnopqrstuvwxyz")
})

test("redactRecord caps the reason at 2000 characters", () => {
  const redacted = redactRecord(record({ reason: "a".repeat(3000) }))

  expect(redacted.reason).toHaveLength(2000)
})

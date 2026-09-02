import type { CorrelatedCall } from "./types.js"

interface StoredCall {
  tool: string
  input: unknown
  sessionID: string
  shell?: { command: string; cwd: string }
  expiresAt: number
}

export interface CorrelationStore {
  set(id: string, entry: { tool: string; input: unknown; sessionID: string }): void
  /** An undefined sessionID matches any session, because `shell.create.before` has none. */
  attachShell(sessionID: string | undefined, shell: { command: string; cwd: string }): void
  take(id: string | undefined): CorrelatedCall | undefined
  size(): number
}

export interface CorrelationOptions {
  max?: number
  ttlMs?: number
  now?: () => number
}

/**
 * Holds the tool calls seen in `tool.execute.before` until the matching permission
 * evaluation asks for them. The store is bounded and every entry expires, so a call
 * that never reaches an evaluation cannot grow the process memory.
 */
export function createCorrelationStore(options: CorrelationOptions = {}): CorrelationStore {
  const max = options.max ?? 256
  const ttlMs = options.ttlMs ?? 300000
  const now = options.now ?? Date.now
  const calls = new Map<string, StoredCall>()

  function prune(): void {
    const time = now()
    for (const [id, call] of calls) if (call.expiresAt <= time) calls.delete(id)
  }

  return {
    set(id, entry) {
      prune()
      calls.delete(id)
      calls.set(id, { ...entry, expiresAt: now() + ttlMs })
      // Map iteration follows insertion order, so the first key is the oldest entry.
      while (calls.size > max) {
        const oldest = calls.keys().next()
        if (oldest.done) break
        calls.delete(oldest.value)
      }
    },

    attachShell(sessionID, shell) {
      // Both hooks fire in call order, so the oldest shell call without a command is
      // the one this command belongs to.
      const pending = [...calls.entries()].find(
        ([, call]) =>
          (sessionID === undefined || call.sessionID === sessionID) && call.tool === "shell" && !call.shell,
      )
      if (pending) pending[1].shell = shell
    },

    take(id) {
      if (!id) return undefined
      prune()
      const call = calls.get(id)
      if (!call) return undefined
      calls.delete(id)
      return call.shell
        ? { tool: call.tool, input: call.input, shell: call.shell }
        : { tool: call.tool, input: call.input }
    },

    size() {
      return calls.size
    },
  }
}

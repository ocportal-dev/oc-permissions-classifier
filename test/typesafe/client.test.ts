import { expect, it } from "bun:test"
import { createSystemOne } from "../../src/typesafe/client.js"

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

it("posts the state and questions to /v1/systemone with the bearer key", async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const systemOne = createSystemOne({
    apiKey: "secret-key",
    baseURL: "http://unit.test",
    timeoutMs: 1000,
    maxRetries: 0,
    fetch: async (url, init) => {
      calls.push({ url, init: init ?? {} })
      return ok({ model: "jev-x", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } })
    },
  })
  const result = await systemOne({ action: "read" }, "jev-latest", new AbortController().signal)
  expect(result.model).toBe("jev-x")
  expect(calls[0].url).toBe("http://unit.test/v1/systemone")
  expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer secret-key")
  const body = JSON.parse(String(calls[0].init.body))
  expect(body.state).toEqual({ action: "read" })
  expect(body.model).toBe("jev-latest")
  expect(Object.keys(body.questions)).toContain("risk_level")
})

it("rejects when the signal aborts", async () => {
  const controller = new AbortController()
  const systemOne = createSystemOne({
    apiKey: "k",
    baseURL: "http://unit.test",
    timeoutMs: 1000,
    maxRetries: 0,
    fetch: (_url, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      ),
  })
  const pending = systemOne({}, "jev-latest", controller.signal)
  controller.abort()
  await expect(pending).rejects.toThrow()
})

it("does not retry when maxRetries is 0", async () => {
  let n = 0
  const systemOne = createSystemOne({
    apiKey: "k",
    baseURL: "http://unit.test",
    timeoutMs: 1000,
    maxRetries: 0,
    fetch: async () => {
      n += 1
      return new Response("{}", { status: 529 })
    },
  })
  await expect(systemOne({}, "jev-latest", new AbortController().signal)).rejects.toThrow()
  expect(n).toBe(1)
})

import { expect, it } from "bun:test"
import { formatModelRef, parseModelRef } from "../src/model-ref.js"

it("parses a provider and a model id", () => {
  expect(parseModelRef("omlx-macstudio/gemma-4-26B-A4B-it-qat-OptiQ-4bit")).toEqual({
    providerID: "omlx-macstudio",
    id: "gemma-4-26B-A4B-it-qat-OptiQ-4bit",
  })
})

it("splits at the first slash only", () => {
  expect(parseModelRef("acme/org/model-x")).toEqual({ providerID: "acme", id: "org/model-x" })
})

it("reads the variant after the hash", () => {
  expect(parseModelRef("openai/gpt-5.4-nano#none")).toEqual({
    providerID: "openai",
    id: "gpt-5.4-nano",
    variant: "none",
  })
})

it("trims surrounding space", () => {
  expect(parseModelRef("  acme/model  ")).toEqual({ providerID: "acme", id: "model" })
})

it.each([["nope"], ["/x"], ["x/"], [""], ["   "], ["/"], ["acme/#none"]])(
  "rejects the string %p",
  (value) => {
    expect(parseModelRef(value)).toBeUndefined()
  },
)

it("parses an object form", () => {
  expect(parseModelRef({ providerID: "acme", id: "model", variant: "fast" })).toEqual({
    providerID: "acme",
    id: "model",
    variant: "fast",
  })
})

it("drops an empty variant on the object form", () => {
  expect(parseModelRef({ providerID: "acme", id: "model", variant: "  " })).toEqual({
    providerID: "acme",
    id: "model",
  })
})

it.each([
  [42],
  [null],
  [undefined],
  [[]],
  [{ providerID: "", id: "x" }],
  [{ providerID: "acme" }],
  [{ providerID: "acme", id: 7 }],
])("rejects the value %p", (value) => {
  expect(parseModelRef(value)).toBeUndefined()
})

it("formats a reference without a variant", () => {
  expect(formatModelRef({ providerID: "acme", id: "org/model" })).toBe("acme/org/model")
})

it("formats a reference with a variant", () => {
  expect(formatModelRef({ providerID: "acme", id: "model", variant: "none" })).toBe("acme/model#none")
})

it.each([["acme/model"], ["acme/org/model#none"]])("round-trips %p", (value) => {
  const parsed = parseModelRef(value)
  expect(parsed).toBeDefined()
  expect(formatModelRef(parsed!)).toBe(value)
})

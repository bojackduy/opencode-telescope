import { afterEach, describe, expect, test } from "bun:test"
import { LlamaEmbeddingClient } from "./embedding.ts"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("LlamaEmbeddingClient", () => {
  const client = new LlamaEmbeddingClient({
    baseUrl: "http://localhost:9999",
    documentPrefix: "search_document: ",
    queryPrefix: "search_query: ",
  })

  test("health returns false for unreachable server", async () => {
    const result = await client.health()
    expect(result).toBe(false)
  })

  test("embedQuery prefixes with query prefix", async () => {
    const inputs: string[] = []
    globalThis.fetch = async (url: RequestInfo | URL) => {
      if (typeof url === "string" && url.includes("/v1/embeddings")) {
        inputs.push("called")
      }
      return new Response(null, { status: 500 })
    }

    await expect(client.embedQuery("test query")).rejects.toThrow()
  })

  test("embedDocuments prefixes with document prefix", async () => {
    globalThis.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}")
      expect(body.input).toEqual(["search_document: doc1", "search_document: doc2"])
      return new Response(JSON.stringify({
        data: [
          { index: 0, embedding: [0.1, 0.2, 0.3] },
          { index: 1, embedding: [0.4, 0.5, 0.6] },
        ],
      }), { status: 200 })
    }

    const result = await client.embedDocuments(["doc1", "doc2"])
    expect(result).toHaveLength(2)
    expect(result[0]).toBeInstanceOf(Float32Array)
    expect(result[0][0]).toBeCloseTo(0.1, 5)
    expect(result[1][2]).toBeCloseTo(0.6, 5)
  })

  test("embedQuery returns single vector", async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({
        data: [{ index: 0, embedding: [0.5, 0.5] }],
      }), { status: 200 })
    }

    const result = await client.embedQuery("hello")
    expect(result).toBeInstanceOf(Float32Array)
    expect(result).toHaveLength(2)
  })

  test("rejects non-array embedding", async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({
        data: [{ index: 0, embedding: "not-an-array" }],
      }), { status: 200 })
    }

    await expect(client.embedQuery("test")).rejects.toThrow()
  })

  test("rejects embedding with non-finite values", async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({
        data: [{ index: 0, embedding: [1, "not-a-number", 3] }],
      }), { status: 200 })
    }

    await expect(client.embedQuery("test")).rejects.toThrow()
  })
})

export type EmbeddingConfig = {
  baseUrl: string
  model?: string
  documentPrefix: string
  queryPrefix: string
}

type EmbeddingResponse = {
  data?: Array<{
    index?: number
    embedding?: unknown
  }>
  model?: string
}

export class LlamaEmbeddingClient {
  constructor(private readonly config: EmbeddingConfig) {}

  async health() {
    for (const endpoint of ["/health", "/v1/health"]) {
      try {
        const response = await fetch(new URL(endpoint, this.config.baseUrl))
        if (response.ok) return true
      } catch {
        continue
      }
    }
    return false
  }

  async embedQuery(query: string) {
    return this.embed([this.config.queryPrefix + query]).then((items) => items[0])
  }

  async embedDocuments(documents: string[]) {
    return this.embed(documents.map((document) => this.config.documentPrefix + document))
  }

  private async embed(inputs: string[]) {
    const response = await fetch(new URL("/v1/embeddings", this.config.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.config.model ?? "local-embedding",
        input: inputs,
        encoding_format: "float",
      }),
    })
    if (!response.ok) throw new Error(`Embedding request failed: ${response.status}`)

    const payload = (await response.json()) as EmbeddingResponse
    if (!payload.data || payload.data.length !== inputs.length) {
      throw new Error("Embedding response did not contain one vector per input")
    }

    return [...payload.data]
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((item) => {
        if (!Array.isArray(item.embedding)) throw new Error("Embedding response contained a non-array embedding")
        const values = item.embedding.map((value: unknown) => Number(value))
        if (values.some((value) => !Number.isFinite(value))) {
          throw new Error("Embedding response contained non-finite values")
        }
        return new Float32Array(values)
      })
  }
}

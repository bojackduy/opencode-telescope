export function containsOrderedTokens(text: string, query: string) {
  const tokens = query.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  const lower = text.toLowerCase()
  let searchPos = 0
  for (const token of tokens) {
    const index = lower.indexOf(token.toLowerCase(), searchPos)
    if (index === -1) return false
    searchPos = index + token.length
  }
  return true
}

export function findOrderedTokenLine(lines: string[], query: string) {
  const tokens = query.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return -1
  for (let index = 0; index < lines.length; index++) {
    if (containsOrderedTokens(lines[index]!, query)) return index
  }
  return -1
}

export function clippedText(text: string, query: string, radiusLines: number) {
  const lines = text.split("\n")
  const tooLarge = text.length > 30000 || lines.length > 420
  if (!tooLarge) return { text, clipped: false }

  const matchLine = findOrderedTokenLine(lines, query)
  if (matchLine === -1) {
    return { text: lines.slice(0, radiusLines * 2).join("\n"), clipped: true }
  }

  const start = Math.max(0, matchLine - radiusLines)
  const end = Math.min(lines.length, matchLine + radiusLines + 1)
  return {
    text: [
      start > 0 ? `... ${start} lines omitted ...` : undefined,
      ...lines.slice(start, end),
      end < lines.length ? `... ${lines.length - end} lines omitted ...` : undefined,
    ].filter(Boolean).join("\n"),
    clipped: true,
  }
}

export function matchExcerpt(text: string, query: string, radius = 80) {
  const needle = query.trim()
  if (!needle) return
  const tokens = needle.split(/\s+/)
  const lowerText = text.toLowerCase()
  let searchPos = 0
  let firstStart = -1
  let lastEnd = -1
  for (const token of tokens) {
    const start = lowerText.indexOf(token.toLowerCase(), searchPos)
    if (start === -1) return
    if (firstStart === -1) firstStart = start
    searchPos = start + token.length
    lastEnd = searchPos
  }
  const beforeStart = Math.max(0, firstStart - radius)
  const afterEnd = Math.min(text.length, lastEnd + radius)
  return {
    before: `${beforeStart > 0 ? "..." : ""}${text.slice(beforeStart, firstStart).replace(/\s+/g, " ")}`,
    match: text.slice(firstStart, lastEnd),
    after: `${text.slice(lastEnd, afterEnd).replace(/\s+/g, " ")}${afterEnd < text.length ? "..." : ""}`,
  }
}

export function conversationMatch(text: string, target: boolean, match: string) {
  if (!target || !match) return
  const tokens = match.split(/\s+/)
  const lowerText = text.toLowerCase()
  let searchPos = 0
  let firstStart = -1
  let lastEnd = -1
  for (const token of tokens) {
    const index = lowerText.indexOf(token.toLowerCase(), searchPos)
    if (index === -1) return
    if (firstStart === -1) firstStart = index
    searchPos = index + token.length
    lastEnd = searchPos
  }
  return { start: firstStart, end: lastEnd }
}

export function parseApplyPatchFiles(metadata: unknown) {
  const files = recordValue(metadata)?.files
  if (!Array.isArray(files)) return []
  return files.flatMap((item) => {
    const file = recordValue(item)
    const filePath = stringValue(file?.filePath)
    const relativePath = stringValue(file?.relativePath) ?? filePath
    const patch = stringValue(file?.patch)
    const type = stringValue(file?.type) ?? "update"
    const deletions = numberValue(file?.deletions) ?? 0
    if (!filePath || !relativePath || patch === undefined) return []
    return [{ filePath, relativePath, patch, type, deletions }]
  })
}

export function shortPath(value: string) {
  if (!value) return "file"
  const parts = value.split(/[\\/]/)
  return parts.slice(-3).join("/")
}

export function filetype(input: string) {
  const ext = input.split(".").at(-1)?.toLowerCase()
  if (!ext || ext === input.toLowerCase()) return "none"
  if (["ts", "tsx", "js", "jsx", "mts", "cts"].includes(ext)) return "typescript"
  if (ext === "py") return "python"
  if (ext === "go") return "go"
  if (ext === "rs") return "rust"
  if (ext === "rb") return "ruby"
  if (ext === "java") return "java"
  if (ext === "json") return "json"
  if (ext === "md") return "markdown"
  if (ext === "yml" || ext === "yaml") return "yaml"
  if (ext === "sql") return "sql"
  if (ext === "sh" || ext === "bash" || ext === "zsh") return "shellscript"
  if (ext === "diff" || ext === "patch") return "diff"
  return ext
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

export function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

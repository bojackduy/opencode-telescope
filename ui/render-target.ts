import type { ScrollBoxRenderable } from "@opentui/core"
import type { ConversationPreviewPart, SearchResult } from "../search.ts"
import { debug } from "./debug.ts"

export function previewScrollAmount(scroll: ScrollBoxRenderable | undefined) {
  return Math.max(1, Math.floor((scroll?.height || 10) / 8))
}

export function messageTargetID(item: SearchResult) {
  if (item.partType === "tool") return `tool-${item.messageID}-${item.id}`
  if (item.partType === "reasoning") return `text-${item.messageID}-${item.id}`
  if (item.role === "assistant") return `text-${item.messageID}-${item.id}`
  return item.messageID
}

export function previewPartTargetID(item: SearchResult) {
  return `preview-part-${item.id}`
}

export function jumpTargetIDs(item: SearchResult, parts: ConversationPreviewPart[] = []) {
  const ids: string[] = []
  const add = (id: string | undefined) => {
    if (id && !ids.includes(id)) ids.push(id)
  }

  add(messageTargetID(item))

  const targetIndex = parts.findIndex((part) => part.id === item.id)
  const visibleParts = parts.filter(isVisibleJumpPart)
  const sameMessage = sortByDistance(visibleParts.filter((part) => part.messageID === item.messageID), parts, targetIndex)
  for (const part of sameMessage) add(partTargetID(part))

  add(item.messageID)

  for (const part of sortByDistance(visibleParts, parts, targetIndex)) add(partTargetID(part))
  return ids
}

type OpenCodeMessage = {
  id: string
  role: string
  parentID?: string
}

export function openCodeJumpTarget(messageID: string, fallbackTargetIDs: string[], messages: readonly OpenCodeMessage[]) {
  const message = messages.find((candidate) => candidate.id === messageID)
  if (!message) return { available: false, targetIDs: fallbackTargetIDs }
  if (message.role === "user") return { available: true, targetIDs: [message.id] }
  if (message.role === "assistant" && message.parentID && messages.some((candidate) => candidate.id === message.parentID)) {
    return { available: true, targetIDs: [message.parentID] }
  }
  return { available: false, targetIDs: fallbackTargetIDs }
}

export function scrollPreviewToTarget(scroll: ScrollBoxRenderable | undefined, targetID: string) {
  if (!scroll) {
    debug.log("preview:target-scroll:skip", { reason: "no-scroll", targetID })
    return false
  }
  const target = findRenderableByID(scroll, targetID)
  if (!target) {
    debug.log("preview:target-scroll:skip", {
      reason: "target-not-found",
      targetID,
      y: scroll.y,
      scrollTop: scroll.scrollTop,
      scrollHeight: scroll.scrollHeight,
      height: scroll.height,
      children: scroll.getChildren().length,
    })
    return false
  }
  const contentY = target.y + scroll.scrollTop - scroll.y
  const desiredScrollTop = Math.max(0, contentY - Math.max(1, Math.floor(scroll.height / 3)))
  debug.log("preview:target-scroll", {
    targetID,
    targetY: target.y,
    scrollY: scroll.y,
    scrollTop: scroll.scrollTop,
    contentY,
    desiredScrollTop,
    scrollHeight: scroll.height,
    contentHeight: scroll.scrollHeight,
  })
  scroll.scrollTo(desiredScrollTop)
  debug.log("preview:target-scroll:after", { targetID, scrollY: scroll.y, scrollTop: scroll.scrollTop, desiredScrollTop })
  return true
}

export type JumpResolvedHit = {
  target: RenderNode
  scroll: ScrollNode
  label: string
}

export type JumpToRenderedTargetOptions = {
  ready?: () => boolean
  unavailable?: () => boolean
  resolve?: () => JumpResolvedHit | undefined
  timeout?: number
  interval?: number
}

export type JumpToRenderedTargetResult =
  | { status: "found"; targetID: string; method: "id" | "resolve" }
  | { status: "unavailable" }
  | { status: "missing" }

export type TextCandidate = {
  node: RenderNode
  text: string
  kind: "text" | "code" | "diff"
}

export function findTargetWithScroll(root: unknown, targetID: string) {
  return findRenderableTarget(root, targetID)
}

export function collectTurnCandidates(scroll: ScrollNode, startID: string, endID?: string): TextCandidate[] {
  const children = scroll.getChildren().filter(isRenderNode)
  const startIndex = children.findIndex((child) => child.id === startID)
  if (startIndex === -1) return []
  const endIndex = endID ? children.findIndex((child) => child.id === endID) : -1
  const stop = endIndex === -1 ? children.length : endIndex
  const candidates: TextCandidate[] = []
  for (let index = startIndex + 1; index < stop; index++) {
    collectNodeTexts(children[index]!, candidates)
  }
  return candidates
}

export function matchPartCandidate(
  candidates: TextCandidate[],
  partText: string,
  partType: SearchResult["partType"],
  tool?: string,
): { node: RenderNode; confidence: "exact" | "likely"; kind: TextCandidate["kind"] } | undefined {
  const normalized = normalizeText(partText)
  if (partType === "tool") {
    if (normalized.length < 20) return undefined
    for (const candidate of candidates) {
      const candidateText = normalizeText(candidate.text)
      if (candidateText.length < 20) continue
      if (candidateText.includes(normalized) || normalized.includes(candidateText)) {
        return { node: candidate.node, confidence: "exact", kind: candidate.kind }
      }
    }
    return matchOrderedCoverage(candidates, normalized, 0.5, "likely")
  }
  if (partType === "reasoning") {
    const tokens = tokenize(normalized.slice(0, 200))
    if (tokens.length < 2) return undefined
    return matchOrderedCoverage(candidates, tokens.join(" "), 0.5, "likely")
  }
  if (normalized.length === 0) return undefined
  for (const candidate of candidates) {
    const candidateText = normalizeText(candidate.text)
    if (candidateText === normalized) {
      return { node: candidate.node, confidence: "exact", kind: candidate.kind }
    }
  }
  const tokens = tokenize(normalized)
  if (tokens.length < 3) return undefined
  return matchOrderedCoverage(candidates, tokens.join(" "), 0.6, "likely")
}

export function jumpToRenderedTarget(
  root: unknown | (() => unknown),
  targetID: string | string[] | (() => string | string[]),
  options: JumpToRenderedTargetOptions = {},
): Promise<JumpToRenderedTargetResult> {
  const interval = options.interval ?? 50
  const timeout = options.timeout ?? 10_000
  let readyAt: number | undefined
  return new Promise((resolve) => {
    const tick = () => {
      if (options.unavailable?.()) {
        debug.log("jump:target-unavailable")
        resolve({ status: "unavailable" })
        return
      }
      if (options.ready && !options.ready()) {
        setTimeout(tick, interval)
        return
      }
      readyAt ??= Date.now()
      const currentRoot = typeof root === "function" ? root() : root
      if (options.resolve) {
        const resolved = options.resolve()
        if (resolved) {
          debug.log("jump:target:resolve", { targetID: resolved.label })
          resolved.scroll.scrollBy(resolved.target.y - resolved.scroll.y - 1)
          resolve({ status: "found", targetID: resolved.label, method: "resolve" })
          return
        }
      }
      const currentTarget = typeof targetID === "function" ? targetID() : targetID
      const targetIDs = Array.isArray(currentTarget) ? currentTarget.filter(Boolean) : [currentTarget]
      if (targetIDs.length === 0) {
        debug.log("jump:target-missing", { targetIDs })
        resolve({ status: "missing" })
        return
      }
      for (const candidate of targetIDs) {
        const hit = findRenderableTarget(currentRoot, candidate)
        if (hit) {
          debug.log("jump:target", { targetID: candidate, candidates: targetIDs })
          hit.scroll.scrollBy(hit.target.y - hit.scroll.y - 1)
          resolve({ status: "found", targetID: candidate, method: "id" })
          return
        }
      }
      if (Date.now() - readyAt < timeout) {
        setTimeout(tick, interval)
      } else {
        debug.log("jump:target-missing", { targetIDs })
        resolve({ status: "missing" })
      }
    }
    setTimeout(tick, interval)
  })
}

export type RenderNode = {
  id?: string
  y: number
  height?: number
  getChildren(): unknown[]
}

type ScrollNode = RenderNode & {
  scrollBy(delta: number): void
}

function findRenderableTarget(node: unknown, targetID: string, scroll?: ScrollNode): { target: RenderNode; scroll: ScrollNode } | undefined {
  if (!isRenderNode(node)) return
  const nextScroll = isScrollNode(node) ? node : scroll
  if (node.id === targetID && nextScroll) return { target: node, scroll: nextScroll }
  for (const child of node.getChildren()) {
    const result = findRenderableTarget(child, targetID, nextScroll)
    if (result) return result
  }
}

function collectNodeTexts(node: RenderNode, out: TextCandidate[]) {
  const content = (node as unknown as Record<string, unknown>).content
  const contentText = textFromContent(content)
  if (contentText) out.push({ node, text: contentText, kind: "text" })
  const plainText = (node as unknown as Record<string, unknown>).plainText
  if (typeof plainText === "string" && plainText) out.push({ node, text: plainText, kind: "code" })
  const diff = (node as unknown as Record<string, unknown>).diff
  if (typeof diff === "string" && diff) out.push({ node, text: diff, kind: "diff" })
  for (const child of node.getChildren()) {
    if (isRenderNode(child)) collectNodeTexts(child, out)
  }
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value
  if (!value || typeof value !== "object") return undefined
  const chunks = (value as { chunks?: unknown }).chunks
  if (!Array.isArray(chunks)) return undefined
  return chunks
    .map((chunk) => (chunk && typeof chunk === "object" && "text" in chunk ? String((chunk as { text: unknown }).text) : ""))
    .join("")
}

function matchOrderedCoverage(
  candidates: TextCandidate[],
  query: string,
  threshold: number,
  confidence: "exact" | "likely",
): { node: RenderNode; confidence: "exact" | "likely"; kind: TextCandidate["kind"] } | undefined {
  const tokens = tokenize(query)
  if (tokens.length < 2) return undefined
  let best: { candidate: TextCandidate; coverage: number } | undefined
  for (const candidate of candidates) {
    const coverage = orderedTokenCoverage(normalizeText(candidate.text), tokens)
    if (!best || coverage > best.coverage) best = { candidate, coverage }
  }
  if (!best || best.coverage < threshold) return undefined
  return { node: best.candidate.node, confidence, kind: best.candidate.kind }
}

function orderedTokenCoverage(text: string, tokens: string[]) {
  if (text.length === 0) return 0
  const lower = text.toLowerCase()
  let matched = 0
  let searchPos = 0
  for (const token of tokens) {
    const index = lower.indexOf(token.toLowerCase(), searchPos)
    if (index === -1) break
    matched++
    searchPos = index + token.length
  }
  return matched / tokens.length
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function tokenize(value: string) {
  return value.trim().split(/\s+/).filter(Boolean).slice(0, 32)
}

function isRenderNode(value: unknown): value is RenderNode {
  return Boolean(
    value &&
      typeof value === "object" &&
      "y" in value &&
      typeof value.y === "number" &&
      "getChildren" in value &&
      typeof value.getChildren === "function",
  )
}

function isScrollNode(value: RenderNode): value is ScrollNode {
  return "scrollBy" in value && typeof value.scrollBy === "function"
}

function isVisibleJumpPart(part: ConversationPreviewPart) {
  return part.type !== "reasoning"
}

function partTargetID(part: ConversationPreviewPart) {
  if (part.type === "tool") return `tool-${part.messageID}-${part.id}`
  if (part.role === "assistant") return `text-${part.messageID}-${part.id}`
  return part.messageID
}

function sortByDistance(parts: ConversationPreviewPart[], allParts: ConversationPreviewPart[], targetIndex: number) {
  if (targetIndex < 0) return parts
  return [...parts].sort((a, b) => {
    const aIndex = allParts.findIndex((part) => part.id === a.id)
    const bIndex = allParts.findIndex((part) => part.id === b.id)
    return Math.abs(aIndex - targetIndex) - Math.abs(bIndex - targetIndex)
  })
}

export function findRenderableByID(node: unknown, targetID: string): RenderNode | undefined {
  if (!isRenderNode(node)) return
  if (node.id === targetID) return node
  for (const child of node.getChildren()) {
    const result = findRenderableByID(child, targetID)
    if (result) return result
  }
}

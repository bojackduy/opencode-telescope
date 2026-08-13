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

export type JumpToRenderedTargetOptions = {
  ready?: () => boolean
  unavailable?: () => boolean
  timeout?: number
  interval?: number
}

export type JumpToRenderedTargetResult =
  | { status: "found"; targetID: string }
  | { status: "unavailable" }
  | { status: "missing" }

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
          resolve({ status: "found", targetID: candidate })
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

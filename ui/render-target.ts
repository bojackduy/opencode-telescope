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

export function jumpToRenderedTarget(root: unknown, targetID: string | string[]) {
  const targetIDs = Array.isArray(targetID) ? targetID.filter(Boolean) : [targetID]
  let attempts = 0
  const tick = () => {
    for (const candidate of targetIDs) {
      const hit = findRenderableTarget(root, candidate)
      if (hit) {
        debug.log("jump:target", { targetID: candidate, candidates: targetIDs })
        hit.scroll.scrollBy(hit.target.y - hit.scroll.y - 1)
        return
      }
    }
    attempts++
    if (attempts < 40) {
      setTimeout(tick, 50)
    } else {
      debug.log("jump:target-missing", { targetIDs })
    }
  }
  setTimeout(tick, 50)
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

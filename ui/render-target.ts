import type { ScrollBoxRenderable } from "@opentui/core"
import type { SearchResult } from "../search.ts"
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

export function scrollPreviewToTarget(scroll: ScrollBoxRenderable | undefined, targetID: string) {
  if (!scroll) {
    debug.log("preview:target-scroll:skip", { reason: "no-scroll", targetID })
    return
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
    return
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
}

export function jumpToRenderedTarget(root: unknown, targetID: string) {
  let attempts = 0
  const tick = () => {
    const hit = findRenderableTarget(root, targetID)
    if (hit) {
      hit.scroll.scrollBy(hit.target.y - hit.scroll.y - 1)
      return
    }
    attempts++
    if (attempts < 40) setTimeout(tick, 50)
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

export function findRenderableByID(node: unknown, targetID: string): RenderNode | undefined {
  if (!isRenderNode(node)) return
  if (node.id === targetID) return node
  for (const child of node.getChildren()) {
    const result = findRenderableByID(child, targetID)
    if (result) return result
  }
}

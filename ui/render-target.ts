import type { ScrollBoxRenderable } from "@opentui/core"
import type { SearchResult } from "../search.ts"

export function previewScrollAmount(scroll: ScrollBoxRenderable | undefined) {
  return Math.max(1, Math.floor((scroll?.height || 10) / 8))
}

export function messageTargetID(item: SearchResult) {
  if (item.role === "assistant") return `text-${item.messageID}-${item.id}`
  return item.messageID
}

export function scrollPreviewToTarget(scroll: ScrollBoxRenderable | undefined, targetID: string) {
  if (!scroll) return
  const target = findRenderableByID(scroll, targetID)
  if (!target) return
  scroll.scrollBy(target.y - scroll.y - Math.max(1, Math.floor(scroll.height / 3)))
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

type RenderNode = {
  id?: string
  y: number
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

function findRenderableByID(node: unknown, targetID: string): RenderNode | undefined {
  if (!isRenderNode(node)) return
  if (node.id === targetID) return node
  for (const child of node.getChildren()) {
    const result = findRenderableByID(child, targetID)
    if (result) return result
  }
}

import { describe, expect, test } from "bun:test"
import {
  collectTurnCandidates,
  findRenderableByID,
  findTargetWithScroll,
  jumpTargetIDs,
  jumpToRenderedTarget,
  matchPartCandidate,
  messageTargetID,
  openCodeJumpTarget,
  previewPartTargetID,
  previewScrollAmount,
  scrollPreviewToTarget,
} from "./render-target.ts"
import type { ConversationPreviewPart, SearchResult } from "../search.ts"

describe("render-target utils", () => {
  test("messageTargetID returns correct IDs", () => {
    const toolItem = { partType: "tool", messageID: "msg_1", id: "prt_1" } as SearchResult
    expect(messageTargetID(toolItem)).toBe("tool-msg_1-prt_1")

    const reasoningItem = { partType: "reasoning", messageID: "msg_2", id: "prt_2" } as SearchResult
    expect(messageTargetID(reasoningItem)).toBe("text-msg_2-prt_2")

    const assistantItem = { partType: "text", role: "assistant", messageID: "msg_3", id: "prt_3" } as SearchResult
    expect(messageTargetID(assistantItem)).toBe("text-msg_3-prt_3")

    const userItem = { partType: "text", role: "user", messageID: "msg_4", id: "prt_4" } as SearchResult
    expect(messageTargetID(userItem)).toBe("msg_4")
  })

  test("previewPartTargetID returns wrapper target ID", () => {
    expect(previewPartTargetID({ id: "prt_1" } as SearchResult)).toBe("preview-part-prt_1")
  })

  test("jumpTargetIDs falls back from hidden reasoning to visible same-message parts", () => {
    const item = { partType: "reasoning", role: "assistant", messageID: "msg_1", id: "prt_thought" } as SearchResult
    const parts = [
      previewPart("prt_user", "msg_0", "user", "text"),
      previewPart("prt_thought", "msg_1", "assistant", "reasoning"),
      previewPart("prt_text", "msg_1", "assistant", "text"),
      previewPart("prt_next", "msg_2", "assistant", "text"),
    ]

    expect(jumpTargetIDs(item, parts)).toEqual([
      "text-msg_1-prt_thought",
      "text-msg_1-prt_text",
      "msg_1",
      "msg_0",
      "text-msg_2-prt_next",
    ])
  })

  test("jumpTargetIDs falls back from tool matches to visible message/session targets", () => {
    const item = { partType: "tool", role: "assistant", messageID: "msg_1", id: "prt_tool" } as SearchResult
    const parts = [
      previewPart("prt_text", "msg_1", "assistant", "text"),
      previewPart("prt_tool", "msg_1", "assistant", "tool"),
      previewPart("prt_user", "msg_2", "user", "text"),
    ]

    expect(jumpTargetIDs(item, parts)).toEqual([
      "tool-msg_1-prt_tool",
      "text-msg_1-prt_text",
      "msg_1",
      "msg_2",
    ])
  })

  test("openCodeJumpTarget uses the rendered user prompt for assistant results", () => {
    expect(openCodeJumpTarget("msg_assistant", ["fallback"], [
      { id: "msg_user", role: "user" },
      { id: "msg_assistant", role: "assistant", parentID: "msg_user" },
    ])).toEqual({ available: true, targetIDs: ["msg_user"] })
  })

  test("openCodeJumpTarget detects messages outside OpenCode's rendered window", () => {
    expect(openCodeJumpTarget("msg_old", ["fallback"], [
      { id: "msg_recent", role: "user" },
    ])).toEqual({ available: false, targetIDs: ["fallback"] })

    expect(openCodeJumpTarget("msg_assistant", ["fallback"], [
      { id: "msg_assistant", role: "assistant", parentID: "msg_old_user" },
    ])).toEqual({ available: false, targetIDs: ["fallback"] })
  })

  test("previewScrollAmount returns minimum of 1", () => {
    expect(previewScrollAmount(undefined)).toBe(1)
    expect(previewScrollAmount({ height: 0 } as never)).toBe(1)
    expect(previewScrollAmount({ height: 10 } as never)).toBe(1)
    expect(previewScrollAmount({ height: 24 } as never)).toBe(3)
  })

  test("findRenderableByID traverses render tree", () => {
    const tree = {
      id: "root",
      y: 0,
      getChildren() {
        return [
          { id: "child1", y: 1, height: 10, getChildren: () => [] },
          {
            id: "child2",
            y: 11,
            height: 20,
            getChildren: () => [
              { id: "target", y: 12, height: 5, getChildren: () => [] },
            ],
          },
        ]
      },
    }

    const found = findRenderableByID(tree, "target")
    expect(found).toBeDefined()
    expect(found!.id).toBe("target")
    expect(found!.y).toBe(12)

    expect(findRenderableByID(tree, "nonexistent")).toBeUndefined()
    expect(findRenderableByID(null, "x")).toBeUndefined()
    expect(findRenderableByID("string", "x")).toBeUndefined()
  })

  test("scrollPreviewToTarget scrolls target near upper third", () => {
    const scroll = {
      id: "scroll",
      y: 10,
      height: 30,
      scrollTop: 40,
      scrollHeight: 200,
      scrolledTo: undefined as number | undefined,
      scrollTo(value: number) {
        this.scrolledTo = value
        this.scrollTop = value
      },
      getChildren() {
        return [
          { id: "target", y: 50, height: 5, getChildren: () => [] },
        ]
      },
    }

    expect(scrollPreviewToTarget(scroll as never, "target")).toBe(true)
    expect(scroll.scrolledTo).toBe(70)
  })

  test("scrollPreviewToTarget reports missing target", () => {
    const scroll = {
      id: "scroll",
      y: 0,
      height: 20,
      scrollTop: 0,
      scrollHeight: 20,
      scrollTo() {},
      getChildren: () => [],
    }

    expect(scrollPreviewToTarget(scroll as never, "missing")).toBe(false)
  })

  test("jumpToRenderedTarget waits for a cross-session render and uses current targets", async () => {
    let ready = false
    let scrolledBy = 0
    let targetIDs = ["old-target"]
    let root: unknown = renderNode("old-root")

    setTimeout(() => {
      ready = true
      targetIDs = ["target"]
      root = renderNode("root", [
        {
          ...renderNode("scroll", [renderNode("target", [], 12)], 2),
          scrollBy(amount: number) {
            scrolledBy = amount
          },
        },
      ])
    }, 5)

    const result = await jumpToRenderedTarget(() => root, () => targetIDs, {
      ready: () => ready,
      interval: 1,
      timeout: 1,
    })

    expect(result).toEqual({ status: "found", targetID: "target", method: "id" })
    expect(scrolledBy).toBe(9)
  })

  test("jumpToRenderedTarget reports a loaded but missing target", async () => {
    const result = await jumpToRenderedTarget(renderNode("root"), "missing", { interval: 1, timeout: 5 })
    expect(result).toEqual({ status: "missing" })
  })

  test("jumpToRenderedTarget stops when OpenCode did not load the target", async () => {
    const result = await jumpToRenderedTarget(renderNode("root"), "missing", {
      ready: () => false,
      unavailable: () => true,
      interval: 1,
      timeout: 100,
    })
    expect(result).toEqual({ status: "unavailable" })
  })

  test("jumpToRenderedTarget prefers a heuristic resolve hit", async () => {
    let scrolledBy = 0
    const scroll = {
      ...renderNode("scroll", [], 2),
      scrollBy(amount: number) {
        scrolledBy = amount
      },
    }
    const target = renderNode("part-node", [], 12)

    const result = await jumpToRenderedTarget(renderNode("root", [scroll]), "fallback-id", {
      resolve: () => ({ target, scroll, label: "heuristic:text:exact" }),
      interval: 1,
      timeout: 5,
    })

    expect(result).toEqual({ status: "found", targetID: "heuristic:text:exact", method: "resolve" })
    expect(scrolledBy).toBe(9)
  })

  test("collectTurnCandidates gathers text, code, and diff content between user messages", () => {
    const scroll = {
      ...renderNode("scroll", [
        renderNode("msg_0", []),
        renderNode("markdown-node", [renderNode("inner", [])]).withContent("the full markdown text"),
        renderNode("code-node", []).withPlainText("const code = true"),
        renderNode("diff-node", []).withDiff("@@ -1 +1 @@\n+added"),
        renderNode("msg_1", []),
        renderNode("msg_2", [renderNode("ignored", [])]),
      ]),
      scrollBy() {},
    }

    const candidates = collectTurnCandidates(scroll, "msg_0", "msg_1")
    expect(candidates.map((candidate) => candidate.kind)).toEqual(["text", "code", "diff"])
    expect(candidates[0]?.text).toBe("the full markdown text")
  })

  test("matchPartCandidate prefers exact text matches and falls back to ordered coverage", () => {
    const exact = renderNode("exact-node", []).withContent("exact target body")
    const likely = renderNode("likely-node", []).withContent("a longer body that contains target words in order")
    const candidates = [
      { node: exact, text: "exact target body", kind: "text" as const },
      { node: likely, text: "a longer body that contains target words in order", kind: "text" as const },
    ]

    expect(matchPartCandidate(candidates, "exact target body", "text")?.node.id).toBe("exact-node")
    expect(matchPartCandidate(candidates, "target words", "text")).toBeUndefined()

    const coverageCandidates = candidates.slice(1)
    const hit = matchPartCandidate(coverageCandidates, "body target order", "text")
    expect(hit?.node.id).toBe("likely-node")
    expect(hit?.confidence).toBe("likely")
  })

  test("matchPartCandidate matches patch diffs and reasoning summaries heuristically", () => {
    const diffNode = renderNode("diff-node", []).withDiff("@@ -1 +1 @@\n+the patch line")
    const diffHit = matchPartCandidate(
      [{ node: diffNode, text: "@@ -1 +1 @@\n+the patch line", kind: "diff" as const }],
      "src/service.ts\n@@ -1 +1 @@\n+the patch line",
      "tool",
      "apply_patch",
    )
    expect(diffHit?.node.id).toBe("diff-node")
    expect(diffHit?.confidence).toBe("exact")

    const summaryNode = renderNode("summary-node", []).withContent("thinking about the plan step by step")
    const summaryHit = matchPartCandidate(
      [{ node: summaryNode, text: "thinking about the plan step by step", kind: "text" as const }],
      "thinking about the plan step by step and then deciding",
      "reasoning",
    )
    expect(summaryHit?.node.id).toBe("summary-node")
    expect(summaryHit?.confidence).toBe("likely")

    expect(matchPartCandidate(
      [{ node: renderNode("tool-node", []).withContent("short"), text: "short", kind: "text" as const }],
      "short",
      "tool",
      "bash",
    )).toBeUndefined()
  })

  test("findTargetWithScroll locates a target and its scrolling ancestor", () => {
    const scroll = {
      ...renderNode("scroll", [renderNode("target", [], 5)]),
      scrollBy() {},
    }
    const hit = findTargetWithScroll(renderNode("root", [scroll]), "target")
    expect(hit?.target.id).toBe("target")
    expect(hit?.scroll.id).toBe("scroll")
    expect(findTargetWithScroll(renderNode("root"), "missing")).toBeUndefined()
  })
})

function previewPart(id: string, messageID: string, role: ConversationPreviewPart["role"], type: ConversationPreviewPart["type"]): ConversationPreviewPart {
  return {
    id,
    messageID,
    sessionID: "ses_1",
    role,
    type,
    timeCreated: 1,
    text: "text",
    target: id.includes("thought") || id.includes("tool"),
  }
}

function renderNode(id: string, children: unknown[] = [], y = 0) {
  return {
    id,
    y,
    getChildren: () => children,
    withContent(content: string) {
      return { ...this, content }
    },
    withPlainText(plainText: string) {
      return { ...this, plainText }
    },
    withDiff(diff: string) {
      return { ...this, diff }
    },
  }
}

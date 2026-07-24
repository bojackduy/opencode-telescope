import { describe, expect, test } from "bun:test"
import { findRenderableByID, jumpTargetIDs, messageTargetID, previewPartTargetID, previewScrollAmount, scrollPreviewToTarget } from "./render-target.ts"
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

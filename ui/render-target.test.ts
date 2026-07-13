import { describe, expect, test } from "bun:test"
import { findRenderableByID, messageTargetID, previewScrollAmount } from "./render-target.ts"
import type { SearchResult } from "../search.ts"

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
})

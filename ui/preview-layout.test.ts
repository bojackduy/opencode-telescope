import { describe, expect, test } from "bun:test"
import { buildPreviewLayout, ensurePreviewWindowIncludesTarget, estimatePreviewPartHeight, mergePreviewParts, previewWindowForLayout } from "./preview-layout.ts"
import type { ConversationPreviewPart } from "../search.ts"

describe("preview layout", () => {
  test("estimatePreviewPartHeight is width aware", () => {
    const text = "word ".repeat(300)
    const part = previewPart("prt_1", "assistant", "text", text)
    expect(estimatePreviewPartHeight(part, 60)).toBeGreaterThan(estimatePreviewPartHeight(part, 160))
    expect(estimatePreviewPartHeight(part, 60)).toBeLessThanOrEqual(90)
    expect(estimatePreviewPartHeight(previewPart("prt_2", "assistant", "text", "short"), 40)).toBe(3)
  })

  test("estimatePreviewPartHeight handles tool and reasoning parts", () => {
    const tool = previewPart("prt_tool", "assistant", "tool", "", "write", true)
    expect(estimatePreviewPartHeight(tool, 40)).toBe(40)
    const patch = previewPart("prt_patch", "assistant", "tool", "", "apply_patch", true)
    expect(estimatePreviewPartHeight(patch, 40)).toBe(35)
    const compact = previewPart("prt_compact", "assistant", "tool", "", "bash", true)
    expect(estimatePreviewPartHeight(compact, 40)).toBe(2)
    const reasoning = previewPart("prt_thought", "assistant", "reasoning", "word ".repeat(200))
    expect(estimatePreviewPartHeight(reasoning, 40)).toBeLessThanOrEqual(24)
  })

  test("buildPreviewLayout accumulates heights and previewWindowForLayout windows", () => {
    const parts = [previewPart("a", "user", "text", "x"), previewPart("b", "assistant", "text", "y"), previewPart("c", "assistant", "text", "z")]
    const layout = buildPreviewLayout(parts, () => 10)
    expect(layout.map((row) => row.top)).toEqual([0, 10, 20])
    const window = previewWindowForLayout(layout, 5, 10)
    expect(window.end).toBeGreaterThan(window.start)
  })

  test("mergePreviewParts dedupes overlapping pagination pages", () => {
    const prev = [previewPart("b", "assistant", "text", "b"), previewPart("c", "assistant", "text", "c")]
    const next = [previewPart("a", "assistant", "text", "a"), previewPart("b", "assistant", "text", "b")]
    expect(mergePreviewParts(prev, next).map((part) => part.id)).toEqual(["a", "b", "c"])
    expect(mergePreviewParts(prev, [previewPart("c", "assistant", "text", "c")])).toBe(prev)
  })

  test("ensurePreviewWindowIncludesTarget pins the selected part", () => {
    const parts = Array.from({ length: 20 }, (_, index) => previewPart(`prt_${index}`, "assistant", "text", "x"))
    const layout = buildPreviewLayout(parts, () => 10)
    const window = { start: 10, end: 15 }
    expect(ensurePreviewWindowIncludesTarget(window, layout, "prt_2")).toEqual({ start: 2, end: 15 })
    expect(ensurePreviewWindowIncludesTarget(window, layout, "prt_12")).toBe(window)
    expect(ensurePreviewWindowIncludesTarget(window, layout, "missing")).toBe(window)
  })
})

function previewPart(id: string, role: ConversationPreviewPart["role"], type: ConversationPreviewPart["type"], text: string, tool?: string, target = false): ConversationPreviewPart {
  return {
    id,
    messageID: "msg_1",
    sessionID: "ses_1",
    role,
    type,
    timeCreated: 1,
    text,
    tool,
    target,
  }
}

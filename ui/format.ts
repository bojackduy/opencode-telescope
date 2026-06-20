import { SyntaxStyle } from "@opentui/core"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { SearchResult } from "../search.ts"

export function compactTime(time: number) {
  const date = new Date(time)
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
}

export function roleLabel(role: SearchResult["role"]) {
  return role === "assistant" ? "assistant" : "you"
}

export function roleColor(role: SearchResult["role"], theme: TuiThemeCurrent) {
  return role === "assistant" ? theme.info : theme.primary
}

export function reasoningSummary(text: string) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean)
  const title = lines[0] ? truncate(lines[0].replace(/^#+\s*/, ""), 90) : null
  return {
    title,
    body: lines.slice(1).join("\n").trim(),
  }
}

export function toolIcon(tool: string | undefined) {
  if (tool === "bash") return "$"
  if (tool === "read") return "R"
  if (tool === "grep") return "G"
  if (tool === "glob") return "*"
  if (tool === "write" || tool === "edit" || tool === "apply_patch") return "W"
  if (tool === "task") return "T"
  if (tool === "todowrite") return "☑"
  if (tool === "webfetch" || tool === "websearch") return "@"
  if (tool === "skill") return "S"
  if (tool === "question") return "?"
  return "⚙"
}

export function toolLabel(tool: string | undefined) {
  return tool ?? "tool"
}

export function toolInputSummary(input: unknown) {
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  const value = record.command ?? record.filePath ?? record.pattern ?? record.url ?? record.description ?? record.name
  if (typeof value === "string") return truncate(value.replace(/\s+/g, " "), 90)
  return truncate(JSON.stringify(record), 90)
}

export function markdownWithMatch(before: string, match: string, after: string, highlight: boolean) {
  if (!match || !highlight) return `${before}${match}${after}`
  return `${before}**${escapeMarkdownInline(match)}**${after}`
}

export function syntaxStyle(theme: TuiThemeCurrent) {
  return SyntaxStyle.fromTheme([
    { scope: ["default"], style: { foreground: theme.text } },
    { scope: ["comment", "comment.documentation"], style: { foreground: theme.syntaxComment, italic: true } },
    { scope: ["string", "symbol", "character", "character.special"], style: { foreground: theme.syntaxString } },
    { scope: ["number", "boolean", "float", "constant"], style: { foreground: theme.syntaxNumber } },
    { scope: ["keyword.return", "keyword.conditional", "keyword.repeat", "keyword.coroutine", "keyword", "keyword.directive", "keyword.modifier", "keyword.exception"], style: { foreground: theme.syntaxKeyword, italic: true } },
    { scope: ["keyword.type"], style: { foreground: theme.syntaxType, bold: true, italic: true } },
    { scope: ["keyword.import", "keyword.export", "tag.attribute"], style: { foreground: theme.syntaxKeyword } },
    { scope: ["keyword.function", "function.method", "variable.member", "function", "constructor"], style: { foreground: theme.syntaxFunction } },
    { scope: ["operator", "keyword.operator", "punctuation.delimiter", "keyword.conditional.ternary", "punctuation.special", "tag.delimiter"], style: { foreground: theme.syntaxOperator } },
    { scope: ["variable", "variable.parameter", "function.method.call", "function.call", "property", "parameter", "field"], style: { foreground: theme.syntaxVariable } },
    { scope: ["type", "module", "class", "namespace"], style: { foreground: theme.syntaxType } },
    { scope: ["punctuation", "punctuation.bracket"], style: { foreground: theme.syntaxPunctuation } },
    { scope: ["variable.builtin", "type.builtin", "function.builtin", "module.builtin", "constant.builtin", "variable.super", "tag"], style: { foreground: theme.error } },
    { scope: ["string.escape", "string.regexp"], style: { foreground: theme.syntaxKeyword } },
    { scope: ["markup.heading"], style: { foreground: theme.markdownHeading, bold: true } },
    { scope: ["markup.heading.1"], style: { foreground: theme.markdownHeading, bold: true, underline: true } },
    { scope: ["markup.bold", "markup.strong"], style: { foreground: theme.markdownStrong, bold: true } },
    { scope: ["markup.italic"], style: { foreground: theme.markdownEmph, italic: true } },
    { scope: ["markup.list"], style: { foreground: theme.markdownListItem } },
    { scope: ["markup.quote"], style: { foreground: theme.markdownBlockQuote, italic: true } },
    { scope: ["markup.raw", "markup.raw.block"], style: { foreground: theme.markdownCode } },
    { scope: ["markup.raw.inline"], style: { foreground: theme.markdownCode, background: theme.background } },
    { scope: ["markup.link", "markup.link.url", "string.special", "string.special.url"], style: { foreground: theme.markdownLink, underline: true } },
    { scope: ["markup.link.label", "label"], style: { foreground: theme.markdownLinkText, underline: true } },
    { scope: ["spell", "nospell", "markup.underline"], style: { foreground: theme.text } },
    { scope: ["conceal", "markup.strikethrough", "markup.list.unchecked", "debug"], style: { foreground: theme.textMuted } },
    { scope: ["comment.error", "error"], style: { foreground: theme.error, italic: true, bold: true } },
    { scope: ["comment.warning", "warning"], style: { foreground: theme.warning, italic: true, bold: true } },
    { scope: ["comment.todo", "comment.note"], style: { foreground: theme.info, italic: true, bold: true } },
    { scope: ["type.definition"], style: { foreground: theme.syntaxType, bold: true } },
    { scope: ["attribute", "annotation"], style: { foreground: theme.warning } },
    { scope: ["markup.list.checked"], style: { foreground: theme.success } },
    { scope: ["diff.plus"], style: { foreground: theme.diffAdded, background: theme.diffAddedBg } },
    { scope: ["diff.minus"], style: { foreground: theme.diffRemoved, background: theme.diffRemovedBg } },
    { scope: ["diff.delta"], style: { foreground: theme.diffContext, background: theme.diffContextBg } },
    { scope: ["info"], style: { foreground: theme.info } },
  ])
}

export function truncate(value: string, length: number) {
  if (value.length <= length) return value
  return `${value.slice(0, length - 1)}…`
}

function escapeMarkdownInline(value: string) {
  return value.replace(/[\\*_`[\]]/g, "\\$&")
}

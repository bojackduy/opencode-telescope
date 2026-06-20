/** @jsxImportSource @opentui/solid */
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { SyntaxStyle } from "@opentui/core"
import { For, Show, createMemo } from "solid-js"
import type { ConversationPreviewPart, SearchResult } from "../search.ts"
import {
  compactTime,
  markdownWithMatch,
  reasoningSummary,
  roleColor,
  roleLabel,
  toolIcon,
  toolInputSummary,
  toolLabel,
  truncate,
} from "../ui/format.ts"

export const PreviewHeader = (props: { item: SearchResult | undefined; query: string; theme: TuiThemeCurrent }) => (
  <box
    paddingLeft={1}
    paddingRight={1}
    height={props.query.trim() ? 3 : 2}
    flexDirection="column"
    backgroundColor={props.theme.backgroundPanel}
    flexShrink={0}
  >
    <Show when={props.item} fallback={<text fg={props.theme.textMuted}>Select a hit to preview the exact matched message.</text>}>
      {(item) => (
        <>
          <box width="100%" flexShrink={0}>
            <text fg={props.theme.text} wrapMode="none" overflow="hidden">
              <span style={{ fg: roleColor(item().role, props.theme), bold: true }}>{roleLabel(item().role)}</span>
              <span style={{ fg: props.theme.textMuted }}> · {compactTime(item().timeCreated)}</span>
              <span style={{ fg: props.theme.textMuted }}> · </span>
              <span>{item().sessionTitle}</span>
            </text>
          </box>
          <Show when={props.query.trim()}>
            <box width="100%" flexShrink={0}>
              <text fg={props.theme.textMuted} wrapMode="none" overflow="hidden">match: {props.query.trim()}</text>
            </box>
          </Show>
        </>
      )}
    </Show>
  </box>
)

export const ConversationPreview = (props: { item: SearchResult; parts: ConversationPreviewPart[]; syntax: SyntaxStyle; theme: TuiThemeCurrent }) => (
  <box flexDirection="column" paddingTop={1}>
    <Show when={props.parts.length > 0} fallback={<ConversationFallback item={props.item} syntax={props.syntax} theme={props.theme} />}>
      <For each={props.parts}>
        {(part) => (
          <PreviewConversationPart part={part} item={props.item} syntax={props.syntax} theme={props.theme} />
        )}
      </For>
    </Show>
  </box>
)

const PreviewConversationPart = (props: { part: ConversationPreviewPart; item: SearchResult; syntax: SyntaxStyle; theme: TuiThemeCurrent }) => {
  if (props.part.type === "tool") return <PreviewToolPart part={props.part} theme={props.theme} />
  if (props.part.type === "reasoning") return <PreviewReasoningPart part={props.part} syntax={props.syntax} theme={props.theme} />
  if (props.part.role === "assistant") return <PreviewAssistantPart part={props.part} item={props.item} syntax={props.syntax} theme={props.theme} />
  return <PreviewUserPart part={props.part} item={props.item} theme={props.theme} />
}

const PreviewUserPart = (props: { part: ConversationPreviewPart; item: SearchResult; theme: TuiThemeCurrent }) => (
  <box
    id={props.part.messageID}
    border={["left"]}
    borderColor={props.part.target ? props.theme.warning : props.theme.primary}
    customBorderChars={splitBorderChars}
    marginTop={1}
  >
    <box paddingTop={1} paddingBottom={1} paddingLeft={2} backgroundColor={props.theme.backgroundPanel} flexDirection="column">
      <text fg={props.theme.textMuted}>you · {compactTime(props.part.timeCreated)}</text>
      <HighlightedConversationText part={props.part} item={props.item} theme={props.theme} />
    </box>
  </box>
)

const PreviewAssistantPart = (props: { part: ConversationPreviewPart; item: SearchResult; syntax: SyntaxStyle; theme: TuiThemeCurrent }) => (
  <box id={`text-${props.part.messageID}-${props.part.id}`} paddingLeft={3} marginTop={1} flexShrink={0} flexDirection="column">
    <Show when={props.part.target}>
      <TargetMarker part={props.part} item={props.item} role="assistant" time={props.part.timeCreated} theme={props.theme} />
    </Show>
    <markdown
      syntaxStyle={props.syntax}
      streaming={true}
      internalBlockMode="top-level"
      content={conversationMarkdown(props.part, props.item)}
      tableOptions={{ style: "grid" }}
      fg={props.theme.markdownText}
      bg={props.theme.background}
    />
  </box>
)

const PreviewReasoningPart = (props: { part: ConversationPreviewPart; syntax: SyntaxStyle; theme: TuiThemeCurrent }) => {
  const summary = createMemo(() => reasoningSummary(props.part.text.replace("[REDACTED]", "").trim()))
  return (
    <Show when={summary().title || summary().body}>
      <box id={`text-${props.part.messageID}-${props.part.id}`} paddingLeft={3} marginTop={1} flexDirection="column" flexShrink={0}>
        <Show when={props.part.target}>
          <TargetMarker part={props.part} role="thought" time={props.part.timeCreated} theme={props.theme} />
        </Show>
        <text fg={props.theme.warning} wrapMode="none">
          <span>Thought</span>
          <Show when={summary().title}>
            <span>: {summary().title}</span>
          </Show>
        </text>
        <Show when={summary().body}>
          <box paddingLeft={2} marginTop={1}>
            <markdown
              syntaxStyle={props.syntax}
              streaming={true}
              internalBlockMode="top-level"
              content={summary().body}
              tableOptions={{ style: "grid" }}
              fg={props.theme.textMuted}
              bg={props.theme.background}
            />
          </box>
        </Show>
      </box>
    </Show>
  )
}

const PreviewToolPart = (props: { part: ConversationPreviewPart; theme: TuiThemeCurrent }) => {
  const status = createMemo(() => props.part.state?.status ?? "pending")
  const failed = createMemo(() => status() === "error")
  const color = createMemo(() => {
    if (failed()) return props.theme.error
    if (status() === "completed") return props.theme.textMuted
    return props.theme.text
  })
  return (
    <box id={`tool-inline-${props.part.messageID}-${props.part.id}`} paddingLeft={3} marginTop={1} flexDirection="column" flexShrink={0}>
      <Show when={props.part.target}>
        <TargetMarker part={props.part} role="tool" time={props.part.timeCreated} theme={props.theme} />
      </Show>
      <text fg={color()} wrapMode="none" overflow="hidden">
        <span style={{ fg: failed() ? props.theme.error : props.theme.textMuted }}>{toolIcon(props.part.tool)} </span>
        <span>{toolLabel(props.part.tool)}</span>
        <span style={{ fg: props.theme.textMuted }}> {toolInputSummary(props.part.state?.input)}</span>
        <span style={{ fg: props.theme.textMuted }}> · {status()}</span>
      </text>
      <Show when={props.part.state?.error}>
        {(error) => <text fg={props.theme.error}>{error()}</text>}
      </Show>
      <Show when={failed() ? props.part.state?.output : undefined}>
        {(output) => <text fg={props.theme.textMuted}>{truncate(output().trim(), 300)}</text>}
      </Show>
    </box>
  )
}

const TargetMarker = (props: { part: ConversationPreviewPart; item?: SearchResult; role: string; time: number; theme: TuiThemeCurrent }) => (
  <box flexDirection="column" flexShrink={0}>
    <text fg={props.theme.warning} wrapMode="none" overflow="hidden">
      <span>match</span>
      <span style={{ fg: props.theme.textMuted }}> · {props.role} · {compactTime(props.time)}</span>
    </text>
    <Show when={props.item && matchExcerpt(props.part.text, props.item.match)}>
      {(excerpt) => (
        <text fg={props.theme.textMuted} wrapMode="none" overflow="hidden">
          <span>{excerpt().before}</span>
          <span style={{ fg: props.theme.warning, bold: true }}>{excerpt().match}</span>
          <span>{excerpt().after}</span>
        </text>
      )}
    </Show>
  </box>
)

const HighlightedConversationText = (props: { part: ConversationPreviewPart; item: SearchResult; theme: TuiThemeCurrent }) => {
  const match = createMemo(() => conversationMatch(props.part, props.item))
  return (
    <Show when={match()} fallback={<text fg={props.theme.text}>{props.part.text}</text>}>
      {(hit) => (
        <text fg={props.theme.text}>
          <span>{props.part.text.slice(0, hit().start)}</span>
          <span style={{ fg: props.theme.warning, bold: true }}>{props.part.text.slice(hit().start, hit().end)}</span>
          <span>{props.part.text.slice(hit().end)}</span>
        </text>
      )}
    </Show>
  )
}

const ConversationFallback = (props: { item: SearchResult; syntax: SyntaxStyle; theme: TuiThemeCurrent }) => (
  <Show
    when={props.item.role === "assistant"}
    fallback={<PreviewUserPart part={searchResultPreviewPart(props.item)} item={props.item} theme={props.theme} />}
  >
    <PreviewAssistantPart part={searchResultPreviewPart(props.item)} item={props.item} syntax={props.syntax} theme={props.theme} />
  </Show>
)

const splitBorderChars = {
  topLeft: "",
  bottomLeft: "",
  vertical: "┃",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

function searchResultPreviewPart(item: SearchResult): ConversationPreviewPart {
  return {
    id: item.id,
    messageID: item.messageID,
    sessionID: item.sessionID,
    role: item.role,
    type: "text",
    timeCreated: item.timeCreated,
    text: item.text,
    target: true,
  }
}

function conversationMatch(part: ConversationPreviewPart, item: SearchResult) {
  if (!part.target) return
  const index = part.text.toLowerCase().indexOf(item.match.toLowerCase())
  if (index === -1 || !item.match) return
  return { start: index, end: index + item.match.length }
}

function conversationMarkdown(part: ConversationPreviewPart, item: SearchResult) {
  const hit = conversationMatch(part, item)
  if (!hit || !item.previewHighlight) return part.text
  return markdownWithMatch(part.text.slice(0, hit.start), part.text.slice(hit.start, hit.end), part.text.slice(hit.end), true)
}

function matchExcerpt(text: string, query: string, radius = 80) {
  const needle = query.trim()
  if (!needle) return
  const start = text.toLowerCase().indexOf(needle.toLowerCase())
  if (start === -1) return
  const end = start + needle.length
  const beforeStart = Math.max(0, start - radius)
  const afterEnd = Math.min(text.length, end + radius)
  return {
    before: `${beforeStart > 0 ? "..." : ""}${text.slice(beforeStart, start).replace(/\s+/g, " ")}`,
    match: text.slice(start, end),
    after: `${text.slice(end, afterEnd).replace(/\s+/g, " ")}${afterEnd < text.length ? "..." : ""}`,
  }
}

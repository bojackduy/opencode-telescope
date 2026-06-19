/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { SyntaxStyle, type InputRenderable, type ParsedKey, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import {
  loadConversationWindow,
  recentSessionMessages,
  resolveDatabasePath,
  searchSessionMessages,
  type ConversationPreviewPart,
  type SearchResult,
} from "./search.ts"

export const Telescope = (props: { api: TuiPluginApi; onClose: () => void }) => {
  const dimensions = useTerminalDimensions()
  const [query, setQuery] = createSignal("")
  const [results, setResults] = createSignal<SearchResult[]>([])
  const [previewParts, setPreviewParts] = createSignal<ConversationPreviewPart[]>([])
  const [selected, setSelected] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  let input: InputRenderable | undefined
  let resultScroll: ScrollBoxRenderable | undefined
  let previewScroll: ScrollBoxRenderable | undefined

  const theme = createMemo(() => props.api.theme.current)
  const syntax = createMemo(() => syntaxStyle(theme()))
  const selectedResult = createMemo(() => results()[selected()])
  const popupWidth = createMemo(() => Math.max(72, Math.min(dimensions().width - 2, Math.floor(dimensions().width * 0.92))))
  const leftWidth = createMemo(() => Math.max(36, Math.min(64, Math.floor(popupWidth() * 0.36))))
  const height = createMemo(() => Math.max(18, dimensions().height - 8))
  const verticalOffset = createMemo(() => Math.floor(dimensions().height / 4 - height() / 2) - 2)
  const dbPath = resolveDatabasePath()
  const directory = props.api.state.path.directory

  createEffect(() => {
    setTimeout(() => input?.focus(), 1)
  })

  createEffect(() => {
    const q = query().trim()
    setError("")
    if (!q) {
      try {
        setResults(recentSessionMessages({ limit: 40, dbPath, directory }))
      } catch (err) {
        setResults([])
        setError(err instanceof Error ? err.message : String(err))
      }
      setSelected(0)
      return
    }
    setBusy(true)
    const timer = setTimeout(() => {
      try {
        setResults(searchSessionMessages(q, { limit: 120, dbPath, directory }))
        setSelected(0)
      } catch (err) {
        setResults([])
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    }, 180)
    onCleanup(() => clearTimeout(timer))
  })

  const move = (delta: number) => {
    if (results().length === 0) return
    setSelected((index) => (index + delta + results().length) % results().length)
  }

  createEffect(() => {
    const index = selected()
    const row = resultScroll?.getChildren()[index]
    if (!resultScroll || !row) return
    const y = row.y - resultScroll.y
    if (y < 0) {
      resultScroll.scrollBy(y)
      return
    }
    if (y + row.height >= resultScroll.height) {
      resultScroll.scrollBy(y + row.height - resultScroll.height + 1)
    }
  })

  createEffect(() => {
    const item = selectedResult()
    if (!item) {
      setPreviewParts([])
      return
    }
    try {
      setPreviewParts(loadConversationWindow(item, { before: 12, after: 24, dbPath }))
    } catch {
      setPreviewParts([])
    }
  })

  createEffect(() => {
    const item = selectedResult()
    previewParts()
    if (!item) return
    setTimeout(() => scrollPreviewToTarget(previewScroll, previewTargetID(item)), 1)
  })

  const open = () => {
    const item = selectedResult()
    if (!item) return
    const targetID = renderTargetID(item)
    props.api.ui.dialog.clear()
    props.api.route.navigate("session", { sessionID: item.sessionID })
    jumpToRenderedTarget(props.api.renderer.root, targetID)
  }

  const scrollPreview = (direction: 1 | -1, evt: ParsedKey) => {
    prevent(evt)
    previewScroll?.scrollBy(direction * previewScrollAmount(previewScroll))
  }

  useKeyboard((evt) => {
    if (!props.api.ui.dialog.open) return
    if (isKey(evt, "escape", "esc") || (evt.ctrl && isKey(evt, "c"))) {
      prevent(evt)
      props.onClose()
      return
    }
    if (isKey(evt, "down") || (evt.ctrl && isKey(evt, "j"))) {
      prevent(evt)
      move(1)
      return
    }
    if (isKey(evt, "up") || (evt.ctrl && isKey(evt, "k"))) {
      prevent(evt)
      move(-1)
      return
    }
    if (isKey(evt, "enter", "return")) {
      prevent(evt)
      open()
      return
    }
    if (evt.ctrl && isKey(evt, "d")) {
      scrollPreview(1, evt)
      return
    }
    if (evt.ctrl && isKey(evt, "u")) {
      scrollPreview(-1, evt)
      return
    }
  })

  return (
    <box width="100%" alignItems="center">
    <box
      flexDirection="column"
      width={popupWidth()}
      height={height()}
      marginTop={verticalOffset()}
      border
      borderStyle="rounded"
      borderColor={theme().border}
      backgroundColor={theme().backgroundPanel}
    >
        <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={2} flexShrink={0}>
          <box
            flexDirection="row"
            gap={1}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={1}
            paddingBottom={1}
            border
            borderStyle="rounded"
            borderColor={theme().borderActive}
            backgroundColor={theme().backgroundElement}
            flexShrink={0}
          >
            <text fg={theme().accent}>search</text>
            <text fg={theme().textMuted}>›</text>
            <input
              ref={(element: InputRenderable) => (input = element)}
              placeholder="grep conversations..."
              placeholderColor={theme().textMuted}
              cursorColor={theme().primary}
              focusedTextColor={theme().text}
              focusedBackgroundColor={theme().backgroundElement}
              onInput={(value) => setQuery(value)}
              onKeyDown={(evt: ParsedKey) => {
                if (evt.ctrl && isKey(evt, "d")) {
                  scrollPreview(1, evt)
                  return
                }
                if (evt.ctrl && isKey(evt, "u")) scrollPreview(-1, evt)
              }}
              flexGrow={1}
            />
            <text fg={theme().textMuted}>{busy() ? "searching" : query().trim() ? `${results().length} hits` : `${results().length} recent`}</text>
          </box>
        </box>

        <box flexDirection="row" flexGrow={1} minHeight={0}>
          <box width={leftWidth()} flexDirection="column" minHeight={0} border={["right"]} borderColor={theme().border}>
            <scrollbox ref={(element: ScrollBoxRenderable) => (resultScroll = element)} flexGrow={1} minHeight={0} verticalScrollbarOptions={{ visible: false }}>
              <Show
                when={!error()}
                fallback={
                  <box flexDirection="column" paddingLeft={1} paddingTop={1}>
                    <text fg={theme().error}>database search failed</text>
                    <text fg={theme().textMuted}>{error()}</text>
                  </box>
                }
              >
                <Show when={results().length > 0} fallback={<EmptyState query={query()} theme={theme()} />}>
                  <For each={results()}>
                    {(item, index) => (
                      <ResultRow
                        item={item}
                        active={index() === selected()}
                        width={leftWidth()}
                        query={query()}
                        theme={theme()}
                        onMouseOver={() => setSelected(index())}
                        onOpen={open}
                      />
                    )}
                  </For>
                </Show>
              </Show>
            </scrollbox>
          </box>

          <box flexGrow={1} flexDirection="column" minHeight={0}>
            <PreviewHeader item={selectedResult()} query={query()} theme={theme()} />
            <scrollbox ref={(element: ScrollBoxRenderable) => (previewScroll = element)} flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1} verticalScrollbarOptions={{ visible: true }}>
              <Show when={selectedResult()} fallback={<text fg={theme().textMuted}>Select a hit to preview the exact matched message.</text>}>
                {(item) => <ConversationPreview item={item()} parts={previewParts()} syntax={syntax()} theme={theme()} />}
              </Show>
            </scrollbox>
          </box>
        </box>

        <box paddingLeft={1} paddingRight={1} flexDirection="row" gap={2} border={["top"]} borderColor={theme().border}>
          <text fg={theme().textMuted}>^J/^K move</text>
          <text fg={theme().textMuted}>^D/^U preview</text>
          <text fg={theme().textMuted}>enter open session</text>
          <text fg={theme().textMuted}>esc close</text>
        </box>
    </box>
    </box>
  )
}

const ResultRow = (props: {
  item: SearchResult
  active: boolean
  width: number
  query: string
  theme: TuiThemeCurrent
  onMouseOver: () => void
  onOpen: () => void
}) => (
  <box
    flexDirection="column"
    paddingLeft={1}
    paddingRight={1}
    paddingTop={0}
    paddingBottom={0}
    border={["bottom"]}
    borderColor={props.theme.borderSubtle}
    backgroundColor={props.active ? props.theme.backgroundElement : undefined}
    onMouseOver={props.onMouseOver}
    onMouseUp={props.onOpen}
  >
    <text wrapMode="none" overflow="hidden">
      <span style={{ fg: props.active ? props.theme.accent : props.theme.text, bold: true }}>
        {truncate(props.item.sessionTitle, sessionTitleWidth(props.width))}
      </span>
      <Show when={props.width >= 48}>
        <span style={{ fg: props.theme.textMuted }}>  </span>
        <span style={{ fg: roleColor(props.item.role, props.theme), bold: true }}>{roleLabel(props.item.role)}</span>
        <span style={{ fg: props.theme.textMuted }}> · {compactTime(props.item.timeCreated)}</span>
      </Show>
    </text>
    <Show when={props.width < 48}>
      <text wrapMode="none" overflow="hidden">
        <span style={{ fg: roleColor(props.item.role, props.theme), bold: true }}>{roleLabel(props.item.role)}</span>
        <span style={{ fg: props.theme.textMuted }}> · {compactTime(props.item.timeCreated)}</span>
      </text>
    </Show>
    <HighlightedText
      before={props.item.before}
      match={props.item.match}
      after={props.item.after}
      query={props.query}
      active={props.active}
      theme={props.theme}
    />
  </box>
)

const PreviewHeader = (props: { item: SearchResult | undefined; query: string; theme: TuiThemeCurrent }) => (
  <box paddingLeft={1} paddingRight={1} paddingBottom={1} flexDirection="column" border={["bottom"]} borderColor={props.theme.border}>
    <Show when={props.item} fallback={<text fg={props.theme.textMuted}>Select a hit to preview the exact matched message.</text>}>
      {(item) => (
        <>
          <text fg={props.theme.text} wrapMode="none" overflow="hidden">
            <span style={{ fg: roleColor(item().role, props.theme), bold: true }}>{roleLabel(item().role)}</span>
            <span style={{ fg: props.theme.textMuted }}> · {compactTime(item().timeCreated)}</span>
            <span style={{ fg: props.theme.textMuted }}> · </span>
            <span>{item().sessionTitle}</span>
          </text>
          <Show when={props.query.trim()}>
            <text fg={props.theme.textMuted} wrapMode="none" overflow="hidden">match: {props.query.trim()}</text>
          </Show>
        </>
      )}
    </Show>
  </box>
)

const HighlightedText = (props: {
  before: string
  match: string
  after: string
  query: string
  active: boolean
  theme: TuiThemeCurrent
}) => (
  <text wrapMode="none" overflow="hidden">
    <span style={{ fg: props.theme.textMuted }}>  </span>
    <span style={{ fg: props.active ? props.theme.text : props.theme.textMuted }}>{props.before}</span>
    <span style={{ fg: props.theme.warning, bold: true }}>{props.match || props.query}</span>
    <span style={{ fg: props.active ? props.theme.text : props.theme.textMuted }}>{props.after}</span>
  </text>
)

const ConversationPreview = (props: { item: SearchResult; parts: ConversationPreviewPart[]; syntax: SyntaxStyle; theme: TuiThemeCurrent }) => (
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
      <text fg={props.theme.warning}>matched assistant · {compactTime(props.part.timeCreated)}</text>
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
      <text fg={color()} wrapMode="none" overflow="hidden">
        <span style={{ fg: failed() ? props.theme.error : props.theme.textMuted }}>{toolIcon(props.part.tool)} </span>
        <span>{toolLabel(props.part.tool)}</span>
        <span style={{ fg: props.theme.textMuted }}> {toolInputSummary(props.part.state?.input)}</span>
        <span style={{ fg: props.theme.textMuted }}> · {status()}</span>
      </text>
      <Show when={props.part.state?.error}>
        {(error) => <text fg={props.theme.error}>{error()}</text>}
      </Show>
      <Show when={props.part.state?.output && failed()}>
        {(output) => <text fg={props.theme.textMuted}>{truncate(output().trim(), 300)}</text>}
      </Show>
    </box>
  )
}

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

const EmptyState = (props: { query: string; theme: TuiThemeCurrent }) => (
  <box paddingLeft={1} paddingTop={1}>
    <text fg={props.theme.textMuted}>{props.query.trim() ? "No matching user/assistant conversation text." : "No recent conversation text found."}</text>
  </box>
)

function compactTime(time: number) {
  const date = new Date(time)
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
}

function roleLabel(role: SearchResult["role"]) {
  return role === "assistant" ? "assistant" : "you"
}

function roleColor(role: SearchResult["role"], theme: TuiThemeCurrent) {
  return role === "assistant" ? theme.info : theme.primary
}

function sessionTitleWidth(width: number) {
  if (width >= 54) return 28
  if (width >= 48) return 22
  return Math.max(18, width - 4)
}

function previewScrollAmount(scroll: ScrollBoxRenderable | undefined) {
  return Math.max(1, Math.floor((scroll?.height || 10) / 8))
}

function previewTargetID(item: SearchResult) {
  if (item.role === "assistant") return `text-${item.messageID}-${item.id}`
  return item.messageID
}

function scrollPreviewToTarget(scroll: ScrollBoxRenderable | undefined, targetID: string) {
  if (!scroll) return
  const target = findRenderableByID(scroll, targetID)
  if (!target) return
  scroll.scrollBy(target.y - scroll.y - Math.max(1, Math.floor(scroll.height / 3)))
}

function renderTargetID(item: SearchResult) {
  if (item.role === "assistant") return `text-${item.messageID}-${item.id}`
  return item.messageID
}

function jumpToRenderedTarget(root: unknown, targetID: string) {
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

function reasoningSummary(text: string) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean)
  const title = lines[0] ? truncate(lines[0].replace(/^#+\s*/, ""), 90) : null
  return {
    title,
    body: lines.slice(1).join("\n").trim(),
  }
}

function toolIcon(tool: string | undefined) {
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

function toolLabel(tool: string | undefined) {
  return tool ?? "tool"
}

function toolInputSummary(input: unknown) {
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  const value = record.command ?? record.filePath ?? record.pattern ?? record.url ?? record.description ?? record.name
  if (typeof value === "string") return truncate(value.replace(/\s+/g, " "), 90)
  return truncate(JSON.stringify(record), 90)
}

function markdownWithMatch(before: string, match: string, after: string, highlight: boolean) {
  if (!match || !highlight) return `${before}${match}${after}`
  return `${before}**${escapeMarkdownInline(match)}**${after}`
}

function syntaxStyle(theme: TuiThemeCurrent) {
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

function escapeMarkdownInline(value: string) {
  return value.replace(/[\\*_`[\]]/g, "\\$&")
}

function truncate(value: string, length: number) {
  if (value.length <= length) return value
  return `${value.slice(0, length - 1)}…`
}

function isKey(evt: ParsedKey, ...names: string[]) {
  return names.includes(evt.name)
}

function prevent(evt: ParsedKey) {
  const controlled = evt as ParsedKey & {
    preventDefault?: () => void
    stopPropagation?: () => void
  }
  controlled.preventDefault?.()
  controlled.stopPropagation?.()
}

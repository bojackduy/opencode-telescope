/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { SyntaxStyle, type InputRenderable, type ParsedKey, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { recentSessionMessages, resolveDatabasePath, searchSessionMessages, type SearchResult } from "./search.ts"

export const Telescope = (props: { api: TuiPluginApi; onClose: () => void }) => {
  const dimensions = useTerminalDimensions()
  const [query, setQuery] = createSignal("")
  const [results, setResults] = createSignal<SearchResult[]>([])
  const [selected, setSelected] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  let input: InputRenderable | undefined
  let resultScroll: ScrollBoxRenderable | undefined
  let previewScroll: ScrollBoxRenderable | undefined

  const theme = createMemo(() => props.api.theme.current)
  const syntax = createMemo(() => syntaxStyle(theme()))
  const selectedResult = createMemo(() => results()[selected()])
  const leftWidth = createMemo(() => Math.max(34, Math.min(56, Math.floor(dimensions().width * 0.38))))
  const height = createMemo(() => Math.max(18, dimensions().height - 8))
  const verticalOffset = createMemo(() => Math.floor(dimensions().height / 4 - height() / 2))
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
    selectedResult()
    previewScroll?.scrollTo(0)
  })

  const open = () => {
    const item = selectedResult()
    if (!item) return
    props.api.ui.dialog.clear()
    props.api.route.navigate("session", { sessionID: item.sessionID })
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
  })

  return (
    <box
      flexDirection="column"
      width="100%"
      height={height()}
      marginTop={verticalOffset()}
      border
      borderStyle="rounded"
      borderColor={theme().border}
      backgroundColor={theme().backgroundPanel}
    >
        <box flexDirection="row" paddingLeft={1} paddingRight={1} gap={1} border={["bottom"]} borderColor={theme().border}>
          <text fg={theme().accent}>search sessions</text>
          <input
            ref={(element: InputRenderable) => (input = element)}
            placeholder="grep conversations..."
            placeholderColor={theme().textMuted}
            cursorColor={theme().primary}
            focusedTextColor={theme().text}
            focusedBackgroundColor={theme().backgroundPanel}
            onInput={(value) => setQuery(value)}
            flexGrow={1}
          />
          <text fg={theme().textMuted}>{busy() ? "searching" : query().trim() ? `${results().length} hits` : `${results().length} recent`}</text>
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
                {(item) => <SelectedPreview item={item()} syntax={syntax()} theme={theme()} />}
              </Show>
            </scrollbox>
          </box>
        </box>

        <box paddingLeft={1} paddingRight={1} flexDirection="row" gap={2} border={["top"]} borderColor={theme().border}>
          <text fg={theme().textMuted}>^J/^K move</text>
          <text fg={theme().textMuted}>enter open session</text>
          <text fg={theme().textMuted}>esc close</text>
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
          <text fg={props.theme.text} wrapMode="none" overflow="hidden">Session: {item().sessionTitle}</text>
          <text fg={props.theme.textMuted}>
            Author: {item().role} · Time: {formatTime(item().timeCreated)}
          </text>
          <text fg={props.theme.textMuted}>Query: {props.query.trim() || "recent messages"}</text>
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

const SelectedPreview = (props: { item: SearchResult; syntax: SyntaxStyle; theme: TuiThemeCurrent }) => (
  <box flexDirection="column" paddingTop={1}>
    <Show
      when={props.item.role === "assistant" && props.item.previewMode === "markdown"}
      fallback={
        <box
          border={props.item.role === "user" ? ["left"] : undefined}
          borderColor={props.item.role === "user" ? props.theme.primary : undefined}
          paddingLeft={props.item.role === "user" ? 2 : 0}
          paddingRight={1}
          backgroundColor={props.item.role === "user" ? props.theme.backgroundPanel : undefined}
        >
          <FocusedTextPreview
            before={props.item.previewBefore}
            match={props.item.previewMatch}
            after={props.item.previewAfter}
            theme={props.theme}
          />
        </box>
      }
    >
      <box paddingLeft={3} paddingRight={1}>
        <markdown
          syntaxStyle={props.syntax}
          content={markdownWithMatch(props.item.previewBefore, props.item.previewMatch, props.item.previewAfter, props.item.previewHighlight)}
          streaming={true}
          internalBlockMode="top-level"
          tableOptions={{ style: "grid" }}
          fg={props.theme.markdownText}
          bg={props.theme.background}
        />
      </box>
    </Show>
  </box>
)

const FocusedTextPreview = (props: { before: string; match: string; after: string; theme: TuiThemeCurrent }) => (
  <box flexDirection="column">
    <For each={splitPreviewLines(props.before, props.match, props.after)}>
      {(line) => (
        <text>
          <span style={{ fg: props.theme.markdownText }}>{line.before}</span>
          <span style={{ fg: props.theme.warning }}>{line.match}</span>
          <span style={{ fg: props.theme.markdownText }}>{line.after}</span>
        </text>
      )}
    </For>
  </box>
)

const EmptyState = (props: { query: string; theme: TuiThemeCurrent }) => (
  <box paddingLeft={1} paddingTop={1}>
    <text fg={props.theme.textMuted}>{props.query.trim() ? "No matching user/assistant conversation text." : "No recent conversation text found."}</text>
  </box>
)

function formatTime(time: number) {
  return new Date(time).toLocaleString()
}

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

function splitPreviewLines(before: string, match: string, after: string) {
  const combined = `${before}\u0000${match}\u0001${after}`
  return combined.split("\n").map((line) => {
    const matchStart = line.indexOf("\u0000")
    const matchEnd = line.indexOf("\u0001")
    if (matchStart === -1 || matchEnd === -1) return { before: line.replaceAll("\u0000", "").replaceAll("\u0001", ""), match: "", after: "" }
    return {
      before: line.slice(0, matchStart),
      match: line.slice(matchStart + 1, matchEnd),
      after: line.slice(matchEnd + 1),
    }
  })
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

/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { type InputRenderable, type ParsedKey } from "@opentui/core"
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

  const theme = createMemo(() => props.api.theme.current)
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
            <scrollbox flexGrow={1} minHeight={0} verticalScrollbarOptions={{ visible: false }}>
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
            <scrollbox flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1} verticalScrollbarOptions={{ visible: false }}>
              <Show when={selectedResult()} fallback={<text fg={theme().textMuted}>Select a hit to preview the exact matched message.</text>}>
                {(item) => <SelectedPreview item={item()} query={query()} theme={theme()} />}
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
  query: string
  theme: TuiThemeCurrent
  onMouseOver: () => void
  onOpen: () => void
}) => (
  <box
    flexDirection="column"
    paddingLeft={1}
    paddingRight={1}
    paddingTop={1}
    paddingBottom={1}
    border={["bottom"]}
    borderColor={props.theme.borderSubtle}
    backgroundColor={props.active ? props.theme.primary : undefined}
    onMouseOver={props.onMouseOver}
    onMouseUp={props.onOpen}
  >
    <text wrapMode="none" overflow="hidden">
      <span style={{ fg: props.active ? props.theme.selectedListItemText : props.theme.text }}>
        {truncate(props.item.sessionTitle, 42)}
      </span>
      <span style={{ fg: props.active ? props.theme.selectedListItemText : props.theme.textMuted }}>
        {"  "}{props.item.role} · {formatTime(props.item.timeCreated)}
      </span>
    </text>
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
    <span style={{ fg: props.active ? props.theme.selectedListItemText : props.theme.textMuted }}>{props.before}</span>
    <span style={{ fg: props.active ? props.theme.selectedListItemText : props.theme.warning }}>{props.match || props.query}</span>
    <span style={{ fg: props.active ? props.theme.selectedListItemText : props.theme.textMuted }}>{props.after}</span>
  </text>
)

const SelectedPreview = (props: { item: SearchResult; query: string; theme: TuiThemeCurrent }) => (
  <box flexDirection="column" paddingTop={1}>
    <text fg={props.theme.accent}>matched excerpt</text>
    <box paddingBottom={1} border={["bottom"]} borderColor={props.theme.borderSubtle}>
      <HighlightedText
        before={props.item.before}
        match={props.item.match}
        after={props.item.after}
        query={props.query}
        active={false}
        theme={props.theme}
      />
    </box>
    <text fg={props.theme.accent} marginTop={1}>selected message</text>
    <markdown
      content={props.item.text}
      internalBlockMode="top-level"
      tableOptions={{ style: "grid" }}
      fg={props.theme.markdownText}
      bg={props.theme.backgroundPanel}
    />
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

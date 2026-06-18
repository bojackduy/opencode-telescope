/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { type InputRenderable, type ParsedKey } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { loadMessageContext, recentSessionMessages, resolveDatabasePath, searchSessionMessages, type PreviewMessage, type SearchResult } from "./search.ts"

export const Telescope = (props: { api: TuiPluginApi; onClose: () => void }) => {
  const dimensions = useTerminalDimensions()
  const [query, setQuery] = createSignal("")
  const [results, setResults] = createSignal<SearchResult[]>([])
  const [selected, setSelected] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [preview, setPreview] = createSignal<PreviewMessage[]>([])
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

  createEffect(() => {
    const item = selectedResult()
    if (!item) {
      setPreview([])
      return
    }
    try {
      setPreview(loadMessageContext(item, { dbPath }))
    } catch {
      setPreview([{ id: item.id, messageID: item.messageID, role: item.role, text: item.text, match: true }])
    }
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
            <PreviewHeader item={selectedResult()} theme={theme()} />
            <scrollbox flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1} verticalScrollbarOptions={{ visible: false }}>
              <For each={preview()}>{(item) => <PreviewMessageRow item={item} theme={theme()} />}</For>
            </scrollbox>
          </box>
        </box>

        <box paddingLeft={1} paddingRight={1} flexDirection="row" gap={2} border={["top"]} borderColor={theme().border}>
          <text fg={theme().textMuted}>^J/^K move</text>
          <text fg={theme().textMuted}>enter jump to session</text>
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
    backgroundColor={props.active ? props.theme.primary : undefined}
    onMouseOver={props.onMouseOver}
    onMouseUp={props.onOpen}
  >
    <text fg={props.active ? props.theme.selectedListItemText : props.theme.accent} wrapMode="none" overflow="hidden">
      {props.item.sessionTitle}
    </text>
    <text fg={props.active ? props.theme.selectedListItemText : props.theme.textMuted} wrapMode="none">
      [{props.item.role}] {formatTime(props.item.timeCreated)}
    </text>
    <HighlightedText
      text={props.item.snippet}
      query={props.query}
      active={props.active}
      theme={props.theme}
    />
  </box>
)

const PreviewHeader = (props: { item: SearchResult | undefined; theme: TuiThemeCurrent }) => (
  <box paddingLeft={1} paddingRight={1} flexDirection="column">
    <Show when={props.item} fallback={<text fg={props.theme.textMuted}>Select a hit to preview the conversation.</text>}>
      {(item) => (
        <>
          <text fg={props.theme.accent}>{item().sessionTitle}</text>
          <text fg={props.theme.textMuted}>
            [{item().role}] {formatTime(item().timeCreated)} · {item().messageID}
          </text>
        </>
      )}
    </Show>
  </box>
)

const HighlightedText = (props: { text: string; query: string; active: boolean; theme: TuiThemeCurrent }) => {
  const parts = createMemo(() => splitMatch(props.text, props.query))
  return (
    <text wrapMode="none" overflow="hidden">
      <For each={parts()}>
        {(part) => (
          <span
            style={{
              fg: props.active
                ? props.theme.selectedListItemText
                : part.match
                  ? props.theme.warning
                  : props.theme.textMuted,
            }}
          >
            {part.text}
          </span>
        )}
      </For>
    </text>
  )
}

const PreviewMessageRow = (props: { item: PreviewMessage; theme: TuiThemeCurrent }) => (
  <box
    flexDirection="column"
    paddingTop={1}
    paddingLeft={props.item.match ? 1 : 0}
    border={props.item.match ? ["left"] : undefined}
    borderColor={props.item.match ? props.theme.warning : undefined}
  >
    <text fg={props.item.match ? props.theme.warning : props.theme.textMuted}>
      {props.item.match ? "match · " : ""}{props.item.role}
    </text>
    <markdown
      content={props.item.text.trim()}
      internalBlockMode="top-level"
      tableOptions={{ style: "grid" }}
      fg={props.item.match ? props.theme.markdownText : props.theme.textMuted}
      bg={props.theme.backgroundPanel}
    />
  </box>
)

const EmptyState = (props: { query: string; theme: TuiThemeCurrent }) => (
  <box paddingLeft={1} paddingTop={1}>
    <text fg={props.theme.textMuted}>{props.query.trim() ? "No matching user/assistant conversation text." : "No recent conversation text found."}</text>
  </box>
)

function splitMatch(text: string, query: string) {
  const needle = query.trim()
  if (!needle) return [{ text, match: false }]
  const index = text.toLowerCase().indexOf(needle.toLowerCase())
  if (index === -1) return [{ text, match: false }]
  return [
    { text: text.slice(0, index), match: false },
    { text: text.slice(index, index + needle.length), match: true },
    { text: text.slice(index + needle.length), match: false },
  ].filter((part) => part.text.length > 0)
}

function formatTime(time: number) {
  return new Date(time).toLocaleString()
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

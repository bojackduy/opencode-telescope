/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { InputRenderable, ParsedKey, ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { ConversationPreview, PreviewHeader } from "./components/preview.tsx"
import { EmptyState, ResultRow } from "./components/result-list.tsx"
import {
  loadConversationWindow,
  recentSessionMessages,
  resolveDatabasePath,
  searchSessionMessages,
  type ConversationPreviewPart,
  type SearchResult,
} from "./search.ts"
import { syntaxStyle } from "./ui/format.ts"
import { isKey, prevent } from "./ui/keyboard.ts"
import { jumpToRenderedTarget, messageTargetID, previewScrollAmount, scrollPreviewToTarget } from "./ui/render-target.ts"

export const Telescope = (props: { api: TuiPluginApi; onClose: () => void }) => {
  const dimensions = useTerminalDimensions()
  const [query, setQuery] = createSignal("")
  const [results, setResults] = createSignal<SearchResult[]>([])
  const [previewParts, setPreviewParts] = createSignal<ConversationPreviewPart[]>([])
  const [selected, setSelected] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [mode, setMode] = createSignal<"normal" | "insert">("normal")
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
  const dbPath = createMemo(() => resolveDatabasePath())
  const directory = props.api.state.path.directory

  createEffect(() => {
    const q = query().trim()
    setError("")
    if (!q) {
      try {
        setResults(recentSessionMessages({ limit: 40, dbPath: dbPath(), directory }))
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
        setResults(searchSessionMessages(q, { limit: 120, dbPath: dbPath(), directory }))
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
      setPreviewParts(loadConversationWindow(item, { before: 12, after: 24, dbPath: dbPath() }))
    } catch {
      setPreviewParts([])
    }
  })

  createEffect(() => {
    const item = selectedResult()
    previewParts()
    if (!item) return
    setTimeout(() => scrollPreviewToTarget(previewScroll, messageTargetID(item)), 1)
  })

  const open = () => {
    const item = selectedResult()
    if (!item) return
    const targetID = messageTargetID(item)
    props.api.ui.dialog.clear()
    props.api.route.navigate("session", { sessionID: item.sessionID })
    jumpToRenderedTarget(props.api.renderer.root, targetID)
  }

  const scrollPreview = (direction: 1 | -1, evt: ParsedKey) => {
    prevent(evt)
    previewScroll?.scrollBy(direction * previewScrollAmount(previewScroll))
  }

  const focusInput = () => {
    input?.focus()
  }

  const blurInput = () => {
    const el = input as (InputRenderable & { blur?: () => void }) | undefined
    el?.blur?.()
  }

  const unregisterLayer = props.api.keymap.registerLayer({
    commands: [],
    bindings: [{
      key: "<esc>",
      desc: "Exit insert mode",
      group: "Telescope",
      cmd: () => {
        if (mode() === "insert") {
          setMode("normal")
          blurInput()
        }
      },
    }],
  })
  onCleanup(() => unregisterLayer())

  useKeyboard((evt) => {
    if (!props.api.ui.dialog.open) return

    if (mode() === "normal") {
      if (isKey(evt, "q")) {
        prevent(evt)
        props.onClose()
        return
      }
      if (isKey(evt, "j")) {
        prevent(evt)
        move(1)
        return
      }
      if (isKey(evt, "k")) {
        prevent(evt)
        move(-1)
        return
      }
      if (isKey(evt, "d")) {
        scrollPreview(1, evt)
        return
      }
      if (isKey(evt, "u")) {
        scrollPreview(-1, evt)
        return
      }
      if (isKey(evt, "/")) {
        prevent(evt)
        setMode("insert")
        focusInput()
        return
      }
      if (isKey(evt, "enter", "return")) {
        prevent(evt)
        open()
        return
      }
    }
  })

  return (
    <box width="100%" alignItems="center">
      <box
        flexDirection="column"
        width={popupWidth()}
        height={height()}
        marginTop={verticalOffset()}
        backgroundColor={theme().backgroundPanel}
      >
        <box flexDirection="row" flexGrow={1} minHeight={0}>
          <box width={1} height="100%" backgroundColor={theme().accent} flexShrink={0} />
          <box flexDirection="column" flexGrow={1} minHeight={0}>
            <box paddingLeft={4} paddingRight={4} paddingTop={1} paddingBottom={1} gap={1} flexShrink={0}>
              <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
                <text fg={theme().text}><span style={{ bold: true }}>Search conversations</span></text>
                <text fg={theme().textMuted} onMouseUp={props.onClose}>q</text>
              </box>
              <box flexDirection="row" gap={1} flexShrink={0}>
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
            </box>

            <box flexDirection="row" flexGrow={1} minHeight={0}>
              <box width={leftWidth()} flexDirection="column" minHeight={0} backgroundColor={theme().backgroundPanel}>
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

              <box width={1} backgroundColor={theme().backgroundElement} flexShrink={0} />

              <box flexGrow={1} flexDirection="column" minHeight={0} backgroundColor={theme().background}>
                <PreviewHeader item={selectedResult()} query={query()} theme={theme()} />
                <scrollbox ref={(element: ScrollBoxRenderable) => (previewScroll = element)} flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1} verticalScrollbarOptions={{ visible: true }}>
                  <Show when={selectedResult()} fallback={<text fg={theme().textMuted}>Select a hit to preview the exact matched message.</text>}>
                    {(item) => <ConversationPreview item={item()} parts={previewParts()} syntax={syntax()} theme={theme()} />}
                  </Show>
                </scrollbox>
              </box>
            </box>

            <Show when={mode() === "normal"}>
              <box paddingLeft={4} paddingRight={4} flexDirection="row" justifyContent="space-between" backgroundColor={theme().backgroundElement}>
                <box flexDirection="row" gap={2}>
                  <text fg={theme().textMuted}>NORMAL</text>
                  <text fg={theme().textMuted}>j/k move</text>
                  <text fg={theme().textMuted}>d/u scroll</text>
                </box>
                <box flexDirection="row" gap={2}>
                  <text fg={theme().textMuted}>/ search</text>
                  <text fg={theme().textMuted}>enter open</text>
                  <text fg={theme().textMuted}>q close</text>
                </box>
              </box>
            </Show>
            <Show when={mode() === "insert"}>
              <box paddingLeft={4} paddingRight={4} flexDirection="row" backgroundColor={theme().backgroundElement}>
                <text fg={theme().textMuted}>INSERT  esc to normal</text>
              </box>
            </Show>

          </box>
        </box>
      </box>
    </box>
  )
}

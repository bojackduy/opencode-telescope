/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { InputRenderable, ParsedKey, ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { ConversationPreview, PreviewHeader } from "./components/preview.tsx"
import { EmptyState, ResultRow, SkeletonRow } from "./components/result-list.tsx"
import {
  loadConversationAfter,
  loadConversationAround,
  loadConversationBefore,
  recentSessionMessages,
  resolveDatabasePath,
  searchSessionMessages,
  type ConversationPreviewPart,
  type SearchResult,
} from "./search.ts"
import { debug } from "./ui/debug.ts"
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
  const [loading, setLoading] = createSignal(true)
  const [hasMore, setHasMore] = createSignal(true)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [prefetchingResults, setPrefetchingResults] = createSignal(false)
  const [resultPageInfo, setResultPageInfo] = createSignal({ loadedUntil: 0, hasMore: true, pageSize: 0, lastOffset: 0, lastAdded: 0 })
  const [hasMorePreviewBefore, setHasMorePreviewBefore] = createSignal(false)
  const [hasMorePreviewAfter, setHasMorePreviewAfter] = createSignal(false)
  const [loadingPreviewMore, setLoadingPreviewMore] = createSignal(false)
  const MIN_SEARCH_BATCH_SIZE = 25
  const MIN_RECENT_BATCH_SIZE = 15
  const RESULT_OVERSCAN_MULTIPLIER = 2
  const RESULT_PREFETCH_VIEWPORTS = 3
  const INITIAL_PREVIEW_BEFORE = 20
  const INITIAL_PREVIEW_AFTER = 30
  const PREVIEW_PAGE_SIZE = 20
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
  let advanceSelectionAfterLoad = false
  let resultPrefetchTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    if (resultPrefetchTimer) clearTimeout(resultPrefetchTimer)
  })

  const resultRowHeight = createMemo(() => leftWidth() >= 48 ? 3 : 4)
  const visibleResultRows = () => {
    const viewportHeight = resultScroll?.height || Math.max(8, height() - 7)
    return Math.max(5, Math.floor(viewportHeight / resultRowHeight()))
  }
  const searchBatchSize = () => Math.max(MIN_SEARCH_BATCH_SIZE, visibleResultRows() * 2)
  const recentBatchSize = () => Math.max(MIN_RECENT_BATCH_SIZE, visibleResultRows() * 2)
  const resultPrefetchThreshold = () => Math.max(visibleResultRows() * RESULT_PREFETCH_VIEWPORTS, searchBatchSize())
  const resultRenderWindow = createMemo(() => {
    const total = results().length
    const visible = visibleResultRows()
    const overscan = visible * RESULT_OVERSCAN_MULTIPLIER
    const index = selected()
    const start = Math.max(0, index - overscan)
    const end = Math.min(total, index + visible + overscan)
    return { start, end, items: results().slice(start, end) }
  })

  let lastResultRenderWindow = ""
  createEffect(() => {
    const window = resultRenderWindow()
    const key = `${window.start}:${window.end}:${results().length}`
    if (key === lastResultRenderWindow) return
    lastResultRenderWindow = key
    debug.log("results:render-window", {
      selected: selected(),
      totalLoaded: results().length,
      start: window.start,
      end: window.end,
      rendered: window.items.length,
      visibleRows: visibleResultRows(),
      overscanRows: visibleResultRows() * RESULT_OVERSCAN_MULTIPLIER,
      pageInfo: resultPageInfo(),
    })
  })

  createEffect(() => {
    const q = query().trim()
    setError("")
    setHasMore(true)
    const db = dbPath()
    const dir = directory

    if (!q) {
      setLoading(true)
      const limit = recentBatchSize()
      const timer = setTimeout(() => {
        debug.time("query:recent")
        try {
          const batch = recentSessionMessages({ limit, offset: 0, dbPath: db, directory: dir })
          setResults(batch)
          setHasMore(batch.length >= limit)
          setResultPageInfo({ loadedUntil: batch.length, hasMore: batch.length >= limit, pageSize: limit, lastOffset: 0, lastAdded: batch.length })
          setSelected(0)
        } catch (err) {
          setResults([])
          setResultPageInfo({ loadedUntil: 0, hasMore: false, pageSize: limit, lastOffset: 0, lastAdded: 0 })
          setError(err instanceof Error ? err.message : String(err))
        }
        debug.timeEnd("query:recent")
        setLoading(false)
      }, 1)
      onCleanup(() => clearTimeout(timer))
      return
    }

    setLoading(true)
    setBusy(true)
    const limit = searchBatchSize()
    const timer = setTimeout(() => {
      debug.time("query:search")
      try {
        const batch = searchSessionMessages(q, { limit, offset: 0, dbPath: db, directory: dir })
        setResults(batch)
        setHasMore(batch.length >= limit)
        setResultPageInfo({ loadedUntil: batch.length, hasMore: batch.length >= limit, pageSize: limit, lastOffset: 0, lastAdded: batch.length })
        setSelected(0)
      } catch (err) {
        setResults([])
        setResultPageInfo({ loadedUntil: 0, hasMore: false, pageSize: limit, lastOffset: 0, lastAdded: 0 })
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        debug.timeEnd("query:search")
        setBusy(false)
        setLoading(false)
      }
    }, 180)
    onCleanup(() => clearTimeout(timer))
  })

  const loadMoreResults = (advance = false) => {
    if (advance) advanceSelectionAfterLoad = true
    if (!hasMore()) {
      advanceSelectionAfterLoad = false
      return
    }
    if (loadingMore() || prefetchingResults() || busy() || loading()) return

    const total = results().length
    const q = query().trim()
    const db = dbPath()
    const dir = directory
    const limit = q ? searchBatchSize() : recentBatchSize()

    advance ? setLoadingMore(true) : setPrefetchingResults(true)
    debug.time("query:load-more")
    try {
      const batch = q
        ? searchSessionMessages(q, { limit, offset: total, dbPath: db, directory: dir })
        : recentSessionMessages({ limit, offset: total, dbPath: db, directory: dir })
      const nextHasMore = batch.length >= limit
      const nextLoadedUntil = total + batch.length
      debug.log("results:prefetch", { offset: total, limit, added: batch.length, totalLoaded: nextLoadedUntil, hasMore: nextHasMore, advance })
      setResults((prev) => [...prev, ...batch])
      setResultPageInfo({ loadedUntil: nextLoadedUntil, hasMore: nextHasMore, pageSize: limit, lastOffset: total, lastAdded: batch.length })
      if (!nextHasMore) setHasMore(false)
      if (advanceSelectionAfterLoad) {
        debug.log("results:advance-after-load", { from: selected(), total, added: batch.length })
        advanceSelectionAfterLoad = false
        if (batch.length > 0) setSelected(total)
      }
    } catch (err) {
      debug.log("results:load-more:error", err instanceof Error ? err.message : String(err))
      advanceSelectionAfterLoad = false
    } finally {
      debug.timeEnd("query:load-more")
      advance ? setLoadingMore(false) : setPrefetchingResults(false)
    }
  }

  const scheduleResultPrefetch = (advance = false) => {
    if (advance) advanceSelectionAfterLoad = true
    if (resultPrefetchTimer || loadingMore() || prefetchingResults()) return
    debug.log("results:prefetch-scheduled", { advance, pendingAdvance: advanceSelectionAfterLoad, pageInfo: resultPageInfo() })
    resultPrefetchTimer = setTimeout(() => {
      resultPrefetchTimer = undefined
      loadMoreResults(advanceSelectionAfterLoad)
    }, 1)
  }

  const move = (delta: number) => {
    if (results().length === 0) return
    setSelected((index) => {
      const next = index + delta
      let finalIndex = next
      if (next < 0) finalIndex = results().length - 1
      else if (next >= results().length) {
        if (hasMore()) scheduleResultPrefetch(true)
        finalIndex = results().length - 1
      }
       
      if (finalIndex !== index) debug.time("nav:total")
      return finalIndex
    })
  }

  createEffect(() => {
    const index = selected()
    const window = resultRenderWindow()
    const row = resultScroll?.getChildren()[index - window.start]
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
    const index = selected()
    const total = results().length
    const threshold = resultPrefetchThreshold()
    if (index < total - threshold) return
    if (!hasMore() || loadingMore() || prefetchingResults() || busy() || loading()) return

    const timer = setTimeout(() => scheduleResultPrefetch(false), 100)
    onCleanup(() => clearTimeout(timer))
  })

  const previewContentHeight = () => {
    const children = previewScroll?.getChildren()
    const lastChild = children?.[children.length - 1] as { y: number; height: number } | undefined
    return lastChild ? lastChild.y + lastChild.height : 0
  }

  const loadPreviewBefore = (previousContentHeight = previewContentHeight(), preserveScroll = true) => {
    const item = selectedResult()
    const first = previewParts()[0]
    if (!item || !first || loadingPreviewMore()) return
    setLoadingPreviewMore(true)
    debug.time("preview:load-before")
    try {
      const page = loadConversationBefore(item, { id: first.id, timeCreated: first.timeCreated }, { limit: PREVIEW_PAGE_SIZE, dbPath: dbPath() })
      debug.log("preview:load-before", {
        item: item.id,
        added: page.parts.length,
        hasMoreBefore: page.hasMoreBefore,
        preserveScroll,
        first: page.parts[0]?.id,
        last: page.parts.at(-1)?.id,
      })
      if (page.parts.length > 0) {
        setPreviewParts((prev) => [...page.parts, ...prev])
        if (preserveScroll) {
          setTimeout(() => {
            const delta = previewContentHeight() - previousContentHeight
            if (delta > 0) previewScroll?.scrollBy(delta)
          }, 1)
        }
      }
      setHasMorePreviewBefore(page.hasMoreBefore)
    } catch (err) {
      debug.log("preview:load-before:error", err instanceof Error ? err.message : String(err))
    } finally {
      debug.timeEnd("preview:load-before")
      setLoadingPreviewMore(false)
    }
  }

  const loadPreviewAfter = () => {
    const item = selectedResult()
    const last = previewParts().at(-1)
    if (!item || !last || loadingPreviewMore()) return
    setLoadingPreviewMore(true)
    debug.time("preview:load-after")
    try {
      const page = loadConversationAfter(item, { id: last.id, timeCreated: last.timeCreated }, { limit: PREVIEW_PAGE_SIZE, dbPath: dbPath() })
      debug.log("preview:load-after", {
        item: item.id,
        added: page.parts.length,
        hasMoreAfter: page.hasMoreAfter,
        first: page.parts[0]?.id,
        last: page.parts.at(-1)?.id,
      })
      if (page.parts.length > 0) setPreviewParts((prev) => [...prev, ...page.parts])
      setHasMorePreviewAfter(page.hasMoreAfter)
    } catch (err) {
      debug.log("preview:load-after:error", err instanceof Error ? err.message : String(err))
    } finally {
      debug.timeEnd("preview:load-after")
      setLoadingPreviewMore(false)
    }
  }

  let lastPreviewItemId = ""
  createEffect(() => {
    const item = selectedResult()
    if (!item) {
      setPreviewParts([])
      setHasMorePreviewBefore(false)
      setHasMorePreviewAfter(false)
      return
    }
    if (item.id === lastPreviewItemId) return
    lastPreviewItemId = item.id
    debug.log("preview:new-item", item.sessionTitle?.slice(0, 40) ?? item.id.slice(-8))
    const db = dbPath()
    debug.time("preview:load")
    try {
      const page = loadConversationAround(item, { before: INITIAL_PREVIEW_BEFORE, after: INITIAL_PREVIEW_AFTER, dbPath: db })
      debug.log("preview:init", {
        item: item.id,
        session: item.sessionID,
        parts: page.parts.length,
        hasMoreBefore: page.hasMoreBefore,
        hasMoreAfter: page.hasMoreAfter,
        first: page.parts[0]?.id,
        last: page.parts.at(-1)?.id,
      })
      setPreviewParts(page.parts)
      setHasMorePreviewBefore(page.hasMoreBefore)
      setHasMorePreviewAfter(page.hasMoreAfter)
    } catch {}
    debug.timeEnd("nav:total")
    debug.timeEnd("preview:load")
  })

  createEffect(() => {
    const item = selectedResult()
    if (!item) return
    const interval = setInterval(() => {
      if (loadingPreviewMore()) return
      const scroll = previewScroll
      const children = scroll?.getChildren()
      if (!scroll || !children || children.length === 0) return
      const lastChild = children[children.length - 1] as { y: number; height: number }
      const totalContentHeight = lastChild.y + lastChild.height
      const atTop = scroll.y <= 0
      const nearTop = scroll.y <= 2
      const atBottom = scroll.y + scroll.height >= totalContentHeight - 1
      if (nearTop || atBottom) {
        debug.log("preview:scroll-edge", {
          y: scroll.y,
          height: scroll.height,
          contentHeight: totalContentHeight,
          atTop,
          nearTop,
          atBottom,
          hasMoreBefore: hasMorePreviewBefore(),
          hasMoreAfter: hasMorePreviewAfter(),
          children: children.length,
        })
      }
      if (nearTop && hasMorePreviewBefore()) loadPreviewBefore(totalContentHeight, !atTop)
      if (atBottom && hasMorePreviewAfter()) loadPreviewAfter()
    }, 400)
    onCleanup(() => clearInterval(interval))
  })

  let scrolledItem = ""
  createEffect(() => {
    const item = selectedResult()
    previewParts()
    if (!item) return
    if (item.id === scrolledItem) return
    scrolledItem = item.id
    const timer = setTimeout(() => scrollPreviewToTarget(previewScroll, messageTargetID(item)), 1)
    onCleanup(() => clearTimeout(timer))
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

  useKeyboard((evt) => {
    if (!props.api.ui.dialog.open) return

    if (isKey(evt, "down") || isKey(evt, "up")) {
      prevent(evt)
      isKey(evt, "down") ? move(1) : move(-1)
      return
    }

    if (mode() === "normal") {
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
      if (isKey(evt, "q")) {
        prevent(evt)
        props.onClose()
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
                <text fg={theme().textMuted} onMouseUp={props.onClose}>esc</text>
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
                  onKeyDown={(evt: ParsedKey) => {
                    if (isKey(evt, "down") || isKey(evt, "up")) {
                      prevent(evt)
                      isKey(evt, "down") ? move(1) : move(-1)
                      return
                    }
                    if (evt.ctrl && isKey(evt, "q")) {
                      prevent(evt)
                      setMode("normal")
                      blurInput()
                    }
                  }}
                  flexGrow={1}
                />
                <text fg={theme().textMuted}>{busy() ? "searching" : loading() ? "loading..." : query().trim() ? (results().length > 0 ? `${selected() + 1}/${results().length} hits` : "0 hits") : (results().length > 0 ? `${selected() + 1}/${results().length} recent` : "0 recent")}</text>
              </box>
            </box>

            <box flexDirection="row" flexGrow={1} minHeight={0}>
              <box width={leftWidth()} flexDirection="column" minHeight={0} backgroundColor={theme().backgroundPanel}>
                <scrollbox ref={(element: ScrollBoxRenderable) => (resultScroll = element)} flexGrow={1} minHeight={0} verticalScrollbarOptions={{ visible: true }}>
                  <Show
                    when={!error()}
                    fallback={
                      <box flexDirection="column" paddingLeft={1} paddingTop={1}>
                        <text fg={theme().error}>database search failed</text>
                        <text fg={theme().textMuted}>{error()}</text>
                      </box>
                    }
                  >
                    <Show when={!loading()}>
                      <Show when={results().length > 0} fallback={<EmptyState query={query()} theme={theme()} />}>
                        <For each={resultRenderWindow().items}>
                          {(item, index) => {
                            const absoluteIndex = () => resultRenderWindow().start + index()
                            return (
                              <ResultRow
                                item={item}
                                active={absoluteIndex() === selected()}
                                width={leftWidth()}
                                query={query()}
                                theme={theme()}
                                onMouseOver={() => setSelected(absoluteIndex())}
                                onOpen={open}
                              />
                            )
                          }}
                        </For>
                        <Show when={loadingMore()}>
                          <SkeletonRow theme={theme()} />
                        </Show>
                        <Show when={!hasMore() && results().length > 0}>
                          <text fg={theme().textMuted}>  no more results</text>
                        </Show>
                      </Show>
                    </Show>
                    <Show when={loading()}>
                      <SkeletonRow theme={theme()} />
                      <SkeletonRow theme={theme()} />
                      <SkeletonRow theme={theme()} />
                      <SkeletonRow theme={theme()} />
                      <SkeletonRow theme={theme()} />
                      <SkeletonRow theme={theme()} />
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
              <box paddingLeft={4} paddingRight={4} flexDirection="row" backgroundColor={theme().backgroundElement} gap={2}>
                <text fg={theme().accent}><span style={{ bold: true }}>NORMAL</span></text>
                <text fg={theme().textMuted}>·</text>
                <text fg={theme().text}>j/k move</text>
                <text fg={theme().textMuted}>·</text>
                <text fg={theme().textMuted}>d/u scroll</text>
                <text fg={theme().textMuted}>·</text>
                <text fg={theme().text}>/ search</text>
                <text fg={theme().textMuted}>·</text>
                <text fg={theme().textMuted}>enter open</text>
                <text fg={theme().textMuted}>·</text>
                <text fg={theme().text}>q close</text>
              </box>
            </Show>
            <Show when={mode() === "insert"}>
              <box paddingLeft={4} paddingRight={4} flexDirection="row" backgroundColor={theme().backgroundElement} gap={2}>
                <text fg={theme().warning}><span style={{ bold: true }}>INSERT</span></text>
                <text fg={theme().textMuted}>·</text>
                <text fg={theme().textMuted}>↑/↓ move · ^Q normal</text>
              </box>
            </Show>

          </box>
        </box>
      </box>
    </box>
  )
}

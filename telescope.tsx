/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { InputRenderable, ParsedKey, ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Show, batch as solidBatch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
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
  type SearchRole,
} from "./search.ts"
import { debug } from "./ui/debug.ts"
import { syntaxStyle } from "./ui/format.ts"
import type { TelescopeConfig } from "./ui/config.ts"
import { inputSafeKeys, keyListLabel, matchesKey, prevent } from "./ui/keyboard.ts"
import { findRenderableByID, jumpToRenderedTarget, messageTargetID, previewScrollAmount, scrollPreviewToTarget } from "./ui/render-target.ts"

export const Telescope = (props: { api: TuiPluginApi; config: TelescopeConfig; onClose: () => void }) => {
  type OwnerFilter = "all" | SearchRole
  const dimensions = useTerminalDimensions()
  const [query, setQuery] = createSignal("")
  const [ownerFilter, setOwnerFilter] = createSignal<OwnerFilter>("all")
  const [results, setResults] = createSignal<SearchResult[]>([])
  const [previewParts, setPreviewParts] = createSignal<ConversationPreviewPart[]>([])
  const [selected, setSelected] = createSignal(0)
  const [resultBaseOffset, setResultBaseOffset] = createSignal(0)
  const [nextResultOffset, setNextResultOffset] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [mode, setMode] = createSignal<"normal" | "insert">("normal")
  const [loading, setLoading] = createSignal(true)
  const [hasMore, setHasMore] = createSignal(true)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [loadingPreviousResults, setLoadingPreviousResults] = createSignal(false)
  const [prefetchingResults, setPrefetchingResults] = createSignal(false)
  const [resultPageInfo, setResultPageInfo] = createSignal({ loadedUntil: 0, hasMore: true, pageSize: 0, lastOffset: 0, lastAdded: 0 })
  const [hasMorePreviewBefore, setHasMorePreviewBefore] = createSignal(false)
  const [hasMorePreviewAfter, setHasMorePreviewAfter] = createSignal(false)
  const [loadingPreviewMore, setLoadingPreviewMore] = createSignal(false)
  const [prefetchingPreviewBefore, setPrefetchingPreviewBefore] = createSignal(false)
  const [prefetchingPreviewAfter, setPrefetchingPreviewAfter] = createSignal(false)
  const [previewWindow, setPreviewWindow] = createSignal({ start: 0, end: 0 })
  const [previewHeightVersion, setPreviewHeightVersion] = createSignal(0)
  const MIN_SEARCH_BATCH_SIZE = 25
  const MIN_RECENT_BATCH_SIZE = 15
  const RESULT_OVERSCAN_MULTIPLIER = 2
  const RESULT_BATCH_VIEWPORTS = 4
  const RESULT_PREFETCH_VIEWPORTS = 3
  const RESULT_CACHE_BEHIND_VIEWPORTS = 6
  const INITIAL_PREVIEW_BEFORE = 20
  const INITIAL_PREVIEW_AFTER = 30
  const PREVIEW_PAGE_SIZE = 20
  const PREVIEW_PREFETCH_VIEWPORTS = 0.5
  let input: InputRenderable | undefined
  let resultScroll: ScrollBoxRenderable | undefined
  let previewScroll: ScrollBoxRenderable | undefined

  const theme = createMemo(() => props.api.theme.current)
  const syntax = createMemo(() => syntaxStyle(theme()))
  const ownerRole = createMemo(() => ownerFilter() === "all" ? undefined : ownerFilter() as SearchRole)
  const ownerLabel = createMemo(() => ownerFilter() === "user" ? "you" : ownerFilter())
  const inputKeys = createMemo(() => ({
    moveDown: inputSafeKeys(props.config.keys.moveDown),
    moveUp: inputSafeKeys(props.config.keys.moveUp),
    open: inputSafeKeys(props.config.keys.open),
    normalMode: inputSafeKeys(props.config.keys.normalMode),
  }))
  const normalHelpItems = createMemo(() => [
    `${keyListLabel(props.config.keys.moveUp)}/${keyListLabel(props.config.keys.moveDown)} move`,
    `${keyListLabel(props.config.keys.scrollPreviewDown)}/${keyListLabel(props.config.keys.scrollPreviewUp)} scroll`,
    `${keyListLabel(props.config.keys.toggleOwner)} owner`,
    `${keyListLabel(props.config.keys.insertMode)} search`,
    `${keyListLabel(props.config.keys.open)} open`,
    `${keyListLabel(props.config.keys.close)} close`,
  ])
  const selectedResult = createMemo(() => results()[selected() - resultBaseOffset()])
  const popupWidth = createMemo(() => Math.max(72, Math.min(dimensions().width - 2, Math.floor(dimensions().width * 0.92))))
  const leftWidth = createMemo(() => Math.max(36, Math.min(64, Math.floor(popupWidth() * 0.36))))
  const height = createMemo(() => Math.max(18, dimensions().height - 8))
  const verticalOffset = createMemo(() => Math.floor(dimensions().height / 4 - height() / 2) - 2)
  const dbPath = createMemo(() => resolveDatabasePath())
  const directory = props.api.state.path.directory
  let advanceSelectionAfterLoad = false
  let advanceSelectionBeforeLoad = false
  let resultNavigationStarted = false
  let resultPrefetchTimer: ReturnType<typeof setTimeout> | undefined
  let resultPreviousTimer: ReturnType<typeof setTimeout> | undefined
  let previewBeforeTimer: ReturnType<typeof setTimeout> | undefined
  let previewAfterTimer: ReturnType<typeof setTimeout> | undefined
  let pendingPreviewBefore: { previousContentHeight: number; preserveScroll: boolean; visibleLoad: boolean } | undefined
  let pendingPreviewAfterVisible = false
  const previewMeasuredHeights = new Map<string, number>()
  const cancelPreviewPrefetch = () => {
    if (previewBeforeTimer) clearTimeout(previewBeforeTimer)
    if (previewAfterTimer) clearTimeout(previewAfterTimer)
    previewBeforeTimer = undefined
    previewAfterTimer = undefined
    pendingPreviewBefore = undefined
    pendingPreviewAfterVisible = false
    setPrefetchingPreviewBefore(false)
    setPrefetchingPreviewAfter(false)
    setLoadingPreviewMore(false)
  }
  onCleanup(() => {
    if (resultPrefetchTimer) clearTimeout(resultPrefetchTimer)
    if (resultPreviousTimer) clearTimeout(resultPreviousTimer)
    cancelPreviewPrefetch()
  })

  const resultRowHeight = createMemo(() => leftWidth() >= 48 ? 3 : 4)
  const visibleResultRows = () => {
    const viewportHeight = resultScroll?.height || Math.max(8, height() - 7)
    return Math.max(5, Math.floor(viewportHeight / resultRowHeight()))
  }
  const searchBatchSize = () => Math.max(MIN_SEARCH_BATCH_SIZE, visibleResultRows() * RESULT_BATCH_VIEWPORTS)
  const recentBatchSize = () => Math.max(MIN_RECENT_BATCH_SIZE, visibleResultRows() * RESULT_BATCH_VIEWPORTS)
  const resultPrefetchThreshold = () => visibleResultRows() * RESULT_PREFETCH_VIEWPORTS
  const resultPrefetchState = () => {
    const cachedEnd = resultBaseOffset() + results().length
    const rowsAhead = Math.max(0, cachedEnd - selected() - 1)
    const threshold = resultPrefetchThreshold()
    return { cachedEnd, rowsAhead, threshold, shouldPrefetch: rowsAhead <= threshold }
  }
  const trimResultCache = (items: SearchResult[], anchorIndex: number) => {
    const base = resultBaseOffset()
    const keepBehind = visibleResultRows() * RESULT_CACHE_BEHIND_VIEWPORTS
    const minOffset = Math.max(0, anchorIndex - keepBehind)
    const drop = Math.min(Math.max(0, minOffset - base), Math.max(0, items.length - 1))
    if (drop === 0) return { base, items }

    const nextBase = base + drop
    debug.log("results:evict", { fromBase: base, toBase: nextBase, dropped: drop, kept: items.length - drop, anchorIndex })
    return { base: nextBase, items: items.slice(drop) }
  }
  const resultRenderWindow = createMemo(() => {
    const base = resultBaseOffset()
    const cached = results()
    const visible = visibleResultRows()
    const overscan = visible * RESULT_OVERSCAN_MULTIPLIER
    const index = selected()
    const cachedStart = Math.max(0, index - overscan - base)
    const cachedEnd = Math.min(cached.length, index + visible + overscan - base)
    return { start: base + cachedStart, end: base + cachedEnd, items: cached.slice(cachedStart, cachedEnd) }
  })

  let lastResultRenderWindow = ""
  createEffect(() => {
    const window = resultRenderWindow()
    const key = `${window.start}:${window.end}:${resultBaseOffset()}:${nextResultOffset()}:${results().length}`
    if (key === lastResultRenderWindow) return
    lastResultRenderWindow = key
    debug.log("results:render-window", {
      selected: selected(),
      baseOffset: resultBaseOffset(),
      nextOffset: nextResultOffset(),
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
    const role = ownerRole()
    setError("")
    setHasMore(true)
    if (resultPrefetchTimer) clearTimeout(resultPrefetchTimer)
    if (resultPreviousTimer) clearTimeout(resultPreviousTimer)
    resultPrefetchTimer = undefined
    resultPreviousTimer = undefined
    advanceSelectionAfterLoad = false
    advanceSelectionBeforeLoad = false
    resultNavigationStarted = false
    setLoadingMore(false)
    setLoadingPreviousResults(false)
    setPrefetchingResults(false)
    const db = dbPath()
    const dir = directory

    if (!q) {
      setLoading(true)
      const limit = recentBatchSize()
      const timer = setTimeout(() => {
        debug.log("bootstrap:recent:start", { limit, directory: dir, role })
        debug.time("query:recent")
        try {
          const batch = recentSessionMessages({ limit, offset: 0, dbPath: db, directory: dir, role })
          debug.log("bootstrap:recent:done", { rows: batch.length, limit })
          solidBatch(() => {
            setResults(batch)
            setResultBaseOffset(0)
            setNextResultOffset(batch.length)
            setHasMore(batch.length >= limit)
            setResultPageInfo({ loadedUntil: batch.length, hasMore: batch.length >= limit, pageSize: limit, lastOffset: 0, lastAdded: batch.length })
            setSelected(0)
          })
        } catch (err) {
          debug.log("bootstrap:recent:error", err instanceof Error ? err.message : String(err))
          solidBatch(() => {
            setResults([])
            setResultBaseOffset(0)
            setNextResultOffset(0)
            setResultPageInfo({ loadedUntil: 0, hasMore: false, pageSize: limit, lastOffset: 0, lastAdded: 0 })
          })
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
        debug.log("bootstrap:search:start", { limit, directory: dir, role, query: q })
        const batch = searchSessionMessages(q, { limit, offset: 0, dbPath: db, directory: dir, role })
        debug.log("bootstrap:search:done", { rows: batch.length, limit })
        solidBatch(() => {
          setResults(batch)
          setResultBaseOffset(0)
          setNextResultOffset(batch.length)
          setHasMore(batch.length >= limit)
          setResultPageInfo({ loadedUntil: batch.length, hasMore: batch.length >= limit, pageSize: limit, lastOffset: 0, lastAdded: batch.length })
          setSelected(0)
        })
      } catch (err) {
        solidBatch(() => {
          setResults([])
          setResultBaseOffset(0)
          setNextResultOffset(0)
          setResultPageInfo({ loadedUntil: 0, hasMore: false, pageSize: limit, lastOffset: 0, lastAdded: 0 })
        })
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
    if (loadingMore() || loadingPreviousResults() || prefetchingResults() || busy() || loading()) return

    const offset = nextResultOffset()
    const q = query().trim()
    const role = ownerRole()
    const db = dbPath()
    const dir = directory
    const limit = q ? searchBatchSize() : recentBatchSize()

    advance ? setLoadingMore(true) : setPrefetchingResults(true)
    debug.time("query:load-more")
    try {
      const batch = q
        ? searchSessionMessages(q, { limit, offset, dbPath: db, directory: dir, role })
        : recentSessionMessages({ limit, offset, dbPath: db, directory: dir, role })
      const nextHasMore = batch.length >= limit
      const nextLoadedUntil = offset + batch.length
      const previousSelected = selected()
      const nextSelected = advanceSelectionAfterLoad && batch.length > 0 ? offset : selected()
      const nextCache = trimResultCache([...results(), ...batch], nextSelected)
      debug.log("results:prefetch", {
        offset,
        limit,
        added: batch.length,
        baseOffset: nextCache.base,
        cached: nextCache.items.length,
        totalLoaded: nextLoadedUntil,
        hasMore: nextHasMore,
        advance,
      })
      const shouldAdvance = advanceSelectionAfterLoad
      solidBatch(() => {
        setResultBaseOffset(nextCache.base)
        setNextResultOffset(nextLoadedUntil)
        setResults(nextCache.items)
        setResultPageInfo({ loadedUntil: nextLoadedUntil, hasMore: nextHasMore, pageSize: limit, lastOffset: offset, lastAdded: batch.length })
        if (!nextHasMore) setHasMore(false)
        if (shouldAdvance && batch.length > 0) setSelected(offset)
      })
      if (shouldAdvance) {
        debug.log("results:advance-after-load", { from: previousSelected, offset, added: batch.length })
        advanceSelectionAfterLoad = false
      }
    } catch (err) {
      debug.log("results:load-more:error", err instanceof Error ? err.message : String(err))
      advanceSelectionAfterLoad = false
    } finally {
      debug.timeEnd("query:load-more")
      advance ? setLoadingMore(false) : setPrefetchingResults(false)
    }
  }

  const loadPreviousResults = (advance = false) => {
    if (advance) advanceSelectionBeforeLoad = true
    const base = resultBaseOffset()
    if (base <= 0) {
      advanceSelectionBeforeLoad = false
      return
    }
    if (loadingMore() || loadingPreviousResults() || prefetchingResults() || busy() || loading()) return

    const q = query().trim()
    const role = ownerRole()
    const db = dbPath()
    const dir = directory
    const pageSize = q ? searchBatchSize() : recentBatchSize()
    const offset = Math.max(0, base - pageSize)
    const limit = base - offset

    setLoadingPreviousResults(true)
    debug.time("query:load-before")
    try {
      const batch = q
        ? searchSessionMessages(q, { limit, offset, dbPath: db, directory: dir, role })
        : recentSessionMessages({ limit, offset, dbPath: db, directory: dir, role })
      const nextSelected = advanceSelectionBeforeLoad && batch.length > 0 ? base - 1 : selected()
      debug.log("results:load-before", { offset, limit, added: batch.length, fromBase: base, toBase: offset, cached: results().length + batch.length, advance })
      const shouldAdvance = advanceSelectionBeforeLoad
      solidBatch(() => {
        setResultBaseOffset(offset)
        setResults([...batch, ...results()])
        setResultPageInfo({ loadedUntil: nextResultOffset(), hasMore: hasMore(), pageSize, lastOffset: offset, lastAdded: batch.length })
        if (shouldAdvance && batch.length > 0) setSelected(nextSelected)
      })
      if (shouldAdvance) advanceSelectionBeforeLoad = false
    } catch (err) {
      debug.log("results:load-before:error", err instanceof Error ? err.message : String(err))
      advanceSelectionBeforeLoad = false
    } finally {
      debug.timeEnd("query:load-before")
      setLoadingPreviousResults(false)
    }
  }

  const scheduleResultPrefetch = (advance = false) => {
    if (advance) advanceSelectionAfterLoad = true
    if (resultPrefetchTimer || loadingMore() || loadingPreviousResults() || prefetchingResults()) return
    debug.log("results:prefetch-scheduled", { advance, pendingAdvance: advanceSelectionAfterLoad, pageInfo: resultPageInfo() })
    resultPrefetchTimer = setTimeout(() => {
      resultPrefetchTimer = undefined
      loadMoreResults(advanceSelectionAfterLoad)
    }, 1)
  }

  const schedulePreviousResultsLoad = (advance = false) => {
    if (advance) advanceSelectionBeforeLoad = true
    if (resultPreviousTimer || loadingMore() || loadingPreviousResults() || prefetchingResults()) return
    debug.log("results:load-before-scheduled", { advance, pendingAdvance: advanceSelectionBeforeLoad, baseOffset: resultBaseOffset(), pageInfo: resultPageInfo() })
    resultPreviousTimer = setTimeout(() => {
      resultPreviousTimer = undefined
      loadPreviousResults(advanceSelectionBeforeLoad)
    }, 1)
  }

  let lastResultPrefetchDecision = ""

  const move = (delta: number) => {
    if (results().length === 0) return
    resultNavigationStarted = true
    setSelected((index) => {
      const base = resultBaseOffset()
      const cachedEnd = base + results().length
      const next = index + delta
      let finalIndex = next
      if (next < 0) finalIndex = cachedEnd - 1
      else if (next < base) {
        schedulePreviousResultsLoad(true)
        finalIndex = base
      }
      else if (next >= cachedEnd) {
        if (hasMore()) scheduleResultPrefetch(true)
        finalIndex = cachedEnd - 1
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
    const state = resultPrefetchState()
    const blockedBy = !hasMore()
      ? "no-more"
      : !resultNavigationStarted
        ? "waiting-for-navigation"
      : loadingMore()
        ? "loading-more"
        : loadingPreviousResults()
          ? "loading-before"
          : prefetchingResults()
            ? "prefetching"
            : busy()
              ? "busy"
              : loading()
                ? "loading"
                : ""
    const decisionKey = `${selected()}:${state.cachedEnd}:${state.rowsAhead}:${state.threshold}:${blockedBy}:${state.shouldPrefetch}`
    if (decisionKey !== lastResultPrefetchDecision) {
      lastResultPrefetchDecision = decisionKey
      debug.log("results:prefetch-decision", { selected: selected(), ...state, blockedBy: blockedBy || undefined })
    }
    if (!state.shouldPrefetch || blockedBy) return

    const timer = setTimeout(() => scheduleResultPrefetch(false), 100)
    onCleanup(() => clearTimeout(timer))
  })

  const estimatePreviewPartHeight = (part: ConversationPreviewPart) => {
    if (part.type === "tool") {
      if (!part.target) return 2
      if (part.tool === "write") return 40
      if (part.tool === "edit" || part.tool === "apply_patch") return 35
      return 2
    }
    if (part.type === "reasoning") return Math.min(24, Math.max(2, Math.ceil(part.text.length / 120)))
    return Math.min(90, Math.max(3, Math.ceil(part.text.length / 90)))
  }

  const previewPartHeight = (part: ConversationPreviewPart) => previewMeasuredHeights.get(part.id) ?? estimatePreviewPartHeight(part)

  const previewVirtualLayout = createMemo(() => {
    previewHeightVersion()
    let offset = 0
    return previewParts().map((part) => {
      const height = previewPartHeight(part)
      const row = { part, top: offset, bottom: offset + height, height }
      offset += height
      return row
    })
  })

  const previewContentHeight = () => previewVirtualLayout().at(-1)?.bottom ?? 0

  const updatePreviewWindow = () => {
    const scroll = previewScroll
    const layout = previewVirtualLayout()
    if (layout.length === 0) {
      setPreviewWindow({ start: 0, end: 0 })
      return
    }
    if (!scroll) {
      const next = { start: 0, end: Math.min(layout.length, 20) }
      const current = previewWindow()
      if (current.start !== next.start || current.end !== next.end) setPreviewWindow(next)
      return
    }

    const overscan = Math.max(scroll.height * 2, 40)
    const from = Math.max(0, scroll.scrollTop - overscan)
    const to = scroll.scrollTop + scroll.height + overscan
    const foundStart = layout.findIndex((row) => row.bottom >= from)
    const start = foundStart === -1 ? Math.max(0, layout.length - 1) : Math.max(0, foundStart)
    const foundEnd = layout.findIndex((row) => row.top > to)
    const end = foundEnd === -1 ? layout.length : foundEnd
    const next = { start, end: Math.min(layout.length, Math.max(start + 1, end)) }
    const current = previewWindow()
    if (current.start !== next.start || current.end !== next.end) setPreviewWindow(next)
  }

  const previewWindowParts = createMemo(() => {
    const { start, end } = previewWindow()
    return previewParts().slice(start, end)
  })

  const previewTopSpacerHeight = createMemo(() => {
    const { start } = previewWindow()
    return previewVirtualLayout()[start]?.top ?? 0
  })

  const previewBottomSpacerHeight = createMemo(() => {
    const { end } = previewWindow()
    const layout = previewVirtualLayout()
    const total = layout.at(-1)?.bottom ?? 0
    const renderedBottom = end > 0 ? layout[end - 1]?.bottom ?? 0 : 0
    return Math.max(0, total - renderedBottom)
  })

  const previewScrollState = () => {
    const scroll = previewScroll
    const children = scroll?.getChildren()
    const lastChild = children?.[children.length - 1] as { y: number; height: number } | undefined
    return {
      y: scroll?.y,
      height: scroll?.height,
      scrollTop: scroll?.scrollTop,
      scrollHeight: scroll?.scrollHeight,
      childContentHeight: lastChild ? lastChild.y + lastChild.height : 0,
      children: children?.length ?? 0,
      hasMoreBefore: hasMorePreviewBefore(),
      hasMoreAfter: hasMorePreviewAfter(),
      loadingMore: loadingPreviewMore(),
      prefetchingBefore: prefetchingPreviewBefore(),
      prefetchingAfter: prefetchingPreviewAfter(),
      timerBefore: Boolean(previewBeforeTimer),
      timerAfter: Boolean(previewAfterTimer),
    }
  }

  const measurePreviewWindow = () => {
    const scroll = previewScroll
    if (!scroll) return

    let changed = false
    for (const part of previewWindowParts()) {
      const node = findRenderableByID(scroll, `preview-part-${part.id}`)
      const height = node?.height
      if (!height || height <= 0) continue
      if (previewMeasuredHeights.get(part.id) !== height) {
        previewMeasuredHeights.set(part.id, height)
        changed = true
      }
    }

    if (changed) {
      debug.log("preview:measure", {
        measured: previewWindowParts().length,
        totalMeasured: previewMeasuredHeights.size,
        window: previewWindow(),
      })
      setPreviewHeightVersion((value) => value + 1)
      setTimeout(updatePreviewWindow, 1)
    }
  }

  createEffect(() => {
    previewParts()
    previewHeightVersion()
    const timer = setTimeout(updatePreviewWindow, 1)
    onCleanup(() => clearTimeout(timer))
  })

  createEffect(() => {
    previewWindowParts()
    const timer = setTimeout(measurePreviewWindow, 1)
    onCleanup(() => clearTimeout(timer))
  })

  const loadPreviewBefore = (previousContentHeight = previewContentHeight(), preserveScroll = true, visibleLoad = false) => {
    const item = selectedResult()
    const first = previewParts()[0]
    if (!item || !first || loadingPreviewMore() || prefetchingPreviewBefore()) {
      debug.log("preview:load-before:skip", {
        reason: !item ? "no-item" : !first ? "no-first-part" : loadingPreviewMore() ? "loading-preview-more" : "prefetching-before",
        previousContentHeight,
        preserveScroll,
        visibleLoad,
        state: previewScrollState(),
      })
      return
    }
    const beforeState = previewScrollState()
    visibleLoad ? setLoadingPreviewMore(true) : setPrefetchingPreviewBefore(true)
    debug.time("preview:load-before")
    try {
      debug.log("preview:load-before:start", {
        item: item.id,
        cursor: { id: first.id, timeCreated: first.timeCreated },
        previousContentHeight,
        preserveScroll,
        visibleLoad,
        state: beforeState,
      })
      const page = loadConversationBefore(item, { id: first.id, timeCreated: first.timeCreated }, { limit: PREVIEW_PAGE_SIZE, dbPath: dbPath() })
      debug.log("preview:load-before", {
        item: item.id,
        added: page.parts.length,
        hasMoreBefore: page.hasMoreBefore,
        preserveScroll,
        visibleLoad,
        first: page.parts[0]?.id,
        last: page.parts.at(-1)?.id,
      })
      if (page.parts.length > 0) {
        setPreviewParts((prev) => [...page.parts, ...prev])
        if (preserveScroll) {
          setTimeout(() => {
            const beforeAdjust = previewScrollState()
            const delta = previewContentHeight() - previousContentHeight
            if (delta > 0) previewScroll?.scrollBy(delta)
            updatePreviewWindow()
            debug.log("preview:load-before:adjust", {
              delta,
              previousContentHeight,
              newContentHeight: previewContentHeight(),
              scrolled: delta > 0,
              beforeAdjust,
              afterAdjust: previewScrollState(),
            })
          }, 1)
        } else {
          setTimeout(() => {
            updatePreviewWindow()
            debug.log("preview:load-before:no-adjust", {
              previousContentHeight,
              newContentHeight: previewContentHeight(),
              state: previewScrollState(),
            })
          }, 1)
        }
      }
      setHasMorePreviewBefore(page.hasMoreBefore)
    } catch (err) {
      debug.log("preview:load-before:error", err instanceof Error ? err.message : String(err))
    } finally {
      debug.timeEnd("preview:load-before")
      visibleLoad ? setLoadingPreviewMore(false) : setPrefetchingPreviewBefore(false)
    }
  }

  const loadPreviewAfter = (visibleLoad = false) => {
    const item = selectedResult()
    const last = previewParts().at(-1)
    if (!item || !last || loadingPreviewMore() || prefetchingPreviewAfter()) {
      debug.log("preview:load-after:skip", {
        reason: !item ? "no-item" : !last ? "no-last-part" : loadingPreviewMore() ? "loading-preview-more" : "prefetching-after",
        visibleLoad,
        state: previewScrollState(),
      })
      return
    }
    debug.log("preview:load-after:start", {
      item: item.id,
      cursor: { id: last.id, timeCreated: last.timeCreated },
      visibleLoad,
      state: previewScrollState(),
    })
    visibleLoad ? setLoadingPreviewMore(true) : setPrefetchingPreviewAfter(true)
    debug.time("preview:load-after")
    try {
      const page = loadConversationAfter(item, { id: last.id, timeCreated: last.timeCreated }, { limit: PREVIEW_PAGE_SIZE, dbPath: dbPath() })
      debug.log("preview:load-after", {
        item: item.id,
        added: page.parts.length,
        hasMoreAfter: page.hasMoreAfter,
        visibleLoad,
        first: page.parts[0]?.id,
        last: page.parts.at(-1)?.id,
      })
      if (page.parts.length > 0) {
        setPreviewParts((prev) => [...prev, ...page.parts])
        setTimeout(updatePreviewWindow, 1)
      }
      setHasMorePreviewAfter(page.hasMoreAfter)
    } catch (err) {
      debug.log("preview:load-after:error", err instanceof Error ? err.message : String(err))
    } finally {
      debug.timeEnd("preview:load-after")
      visibleLoad ? setLoadingPreviewMore(false) : setPrefetchingPreviewAfter(false)
    }
  }

  const schedulePreviewBefore = (previousContentHeight = previewContentHeight(), preserveScroll = true, visibleLoad = false) => {
    if (!hasMorePreviewBefore() || loadingPreviewMore() || prefetchingPreviewBefore()) {
      debug.log("preview:prefetch-before:skip", {
        reason: !hasMorePreviewBefore() ? "no-more-before" : loadingPreviewMore() ? "loading-preview-more" : "prefetching-before",
        previousContentHeight,
        preserveScroll,
        visibleLoad,
        state: previewScrollState(),
      })
      return
    }
    if (previewBeforeTimer) {
      if (pendingPreviewBefore) {
        const previousPending = { ...pendingPreviewBefore }
        pendingPreviewBefore.preserveScroll = pendingPreviewBefore.preserveScroll && preserveScroll
        pendingPreviewBefore.visibleLoad = pendingPreviewBefore.visibleLoad || visibleLoad
        debug.log("preview:prefetch-before:merge", {
          previousPending,
          nextPending: pendingPreviewBefore,
          requested: { previousContentHeight, preserveScroll, visibleLoad },
          state: previewScrollState(),
        })
      } else {
        debug.log("preview:prefetch-before:skip", {
          reason: "timer-already-set",
          previousContentHeight,
          preserveScroll,
          visibleLoad,
          state: previewScrollState(),
        })
      }
      return
    }
    pendingPreviewBefore = { previousContentHeight, preserveScroll, visibleLoad }
    debug.log("preview:prefetch-before-scheduled", { previousContentHeight, preserveScroll, visibleLoad, state: previewScrollState() })
    previewBeforeTimer = setTimeout(() => {
      const pending = pendingPreviewBefore
      previewBeforeTimer = undefined
      pendingPreviewBefore = undefined
      if (pending) loadPreviewBefore(pending.previousContentHeight, pending.preserveScroll, pending.visibleLoad)
    }, 1)
  }

  const schedulePreviewAfter = (visibleLoad = false) => {
    if (!hasMorePreviewAfter() || loadingPreviewMore() || prefetchingPreviewAfter()) {
      debug.log("preview:prefetch-after:skip", {
        reason: !hasMorePreviewAfter() ? "no-more-after" : loadingPreviewMore() ? "loading-preview-more" : "prefetching-after",
        visibleLoad,
        state: previewScrollState(),
      })
      return
    }
    pendingPreviewAfterVisible = pendingPreviewAfterVisible || visibleLoad
    if (previewAfterTimer) {
      debug.log("preview:prefetch-after:skip", { reason: "timer-already-set", visibleLoad, pendingVisibleLoad: pendingPreviewAfterVisible, state: previewScrollState() })
      return
    }
    debug.log("preview:prefetch-after-scheduled", { visibleLoad, state: previewScrollState() })
    previewAfterTimer = setTimeout(() => {
      const pendingVisibleLoad = pendingPreviewAfterVisible
      previewAfterTimer = undefined
      pendingPreviewAfterVisible = false
      loadPreviewAfter(pendingVisibleLoad)
    }, 1)
  }

  const scrollPreviewToEstimatedTarget = (item: SearchResult) => {
    const scroll = previewScroll
    if (!scroll) return
    const targetID = messageTargetID(item)
    const row = previewVirtualLayout().find((entry) => entry.part.id === item.id)
    if (!row) {
      scrollPreviewToTarget(scroll, targetID)
      return
    }

    const top = Math.max(0, row.top - Math.max(1, Math.floor(scroll.height / 3)))
    debug.log("preview:target-scroll:estimated", { targetID, targetTop: row.top, scrollTop: scroll.scrollTop, nextScrollTop: top, window: previewWindow() })
    scroll.scrollTo(top)
    updatePreviewWindow()
    setTimeout(() => scrollPreviewToTarget(scroll, targetID), 1)
  }

  let lastPreviewItemId = ""
  createEffect(() => {
    const item = selectedResult()
    if (!item) {
      cancelPreviewPrefetch()
      setPreviewParts([])
      previewMeasuredHeights.clear()
      setPreviewHeightVersion((value) => value + 1)
      setPreviewWindow({ start: 0, end: 0 })
      setHasMorePreviewBefore(false)
      setHasMorePreviewAfter(false)
      return
    }
    if (item.id === lastPreviewItemId) return
    lastPreviewItemId = item.id
    cancelPreviewPrefetch()
    previewMeasuredHeights.clear()
    setPreviewHeightVersion((value) => value + 1)
    setPreviewWindow({ start: 0, end: 0 })
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
      setTimeout(() => scrollPreviewToEstimatedTarget(item), 1)
    } catch {}
    debug.timeEnd("nav:total")
    debug.timeEnd("preview:load")
  })

  createEffect(() => {
    const item = selectedResult()
    if (!item) return
    const interval = setInterval(() => {
      if (loadingPreviewMore() || prefetchingPreviewBefore() || prefetchingPreviewAfter()) return
      const scroll = previewScroll
      const children = scroll?.getChildren()
      if (!scroll || !children || children.length === 0) return
      const totalContentHeight = previewContentHeight()
      const atTop = scroll.scrollTop <= 0
      const prefetchDistance = Math.max(2, Math.floor(scroll.height * PREVIEW_PREFETCH_VIEWPORTS))
      const nearTop = scroll.scrollTop <= prefetchDistance
      const atBottom = scroll.scrollTop + scroll.height >= totalContentHeight - 1
      const nearBottom = scroll.scrollTop + scroll.height >= totalContentHeight - prefetchDistance
      if (nearTop || nearBottom) {
        debug.log("preview:scroll-edge", {
          y: scroll.y,
          scrollTop: scroll.scrollTop,
          height: scroll.height,
          contentHeight: totalContentHeight,
          childContentHeight: previewScrollState().childContentHeight,
          prefetchDistance,
          atTop,
          nearTop,
          atBottom,
          nearBottom,
          hasMoreBefore: hasMorePreviewBefore(),
          hasMoreAfter: hasMorePreviewAfter(),
          prefetchingBefore: prefetchingPreviewBefore(),
          prefetchingAfter: prefetchingPreviewAfter(),
          children: children.length,
        })
      }
      if (atTop && hasMorePreviewBefore()) schedulePreviewBefore(totalContentHeight, true, false)
      if (nearBottom && hasMorePreviewAfter()) schedulePreviewAfter(atBottom)
    }, 400)
    onCleanup(() => clearInterval(interval))
  })

  let scrolledItem = ""
  createEffect(() => {
    const item = selectedResult()
    previewVirtualLayout()
    if (!item) return
    if (item.id === scrolledItem) return
    scrolledItem = item.id
    const timer = setTimeout(() => scrollPreviewToEstimatedTarget(item), 1)
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
    const scroll = previewScroll
    if (!scroll) {
      debug.log("preview:scroll-key:skip", { reason: "no-scroll", direction })
      return
    }

    const beforeState = previewScrollState()
    debug.log("preview:scroll-key", { direction, state: beforeState })

    if (direction < 0 && scroll.scrollTop <= 0 && hasMorePreviewBefore()) {
      debug.log("preview:scroll-key:load-before", { direction, state: beforeState })
      schedulePreviewBefore(previewContentHeight(), true, true)
      return
    }

    const totalContentHeight = previewContentHeight()
    if (direction > 0 && scroll.scrollTop + scroll.height >= totalContentHeight - 1 && hasMorePreviewAfter()) {
      debug.log("preview:scroll-key:load-after", { direction, totalContentHeight, state: beforeState })
      schedulePreviewAfter(true)
      return
    }

    const amount = direction * previewScrollAmount(scroll)
    scroll.scrollBy(amount)
    updatePreviewWindow()
    debug.log("preview:scroll-key:scroll", { direction, amount, before: beforeState, after: previewScrollState() })
  }

  const focusInput = () => {
    input?.focus()
  }

  const blurInput = () => {
    const el = input as (InputRenderable & { blur?: () => void }) | undefined
    el?.blur?.()
  }

  const toggleOwnerFilter = () => {
    setOwnerFilter((filter) => filter === "all" ? "user" : filter === "user" ? "assistant" : "all")
  }

  useKeyboard((evt) => {
    if (!props.api.ui.dialog.open) return

    if (mode() !== "normal") return

    if (matchesKey(evt, props.config.keys.moveDown) || matchesKey(evt, props.config.keys.moveUp)) {
      prevent(evt)
      matchesKey(evt, props.config.keys.moveDown) ? move(1) : move(-1)
      return
    }

    if (matchesKey(evt, props.config.keys.open)) {
      prevent(evt)
      open()
      return
    }

    if (matchesKey(evt, props.config.keys.close)) {
      prevent(evt)
      props.onClose()
      return
    }

    if (matchesKey(evt, props.config.keys.scrollPreviewDown)) {
      scrollPreview(1, evt)
      return
    }

    if (matchesKey(evt, props.config.keys.scrollPreviewUp)) {
      scrollPreview(-1, evt)
      return
    }

    if (matchesKey(evt, props.config.keys.toggleOwner)) {
      prevent(evt)
      toggleOwnerFilter()
      return
    }

    if (matchesKey(evt, props.config.keys.insertMode)) {
      prevent(evt)
      setMode("insert")
      focusInput()
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
                    if (matchesKey(evt, inputKeys().moveDown) || matchesKey(evt, inputKeys().moveUp)) {
                      prevent(evt)
                      matchesKey(evt, inputKeys().moveDown) ? move(1) : move(-1)
                      return
                    }
                    if (matchesKey(evt, inputKeys().open)) {
                      prevent(evt)
                      open()
                      return
                    }
                    if (matchesKey(evt, inputKeys().normalMode)) {
                      prevent(evt)
                      setMode("normal")
                      blurInput()
                    }
                  }}
                  flexGrow={1}
                />
                <text fg={theme().textMuted}>{busy() ? `searching ${ownerLabel()}` : loading() ? `loading ${ownerLabel()}` : query().trim() ? (results().length > 0 ? `${ownerLabel()} ${selected() + 1}/${nextResultOffset()} hits` : `${ownerLabel()} 0 hits`) : (results().length > 0 ? `${ownerLabel()} ${selected() + 1}/${nextResultOffset()} recent` : `${ownerLabel()} 0 recent`)}</text>
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
                      <Show when={results().length > 0} fallback={<EmptyState query={query()} owner={ownerLabel()} theme={theme()} />}>
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
                    {(item) => (
                      <box flexDirection="column" flexShrink={0}>
                        <box height={previewTopSpacerHeight()} flexShrink={0} />
                        <ConversationPreview item={item()} parts={previewWindowParts()} syntax={syntax()} theme={theme()} />
                        <box height={previewBottomSpacerHeight()} flexShrink={0} />
                      </box>
                    )}
                  </Show>
                </scrollbox>
              </box>
            </box>

            <Show when={mode() === "normal"}>
              <box paddingLeft={4} paddingRight={4} flexDirection="row" backgroundColor={theme().backgroundElement} gap={2}>
                <text fg={theme().accent}><span style={{ bold: true }}>NORMAL</span></text>
                <For each={normalHelpItems()}>
                  {(item, index) => (
                    <>
                      <text fg={theme().textMuted}>·</text>
                      <text fg={index() % 2 === 0 ? theme().text : theme().textMuted}>{item}</text>
                    </>
                  )}
                </For>
              </box>
            </Show>
            <Show when={mode() === "insert"}>
              <box paddingLeft={4} paddingRight={4} flexDirection="row" backgroundColor={theme().backgroundElement} gap={2}>
                <text fg={theme().warning}><span style={{ bold: true }}>INSERT</span></text>
                <text fg={theme().textMuted}>·</text>
                <text fg={theme().textMuted}>{keyListLabel(inputKeys().moveUp)}/{keyListLabel(inputKeys().moveDown)} move · {keyListLabel(inputKeys().normalMode)} normal</text>
              </box>
            </Show>

          </box>
        </box>
      </box>
    </box>
  )
}

/** @jsxImportSource @opentui/solid */
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { Show } from "solid-js"
import type { SearchResult } from "../search.ts"
import { compactTime, roleColor, roleLabel, truncate } from "../ui/format.ts"

export const ResultRow = (props: {
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
    paddingLeft={2}
    paddingRight={2}
    paddingTop={0}
    paddingBottom={1}
    backgroundColor={props.active ? props.theme.backgroundElement : undefined}
    onMouseOver={props.onMouseOver}
    onMouseUp={props.onOpen}
  >
    <text wrapMode="none" overflow="hidden">
      <span style={{ fg: props.active ? props.theme.accent : props.theme.textMuted }}>
        {props.active ? "› " : "  "}
      </span>
      <span style={{ fg: props.active ? props.theme.accent : props.theme.text, bold: true }}>
        {truncate(props.item.sessionTitle, sessionTitleWidth(props.width))}
      </span>
      <Show when={props.item.isVectorMatch}>
        <span style={{ fg: props.theme.warning }}> ~</span>
      </Show>
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
      excerpt={props.item.excerpt}
      query={props.query}
      active={props.active}
      theme={props.theme}
      maxWidth={props.width}
      isVectorMatch={props.item.isVectorMatch}
    />
  </box>
)

export const EmptyState = (props: { query: string; owner: string; theme: TuiThemeCurrent }) => (
  <box paddingLeft={1} paddingTop={1}>
    <text fg={props.theme.textMuted}>{props.query.trim() ? `No matching ${props.owner} conversation text.` : `No recent ${props.owner} conversation text found.`}</text>
  </box>
)

export const SkeletonRow = (props: { theme: TuiThemeCurrent }) => (
  <box
    flexDirection="column"
    paddingLeft={2}
    paddingRight={2}
    paddingTop={0}
    paddingBottom={1}
  >
    <text wrapMode="none" overflow="hidden">
      <span style={{ fg: props.theme.textMuted }}>  </span>
      <span style={{ fg: props.theme.textMuted }}>────────────────────</span>
      <span style={{ fg: props.theme.textMuted }}>  </span>
      <span style={{ fg: props.theme.textMuted }}>you</span>
      <span style={{ fg: props.theme.textMuted }}> · -- --- --:--</span>
    </text>
    <text wrapMode="none" overflow="hidden">
      <span style={{ fg: props.theme.textMuted }}>  </span>
      <span style={{ fg: props.theme.textMuted }}>∙ ∙ ∙ ∙ ∙ ∙ ∙ ∙ ∙ ∙ ∙ ∙ ∙ ∙ ∙ ∙</span>
    </text>
  </box>
)

const HighlightedText = (props: {
  before: string
  match: string
  after: string
  excerpt: string
  query: string
  active: boolean
  theme: TuiThemeCurrent
  maxWidth: number
  isVectorMatch: boolean
}) => {
  const textMax = Math.max(10, props.maxWidth - 2)
  const sideMax = Math.floor(textMax * 0.35)
  const matchMax = textMax - sideMax * 2
  const before = truncate(props.before, sideMax)
  const after = truncate(props.after, sideMax)
  if (props.isVectorMatch) {
    return (
      <text wrapMode="none" overflow="hidden">
        <span style={{ fg: props.theme.textMuted }}>  </span>
        <span style={{ fg: props.theme.warning }}>~ </span>
        <span style={{ fg: props.active ? props.theme.text : props.theme.textMuted }}>{truncate(props.excerpt, textMax - 2)}</span>
      </text>
    )
  }
  const match = truncate(props.match || props.query, matchMax)
  return (
    <text wrapMode="none" overflow="hidden">
      <span style={{ fg: props.theme.textMuted }}>  </span>
      <span style={{ fg: props.active ? props.theme.text : props.theme.textMuted }}>{before}</span>
      <span style={{ fg: props.theme.warning, bold: true }}>{match}</span>
      <span style={{ fg: props.active ? props.theme.text : props.theme.textMuted }}>{after}</span>
    </text>
  )
}

function sessionTitleWidth(width: number) {
  if (width >= 54) return 28
  if (width >= 48) return 22
  return Math.max(18, width - 6)
}

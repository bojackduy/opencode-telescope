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

export const EmptyState = (props: { query: string; theme: TuiThemeCurrent }) => (
  <box paddingLeft={1} paddingTop={1}>
    <text fg={props.theme.textMuted}>{props.query.trim() ? "No matching user/assistant conversation text." : "No recent conversation text found."}</text>
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

function sessionTitleWidth(width: number) {
  if (width >= 54) return 28
  if (width >= 48) return 22
  return Math.max(18, width - 6)
}

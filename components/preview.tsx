/** @jsxImportSource @opentui/solid */
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { SyntaxStyle } from "@opentui/core"
import { For, Show, createMemo } from "solid-js"
import type { ConversationPreviewPart, SearchResult } from "../search.ts"
import { searchQueryLabel } from "../search/query.ts"
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
import {
  clippedText,
  containsOrderedTokens,
  conversationMatch,
  filetype,
  matchExcerpt,
  parseApplyPatchFiles,
  recordValue,
  shortPath,
  stringValue,
} from "../ui/preview-utils.ts"

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
              <text fg={props.theme.textMuted} wrapMode="none" overflow="hidden">
                {item().isVectorMatch ? "~semantic: " : searchQueryLabel(props.query)}
              </text>
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
          <box id={`preview-part-${part.id}`} flexDirection="column" flexShrink={0}>
            <PreviewConversationPart part={part} item={props.item} syntax={props.syntax} theme={props.theme} />
          </box>
        )}
      </For>
    </Show>
  </box>
)

const PreviewConversationPart = (props: { part: ConversationPreviewPart; item: SearchResult; syntax: SyntaxStyle; theme: TuiThemeCurrent }) => {
  if (props.part.type === "tool") return <PreviewToolPart part={props.part} item={props.item} syntax={props.syntax} theme={props.theme} />
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

const PreviewToolPart = (props: { part: ConversationPreviewPart; item: SearchResult; syntax: SyntaxStyle; theme: TuiThemeCurrent }) => {
  const status = createMemo(() => props.part.state?.status ?? "pending")
  const failed = createMemo(() => status() === "error")
  const color = createMemo(() => {
    if (failed()) return props.theme.error
    if (status() === "completed") return props.theme.textMuted
    return props.theme.text
  })
  const codeTool = createMemo(() => props.part.tool === "apply_patch" || props.part.tool === "edit" || props.part.tool === "write")
  return (
    <box id={`tool-${props.part.messageID}-${props.part.id}`} paddingLeft={3} marginTop={1} flexDirection="column" flexShrink={0}>
      <Show when={props.part.target}>
        <TargetMarker part={props.part} item={props.item} role={props.part.tool ?? "tool"} time={props.part.timeCreated} theme={props.theme} />
      </Show>
      <Show when={codeTool() && props.part.target} fallback={<CompactToolRow part={props.part} color={color()} failed={failed()} theme={props.theme} />}>
        <CodeToolPreview part={props.part} item={props.item} syntax={props.syntax} theme={props.theme} />
      </Show>
      <Show when={props.part.state?.error}>
        {(error) => <text fg={props.theme.error}>{error()}</text>}
      </Show>
    </box>
  )
}

const CompactToolRow = (props: { part: ConversationPreviewPart; color: any; failed: boolean; theme: TuiThemeCurrent }) => (
  <>
    <text fg={props.color} wrapMode="none" overflow="hidden">
      <span style={{ fg: props.failed ? props.theme.error : props.theme.textMuted }}>{toolIcon(props.part.tool)} </span>
      <span>{toolLabel(props.part.tool)}</span>
      <span style={{ fg: props.theme.textMuted }}> {toolInputSummary(props.part.state?.input)}</span>
      <span style={{ fg: props.theme.textMuted }}> · {props.part.state?.status ?? "pending"}</span>
    </text>
    <Show when={props.failed ? props.part.state?.output : undefined}>
      {(output) => <text fg={props.theme.textMuted}>{truncate(output().trim(), 300)}</text>}
    </Show>
  </>
)

const CodeToolPreview = (props: { part: ConversationPreviewPart; item: SearchResult; syntax: SyntaxStyle; theme: TuiThemeCurrent }) => {
  if (props.part.tool === "apply_patch") return <ApplyPatchPreview part={props.part} item={props.item} syntax={props.syntax} theme={props.theme} />
  if (props.part.tool === "edit") return <EditPreview part={props.part} item={props.item} syntax={props.syntax} theme={props.theme} />
  if (props.part.tool === "write") return <WritePreview part={props.part} item={props.item} syntax={props.syntax} theme={props.theme} />
  return <CompactToolRow part={props.part} color={props.theme.textMuted} failed={false} theme={props.theme} />
}

const ApplyPatchPreview = (props: { part: ConversationPreviewPart; item: SearchResult; syntax: SyntaxStyle; theme: TuiThemeCurrent }) => {
  const files = createMemo(() => parseApplyPatchFiles(props.part.state?.metadata))
  const matched = createMemo(() => {
    const query = props.item.match || props.item.previewMatch
    return files().find((file) => containsOrderedTokens(file.patch, query)) ?? files()[0]
  })
  return (
    <Show when={matched()} fallback={<CompactToolRow part={props.part} color={props.theme.textMuted} failed={false} theme={props.theme} />}>
      {(file) => {
        const view = createMemo(() => clippedText(file().patch, props.item.match || props.item.previewMatch, 24))
        return (
          <ToolBlock title={patchTitle(file())} theme={props.theme}>
            <Show when={view().clipped}>
              <text fg={props.theme.textMuted}>showing matched excerpt from large patch</text>
            </Show>
            <DiffBlock diff={view().text} filePath={file().filePath} syntax={props.syntax} theme={props.theme} clipped={view().clipped} />
          </ToolBlock>
        )
      }}
    </Show>
  )
}

const EditPreview = (props: { part: ConversationPreviewPart; item: SearchResult; syntax: SyntaxStyle; theme: TuiThemeCurrent }) => {
  const input = createMemo(() => recordValue(props.part.state?.input))
  const metadata = createMemo(() => recordValue(props.part.state?.metadata))
  const diff = createMemo(() => stringValue(metadata()?.diff) ?? stringValue(recordValue(metadata()?.filediff)?.patch) ?? "")
  const filePath = createMemo(() => stringValue(input()?.filePath) ?? stringValue(recordValue(metadata()?.filediff)?.file) ?? "")
  return (
    <Show when={diff()} fallback={<CompactToolRow part={props.part} color={props.theme.textMuted} failed={false} theme={props.theme} />}>
      {(value) => (
        <ToolBlock title={`← Edit ${shortPath(filePath())}`} theme={props.theme}>
          {(() => {
            const view = createMemo(() => clippedText(value(), props.item.match || props.item.previewMatch, 24))
            return (
              <>
                <Show when={view().clipped}>
                  <text fg={props.theme.textMuted}>showing matched excerpt from large diff</text>
                </Show>
                <DiffBlock diff={view().text} filePath={filePath()} syntax={props.syntax} theme={props.theme} clipped={view().clipped} />
              </>
            )
          })()}
        </ToolBlock>
      )}
    </Show>
  )
}

const WritePreview = (props: { part: ConversationPreviewPart; item: SearchResult; syntax: SyntaxStyle; theme: TuiThemeCurrent }) => {
  const input = createMemo(() => recordValue(props.part.state?.input))
  const filePath = createMemo(() => stringValue(input()?.filePath) ?? "")
  const content = createMemo(() => stringValue(input()?.content) ?? "")
  return (
    <Show when={content()} fallback={<CompactToolRow part={props.part} color={props.theme.textMuted} failed={false} theme={props.theme} />}>
      {(value) => (
        <ToolBlock title={`# Wrote ${shortPath(filePath())}`} theme={props.theme}>
          {(() => {
            const view = createMemo(() => clippedText(value(), props.item.match || props.item.previewMatch, 32))
            return (
              <>
                <Show when={view().clipped}>
                  <text fg={props.theme.textMuted}>showing matched excerpt from large file</text>
                </Show>
          <line_number fg={props.theme.textMuted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={props.theme.text}
              filetype={filetype(filePath())}
              syntaxStyle={props.syntax}
              content={view().text}
            />
          </line_number>
              </>
            )
          })()}
        </ToolBlock>
      )}
    </Show>
  )
}

const ToolBlock = (props: { title: string; children: any; theme: TuiThemeCurrent }) => (
  <box
    border={["left"]}
    paddingTop={1}
    paddingBottom={1}
    paddingLeft={2}
    marginTop={1}
    gap={1}
    backgroundColor={props.theme.backgroundPanel}
    customBorderChars={splitBorderChars}
    borderColor={props.theme.background}
    flexDirection="column"
  >
    <text paddingLeft={3} fg={props.theme.textMuted}>{props.title}</text>
    {props.children}
  </box>
)

const DiffBlock = (props: { diff: string; filePath: string; syntax: SyntaxStyle; theme: TuiThemeCurrent; clipped?: boolean }) => (
  <box paddingLeft={1}>
    <Show when={!props.clipped} fallback={<code filetype="diff" syntaxStyle={props.syntax} content={props.diff} fg={props.theme.text} />}>
      <diff
        diff={props.diff}
        view="unified"
        filetype={filetype(props.filePath)}
        syntaxStyle={props.syntax}
        showLineNumbers={true}
        width="100%"
        wrapMode="word"
        fg={props.theme.text}
        addedBg={props.theme.diffAddedBg}
        removedBg={props.theme.diffRemovedBg}
        contextBg={props.theme.diffContextBg}
        addedSignColor={props.theme.diffHighlightAdded}
        removedSignColor={props.theme.diffHighlightRemoved}
        lineNumberFg={props.theme.diffLineNumber}
        lineNumberBg={props.theme.diffContextBg}
        addedLineNumberBg={props.theme.diffAddedLineNumberBg}
        removedLineNumberBg={props.theme.diffRemovedLineNumberBg}
      />
    </Show>
  </box>
)

const TargetMarker = (props: { part: ConversationPreviewPart; item?: SearchResult; role: string; time: number; theme: TuiThemeCurrent }) => (
  <box flexDirection="column" flexShrink={0}>
    <text fg={props.theme.warning} wrapMode="none" overflow="hidden">
      <span>{props.item?.isVectorMatch ? "~semantic" : "match"}</span>
      <span style={{ fg: props.theme.textMuted }}> · {props.role} · {compactTime(props.time)}</span>
    </text>
    <Show when={props.item && !props.item.isVectorMatch && matchExcerpt(props.part.text, props.item.match)}>
      {(excerpt) => (
        <text fg={props.theme.textMuted} wrapMode="none" overflow="hidden">
          <span>{excerpt().before}</span>
          <span style={{ fg: props.theme.warning, bold: true }}>{excerpt().match}</span>
          <span>{excerpt().after}</span>
        </text>
      )}
    </Show>
    <Show when={props.item?.isVectorMatch && props.item}>
      {(item) => (
        <text fg={props.theme.textMuted} wrapMode="none" overflow="hidden">
          {item().text.slice(0, 200)}
        </text>
      )}
    </Show>
  </box>
)

const HighlightedConversationText = (props: { part: ConversationPreviewPart; item: SearchResult; theme: TuiThemeCurrent }) => {
  const match = createMemo(() => conversationMatch(props.part.text, props.part.target, props.item.match))
  return (
    <Show when={match()} fallback={
      <text fg={props.item.isVectorMatch ? props.theme.textMuted : props.theme.text}>
        {props.item.isVectorMatch ? `~ ${props.part.text}` : props.part.text}
      </text>
    }>
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

function conversationMarkdown(part: ConversationPreviewPart, item: SearchResult) {
  const hit = conversationMatch(part.text, part.target, item.match)
  if (!hit || !item.previewHighlight) return part.text
  return markdownWithMatch(part.text.slice(0, hit.start), part.text.slice(hit.start, hit.end), part.text.slice(hit.end), true)
}

function patchTitle(file: { type: string; relativePath: string; filePath: string; deletions: number }) {
  if (file.type === "delete") return `# Deleted ${file.relativePath}`
  if (file.type === "add") return `# Created ${file.relativePath}`
  if (file.type === "move") return `# Moved ${shortPath(file.filePath)} -> ${file.relativePath}`
  return `← Patched ${file.relativePath}`
}

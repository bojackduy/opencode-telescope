import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"

const enabled = process.env.OPENCODE_TELESCOPE_DEBUG === "1"
const logPath = process.env.OPENCODE_TELESCOPE_LOG
const consoleEnabled = !logPath || process.env.OPENCODE_TELESCOPE_CONSOLE === "1"
const timers = new Map<string, number>()

let traceCounter = 0
const pending: string[] = []
let flushTimer: ReturnType<typeof setInterval> | undefined

const flushPending = () => {
  if (!logPath || pending.length === 0) return
  const batch = pending.splice(0, pending.length).join("")
  try {
    appendFileSync(logPath, batch)
  } catch {
    /* never let logging break the plugin */
  }
}

const queueLine = (line: string) => {
  if (logPath) {
    pending.push(line)
    if (pending.length >= 200) flushPending()
  }
  if (consoleEnabled) console.log(line)
}

if (enabled && logPath) {
  mkdirSync(path.dirname(logPath), { recursive: true })
  try {
    appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), type: "log", label: "session:start", payload: { pid: process.pid } })}\n`)
  } catch {
    /* ignore */
  }
  flushTimer = setInterval(flushPending, 200)
  flushTimer.unref?.()
}

process.on("exit", flushPending)

export const debug = {
  get enabled() {
    return enabled
  },

  traceID(prefix = "trace") {
    return `${prefix}-${++traceCounter}-${Math.random().toString(36).slice(2, 8)}`
  },

  time(label: string) {
    if (enabled) timers.set(label, performance.now())
  },

  timeEnd(label: string) {
    if (!enabled) return
    const start = timers.get(label)
    if (start !== undefined) {
      queueLine(`${JSON.stringify({ ts: new Date().toISOString(), type: "time", label, payload: { ms: Number((performance.now() - start).toFixed(2)) } })}\n`)
      timers.delete(label)
    }
  },

  log(...args: unknown[]) {
    if (enabled) queueLine(`${JSON.stringify({ ts: new Date().toISOString(), type: "log", label: String(args[0] ?? "message"), payload: safeJson(args.length > 1 ? args.slice(1) : undefined) })}\n`)
  },
}

function safeJson(value: unknown) {
  try {
    JSON.stringify(value)
    return value
  } catch {
    return String(value)
  }
}

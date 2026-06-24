import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"

const enabled = process.env.OPENCODE_TELESCOPE_DEBUG === "1"
const logPath = process.env.OPENCODE_TELESCOPE_LOG
const consoleEnabled = !logPath || process.env.OPENCODE_TELESCOPE_CONSOLE === "1"
const timers = new Map<string, number>()

if (enabled && logPath) {
  mkdirSync(path.dirname(logPath), { recursive: true })
  writeFileLog("session:start", { pid: process.pid })
}

export const debug = {
  get enabled() {
    return enabled
  },

  time(label: string) {
    if (enabled) timers.set(label, performance.now())
  },

  timeEnd(label: string) {
    if (!enabled) return
    const start = timers.get(label)
    if (start !== undefined) {
      writeLog("time", label, { ms: Number((performance.now() - start).toFixed(2)) })
      timers.delete(label)
    }
  },

  log(...args: unknown[]) {
    if (enabled) writeLog("log", String(args[0] ?? "message"), args.length > 1 ? args.slice(1) : undefined)
  },
}

function writeLog(type: "log" | "time", label: string, payload: unknown) {
  if (logPath) writeFileLog(label, payload, type)
  if (consoleEnabled) console.log(type === "time" ? `[telescope:time] ${label}` : "[telescope]", payload ?? "")
}

function writeFileLog(label: string, payload: unknown, type = "log") {
  if (!logPath) return
  appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), type, label, payload: safeJson(payload) })}\n`)
}

function safeJson(value: unknown) {
  try {
    JSON.stringify(value)
    return value
  } catch {
    return String(value)
  }
}

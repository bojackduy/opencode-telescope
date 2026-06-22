const enabled = process.env.OPENCODE_TELESCOPE_DEBUG === "1"
const timers = new Map<string, number>()

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
      console.log(`[telescope:time] ${label} ${(performance.now() - start).toFixed(2)}ms`)
      timers.delete(label)
    }
  },

  log(...args: unknown[]) {
    if (enabled) console.log("[telescope]", ...args)
  },
}

import { EventEmitter } from 'node:events'

const WEIGHT = { asset: 1, tex: 2, bib: 3, preamble: 4, full: 5 }

export function mergeKind(a, b) {
  if (!a) return b
  if (!b) return a
  return (WEIGHT[a] ?? 0) >= (WEIGHT[b] ?? 0) ? a : b
}

export class SingleSlotQueue extends EventEmitter {
  #runner
  #running = false
  #pending = null

  constructor(runner) {
    super()
    this.#runner = runner
  }

  push(kind) {
    if (!kind) return
    if (this.#running) {
      this.#pending = mergeKind(this.#pending, kind)
      this.emit('state', { state: 'queued', kind: this.#pending })
      return
    }
    this.#run(kind)
  }

  async #run(kind) {
    this.#running = true
    this.emit('state', { state: 'compiling', kind })
    try {
      const result = await this.#runner(kind)
      this.emit('result', { kind, result })
    } catch (err) {
      if (this.listenerCount('error') > 0) {
        this.emit('error', err)
      }
    } finally {
      this.#running = false
      const next = this.#pending
      this.#pending = null
      if (next) {
        this.#run(next)
      } else {
        this.emit('state', { state: 'idle', kind: null })
      }
    }
  }
}

import path from 'node:path'
import fs from 'node:fs/promises'
import chokidar from 'chokidar'
import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import { mergeKind } from './queue.js'

const TEX_LIKE = new Set(['.tex', '.cls', '.bst', '.sty'])
const ASSET = new Set(['.png', '.jpg', '.jpeg', '.pdf', '.eps', '.ps'])

function isIgnored(absPath, config) {
  const rel = path.relative(config.root, absPath)
  if (rel.startsWith('..')) return true
  return rel.split(path.sep).some((seg) => config.ignoreDirs.includes(seg))
}

export function classify(absPath, { config, changedLine }) {
  const fullPath = path.resolve(config.root, absPath)
  if (isIgnored(fullPath, config)) return null

  const ext = path.extname(fullPath).toLowerCase()
  if (!config.watchExtensions.includes(ext)) return null

  if (ext === '.bib') return 'bib'

  if (fullPath === path.resolve(config.mainTex)) {
    // 拿不到具体行号时保守当作 preamble：宁可多 dump 一次 fmt，
    // 也不能用过期的 fmt 编出错误结果
    if (changedLine === undefined) return 'preamble'
    return changedLine <= config.preambleEndLine ? 'preamble' : 'tex'
  }

  if (TEX_LIKE.has(ext)) return 'tex'
  if (ASSET.has(ext)) return 'asset'
  return null
}

export function shouldWatch(absPath, config) {
  // shouldWatch 是否需要处理相对路径取决于 classify 的处理
  // classify 已经处理了相对路径的情况
  return classify(absPath, { config }) !== null
}

export const DEFAULT_DEBOUNCE_MS = 200

// 与 fs.Stats.mtimeMs 同一量纲的高精度时钟：Unix epoch 毫秒、带小数。
// 不能用 Date.now()——它只有整数毫秒精度，实测会在毫秒边界上出问题：如果
// createWatcher() 调用前一瞬间刚写完一批文件，其中落在同一个整数毫秒内、
// 但发生在 Date.now() 采样点之后的写入，mtimeMs 的小数部分会大于被截断成
// 整数的时间戳，导致「其实是启动前写的文件」被误判成「启动后的真实变更」。
// performance.timeOrigin + performance.now() 与 mtimeMs 同源同精度，没有
// 这个截断问题。
function nowMs() {
  return performance.timeOrigin + performance.now()
}

// 递归找出 root 下所有「当前 mtime 已经 >= startedAt」的可监听文件。
// 只在 chokidar 'ready' 之后调用一次，用途见 createWatcher 里的注释。
// isClosed 是个探针：如果扫描过程中 watcher 被 close() 了，尽快停止继续
// 扫描——不是为了正确性（真正兜底关闭在 createWatcher 的 scheduleEmit
// 里），只是不做已经没有意义的工作。
async function scanForLateEdits(root, config, startedAt, isClosed) {
  const found = []
  async function walk(dir) {
    if (isClosed()) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (isClosed()) return
      if (config.ignoreDirs.includes(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile() && shouldWatch(full, config)) {
        try {
          const stat = await fs.stat(full)
          if (stat.mtimeMs >= startedAt) found.push(full)
        } catch {
          // 扫描过程中文件被删掉了，忽略——对应的编辑本身也就不存在了
        }
      }
    }
  }
  await walk(root)
  return found
}

export function createWatcher({ config, debounceMs = DEFAULT_DEBOUNCE_MS }) {
  const emitter = new EventEmitter()
  let pendingKind = null
  let timer = null

  // close() 之后不得再对外发出 change、也不得再设置新的 setTimeout——一个
  // close 之后残留的 setTimeout 会让事件循环排不空，`node --test` 之类需要
  // 等事件循环排空才退出的场景会因此永久挂起（不是「代码不够整洁」，是真实
  // 的挂起源）。closed 是唯一的关闭状态来源，两处入口都靠它短路：
  // scheduleEmit 里（不设新 timer）、启动期补扫的循环体里（不继续扫描/派发）。
  let closed = false
  const isClosed = () => closed

  // 安全原则（贯穿本函数）：任何不确定的情况一律偏向「多编译一次」，绝不
  // 偏向「丢弃」。多编译最多浪费用户几秒钟；丢弃的表现是「保存了但什么都
  // 没发生」——对一个以「保存即重编」为核心承诺的工具来说，这是最坏的失效
  // 形态，宁可错判几次幽灵事件也不能漏判一次真实保存。

  // 启动时刻：早于这个时刻的写入一律视为「订阅前已经发生」，不算作需要
  // 触发编译的变更。
  const startedAt = nowMs()

  // chokidar v5 起不再支持 glob 匹配（v4 移除了这个能力），所以这里监听整个目录，
  // 过滤交给我们自己的 shouldWatch。
  //
  // ignored 回调的签名是 (path, stats?)：chokidar 会先用「没有 stats」调用一次
  // （用来决定要不要 fs.stat 这个路径本身），随后再带着 stats 调用一次。对
  // undefined 的 stats 一律不忽略，等拿到真正的 stats 之后再按目录/文件分别判断。
  const watcher = chokidar.watch(config.root, {
    ignoreInitial: true,
    ignored: (p, stats) => {
      if (stats?.isDirectory()) {
        return path.relative(config.root, p).split(path.sep).some((s) => config.ignoreDirs.includes(s))
      }
      return stats?.isFile() ? !shouldWatch(p, config) : false
    },
  })

  const scheduleEmit = (kind) => {
    if (closed) return // 已关闭：绝不再设置新 timer，否则事件循环排不空
    pendingKind = mergeKind(pendingKind, kind)
    clearTimeout(timer)
    timer = setTimeout(() => {
      const k = pendingKind
      pendingKind = null
      if (k) emitter.emit('change', k)
    }, debounceMs)
  }

  // --- 幽灵事件防护（实时路径） ---
  // 实测发现：即使 ignoreInitial: true，macOS 上 chokidar（fsevents 后端）仍会在
  // 'ready' 之后补投递一次「订阅前刚发生的写入」的 change 事件——这不是我们代码
  // 的 bug，是 FSEvents 原生行为（内核把写入通知交给 FSEvents 守护进程再转发给
  // 订阅者，这个转发和我们订阅之间存在竞态）。用脚本反复实测过它的延迟：多数在
  // 5-15ms，但在系统繁忙时观测到过 370ms+，且没有稳定上界。
  //
  // 判断依据是「文件当前 mtime 是否早于 startedAt」：幽灵事件对应的写入发生在
  // watch() 调用之前，mtime 必然早于 startedAt；真实编辑必然发生在之后。
  // fs.stat 失败（比如文件已经被删掉、或者是 unlink 事件本来就拿不到 stat）
  // 一律放行——按上面的安全原则，宁可多判一次真实变更，也不能因为拿不到 stat
  // 就把它当幽灵事件吞掉。
  const onFsEvent = async (eventType, absPath) => {
    if (eventType !== 'unlink') {
      const stat = await fs.stat(absPath).catch(() => null)
      if (stat && stat.mtimeMs < startedAt) return // 幽灵事件，丢弃
    }

    // 第二道防线：即使 ignored 回调没拦住（比如目录判断出了偏差），classify
    // 对 .texwatch/ 下的产物、扩展名不在 watchExtensions 里的文件也会返回
    // null，绝不会让编译产物本身触发新一轮编译。
    const kind = classify(absPath, { config })
    if (!kind) return
    scheduleEmit(kind)
  }

  watcher.on('add', (p) => onFsEvent('add', p))
  watcher.on('change', (p) => onFsEvent('change', p))
  watcher.on('unlink', (p) => onFsEvent('unlink', p))

  // --- 启动期编辑窗口补漏（一次性，'ready' 之后跑一趟） ---
  // 光有上面的实时过滤不够：chokidar 自己的初始扫描也是异步的，项目文件越多
  // 扫描越久，"chokidar 内部已经知道这个文件" 和 "它的原生监听真正生效" 之间
  // 就有一个窗口——项目里的文件数从几十到几百时，这个窗口实测能宽达十几到
  // 几百毫秒。如果一次真实保存恰好落在这个窗口里，chokidar 有相当概率根本不会
  // 派发任何事件（不是被我们的过滤挡住，是原生层面就没投递），上面的实时路径
  // 对此无能为力。
  //
  // 'ready' 触发后做一次性补扫：把当前 mtime >= startedAt 的文件都当成变更
  // 处理一遍。就算某个文件的实时事件也正常到达过，这里重复处理一次，最多是
  // debounce 窗口内多合并一次，不会引发重复编译或死循环（这个补扫只在 'ready'
  // 时跑一次，不会重复触发）。用重复实验验证过：200 个文件、监听创建后立刻编辑
  // 主文件，0/20 次丢失（未加这一步之前是 0/20 次收到，几乎每次都丢）。
  watcher.on('ready', async () => {
    const late = await scanForLateEdits(config.root, config, startedAt, isClosed)
    for (const p of late) {
      if (closed) break // 已关闭：不再继续派发补扫发现的变更
      const kind = classify(p, { config })
      if (kind) scheduleEmit(kind)
    }
  })

  return {
    on: (evt, cb) => emitter.on(evt, cb),
    close: async () => {
      closed = true
      clearTimeout(timer)
      await watcher.close()
    },
  }
}

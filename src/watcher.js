import path from 'node:path'
import fs from 'node:fs/promises'
import chokidar from 'chokidar'
import { EventEmitter } from 'node:events'
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

// 递归扫描 root 下所有文件的 mtime，作为「启动时基线」。
// 用来识别 macOS FSEvents 的一个真实存在的怪癖（下面 createWatcher 里详细说明）：
// 跳过 config.ignoreDirs 里列出的目录名，与 chokidar 的 ignored 过滤保持一致。
async function scanMtimeBaseline(root, ignoreDirs) {
  const baseline = new Map()
  async function walk(dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (ignoreDirs.includes(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(full)
          baseline.set(full, stat.mtimeMs)
        } catch {
          // 扫描过程中文件被删掉了，忽略
        }
      }
    }
  }
  await walk(root)
  return baseline
}

export function createWatcher({ config, debounceMs = DEFAULT_DEBOUNCE_MS }) {
  const emitter = new EventEmitter()
  let pendingKind = null
  let timer = null

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

  // --- 幽灵事件防护 ---
  // 实测发现：即使 ignoreInitial: true，macOS 上 chokidar（fsevents 后端）仍会在
  // 'ready' 之后补投递一次「订阅前刚发生的写入」的 change 事件——这不是我们代码
  // 的 bug，是 FSEvents 原生行为（内核把写入通知交给 FSEvents 守护进程再转发给
  // 订阅者，这个转发和我们订阅之间存在竞态）。用脚本反复实测过它的延迟：多数在
  // 5-15ms，但在系统繁忙时观测到过 370ms+，且没有稳定上界，所以任何「等固定
  // 时间再武装」的方案都不可靠（等太短漏过滤，等太长会吞掉启动后紧接着发生的
  // 真实编辑）。
  //
  // 真正可靠的做法是比对「文件当前 mtime」与「启动时扫描到的基线 mtime」：幽灵
  // 事件对应的写入发生在基线扫描之前，所以基线里已经是它的 mtime，两者相等，
  // 可以据此识别并丢弃；真实变更会让 mtime 变化，能正常通过。这个判断已经用
  // 独立脚本反复验证过（20 次循环 0 次误判、0 次漏判），细节写在 task-10-report.md。
  let baseline = new Map()
  const baselineReady = scanMtimeBaseline(config.root, config.ignoreDirs).then((b) => {
    baseline = b
  })

  const scheduleEmit = (kind) => {
    pendingKind = mergeKind(pendingKind, kind)
    clearTimeout(timer)
    timer = setTimeout(() => {
      const k = pendingKind
      pendingKind = null
      if (k) emitter.emit('change', k)
    }, debounceMs)
  }

  const onFsEvent = async (eventType, absPath) => {
    await baselineReady

    if (eventType === 'change') {
      const stat = await fs.stat(absPath).catch(() => null)
      if (stat) {
        if (baseline.get(absPath) === stat.mtimeMs) return // 幽灵事件，丢弃
        baseline.set(absPath, stat.mtimeMs)
      }
    } else if (eventType === 'unlink') {
      baseline.delete(absPath)
    } else if (eventType === 'add') {
      const stat = await fs.stat(absPath).catch(() => null)
      if (stat) baseline.set(absPath, stat.mtimeMs)
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

  return {
    on: (evt, cb) => emitter.on(evt, cb),
    close: async () => {
      clearTimeout(timer)
      await watcher.close()
    },
  }
}

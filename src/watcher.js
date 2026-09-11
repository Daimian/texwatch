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

// `changedLine` 在当前所有生产调用（下面 onFsEvent / 'ready' 补扫两处）里
// 恒为 undefined——文件系统监听（chokidar）拿不到「改动发生在文件的第几
// 行」，只能拿到「这个文件变了」。所以对主文件而言，下面的分支实际上恒走
// `changedLine === undefined` 这条，主文件的改动因而恒被判为 'preamble'，
// `tex` 态在生产中只会出现在非主文件（SI.tex/.cls/.bst/.sty）上。这不是
// bug，是有意为之的保守设计（拿不到行号就宁可多 dump 一次 fmt，也不能用
// 过期的 fmt 编出错误结果），实测性能影响接近零，因此不删 `changedLine` /
// `preambleEndLine`——这个参数是留给未来某个能提供真实行号的调用方（比如
// 编辑器插件通过 LSP 拿到光标位置）用的，当前只是还没有这样的调用方。
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

// 写入稳定性窗口：一次逻辑编辑在文件系统层面可能不是原子的（fs.writeFile
// 实际是 open(O_TRUNC) -> write() -> close()，系统繁忙时这几步的间隔会被
// 拉开），chokidar/fsevents 可能因此对同一次编辑投递两次独立的原生通知，
// 两次通知落在写入过程的不同时点、观察到两个真正不同的 mtime——这种情况
// 下即使跨路径去重按 mtime 精确比较也无能为力：它的判断本身没错，错的是
// 拿到了两个本不该不同的 mtime。用同一个稳定性窗口统一「实时路径」（交给
// chokidar 内置的 awaitWriteFinish）和「启动期补扫」（scanForLateEdits 里
// 手动实现的 waitForStableMtime）：只有 mtime 连续 stabilityThresholdMs
// 没有再变化，才认为这次写入真正完成，两条路径因此收敛到同一个稳定值。
// 用确定性复现（fs.open 截断 -> 延迟 30ms -> write+close）实测过：不加这个
// 窗口，5/5 必然产生两个不同的 mtime、触发两次编译；加上之后 5/5 稳定
// 收敛成一次。数值取 { stabilityThreshold: 50, pollInterval: 10 }——叠加
// debounce 后编译启动前增加约 250ms，相对编译本身的 1-2 秒是可接受的代价。
const WRITE_STABILITY = { stabilityThresholdMs: 50, pollIntervalMs: 10 }

// 补扫路径自己的稳定性确认：对某个候选文件反复 stat，直到连续
// stabilityThresholdMs 内 mtime 都没有再变化，返回那个稳定下来的 mtime。
// 和 chokidar 的 awaitWriteFinish 做的是同一件事，只是补扫这条路径不经过
// chokidar，需要自己实现。文件在确认过程中消失（比如被删掉）返回 null，
// 交给调用方决定——按安全原则，宁可放行让它多调度一次，也不能因为拿不到
// 稳定值就悄悄漏掉。设了一个宽松的总超时（2 秒）防止一个持续被写入的大
// 文件让扫描无限期卡住：超时后就用当时观察到的最后一个 mtime，不再等下去。
async function waitForStableMtime(filePath, { stabilityThresholdMs, pollIntervalMs } = WRITE_STABILITY) {
  const deadline = nowMs() + 2000
  let last
  try {
    last = (await fs.stat(filePath)).mtimeMs
  } catch {
    return null
  }
  let stableSince = nowMs()
  while (nowMs() - stableSince < stabilityThresholdMs) {
    if (nowMs() > deadline) return last // 放弃继续等，用目前观察到的值，偏向多调度
    await new Promise((r) => setTimeout(r, pollIntervalMs))
    let current
    try {
      current = (await fs.stat(filePath)).mtimeMs
    } catch {
      return null
    }
    if (current !== last) {
      last = current
      stableSince = nowMs()
    }
  }
  return last
}

// 递归找出 root 下所有「当前 mtime 已经 >= startedAt」的可监听文件，连同
// 「已经确认稳定」的 mtimeMs 一起返回（调用方用它做跨路径去重，见
// createWatcher 里 scheduledMtimes 的说明）。
// 只在 chokidar 'ready' 之后调用一次，用途见 createWatcher 里的注释。
// isClosed 是个探针：如果扫描过程中 watcher 被 close() 了，尽快停止继续
// 扫描——不是为了正确性（真正兜底关闭在 createWatcher 的 scheduleEmit
// 里），只是不做已经没有意义的工作。
//
// 分两遍：第一遍只是快速找候选（单次 stat，和之前一样），第二遍只对候选
// 文件（通常只有一两个）并行做稳定性确认（waitForStableMtime）。不对整棵
// 目录树的每个文件都做稳定性确认，是为了不让「项目文件很多」和「等待写入
// 稳定」这两个各自独立的开销相乘——候选文件数量通常很少，并行确认把额外
// 延迟的上界钉在约一个 stabilityThresholdMs，而不是随候选数量线性增长。
async function scanForLateEdits(root, config, startedAt, isClosed) {
  const candidates = []
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
          if (stat.mtimeMs >= startedAt) candidates.push(full)
        } catch {
          // 扫描过程中文件被删掉了，忽略——对应的编辑本身也就不存在了
        }
      }
    }
  }
  await walk(root)
  if (isClosed() || candidates.length === 0) return []

  const confirmed = []
  await Promise.all(
    candidates.map(async (full) => {
      if (isClosed()) return
      const stableMtime = await waitForStableMtime(full)
      if (stableMtime === null) return // 确认过程中文件被删了，交给实时路径的 unlink 处理
      if (stableMtime >= startedAt) confirmed.push({ path: full, mtimeMs: stableMtime })
    })
  )
  return confirmed
}

export function createWatcher({
  config,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  // --- 以下两个参数仅供测试使用 ---
  // 生产代码（bin/texwatch.js）永远不传这两个参数，默认值 0 时完全不生效。
  // 「实时路径」（chokidar 的 add/change/unlink 事件）和「启动期补扫」
  // （'ready' 之后的 scanForLateEdits）谁先谁后是不确定的——补扫延迟实测
  // 过从几 ms 到 370ms+ 都有，没有稳定上界，没法在测试里靠 tick() 掐时间
  // 可靠地复现某一种先后顺序。这两个参数让测试能各自单独人为拖慢其中一条
  // 路径，从而确定性地构造出「实时先到、补扫后到」和「补扫先到、实时后到」
  // 这两种顺序，验证跨路径去重在两个方向上都生效。
  testOnlyLiveEventDelayMs = 0,
  testOnlyLateScanDelayMs = 0,
}) {
  const emitter = new EventEmitter()
  let pendingKind = null
  let timer = null

  // path -> 最近一次安排 emit 时该文件的 mtimeMs。实时路径和启动期补扫都
  // 可能观察到同一次编辑：如果两条路径都判定它是「需要处理的变更」，且各自
  // 观察到的 mtime 相同，说明是同一次写入被看到了两遍，只应该 emit 一次。
  // 用 mtime 做键、而不是「哪条路径先处理过这个路径」这种一次性标记，是因为
  // 这样和两条路径谁先谁后无关：不管补扫先到还是实时事件先到，后到的那条
  // 只要发现 mtime 和已经记录的一致，就知道是重复，直接跳过；如果文件后来
  // 又被真实编辑过（mtime 变了），仍然会正常调度一次新的 emit。
  const scheduledMtimes = new Map()
  const alreadyScheduled = (absPath, mtimeMs) => {
    if (mtimeMs === undefined) return false // 拿不到 mtime，没法判断，交给调用方决定（偏向多调度）
    if (scheduledMtimes.get(absPath) === mtimeMs) return true
    scheduledMtimes.set(absPath, mtimeMs)
    return false
  }

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
  //
  // awaitWriteFinish：让 chokidar 在文件 mtime/size 稳定下来之前不要派发
  // change 事件，从源头把一次逻辑编辑可能产生的多次原生通知（open(O_TRUNC)
  // -> write() -> close() 之间的间隔被系统负载拉开时）合并成一次，交给我们
  // 的稳定值和 scanForLateEdits 里 waitForStableMtime 得到的稳定值一致，
  // 跨路径去重（按 mtime 精确比较）才有稳定的输入可比——用确定性复现
  // （fs.open 截断 -> 延迟 30ms -> write+close）实测过：不开这个选项时，
  // chokidar 对同一次编辑投递两次独立事件、两次 fs.stat 读到两个真正不同
  // 的 mtime，5/5 必然触发两次编译；开启后 5/5 收敛成一次。
  //
  // 这个选项和 Task 10 早期排查过的「幽灵事件重投递」是两回事：幽灵事件是
  // 订阅前已经写完的文件在 'ready' 之后被 FSEvents 补投递一次通知（早期
  // 实测过 awaitWriteFinish 对此无效，15 次里 14 次仍然出现，因为幽灵事件
  // 是「文件早就稳定了、通知却晚到」，awaitWriteFinish 只处理「文件还在
  // 变」的情况，两者是不同的时序问题，互不矛盾）；这里要解决的是「文件真的
  // 还在变、写入本身被拆成了好几步」，正是 awaitWriteFinish 的设计目标。
  const watcher = chokidar.watch(config.root, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: WRITE_STABILITY.stabilityThresholdMs,
      pollInterval: WRITE_STABILITY.pollIntervalMs,
    },
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
    if (testOnlyLiveEventDelayMs > 0) {
      await new Promise((r) => setTimeout(r, testOnlyLiveEventDelayMs))
      if (closed) return
    }

    let mtimeMs
    if (eventType !== 'unlink') {
      const stat = await fs.stat(absPath).catch(() => null)
      if (stat && stat.mtimeMs < startedAt) return // 幽灵事件，丢弃
      mtimeMs = stat?.mtimeMs
    }

    // 第二道防线：即使 ignored 回调没拦住（比如目录判断出了偏差），classify
    // 对 .texwatch/ 下的产物、扩展名不在 watchExtensions 里的文件也会返回
    // null，绝不会让编译产物本身触发新一轮编译。
    const kind = classify(absPath, { config })
    if (!kind) return

    // 跨路径去重：如果启动期补扫已经用同样的 mtime 处理过这个文件（补扫先
    // 到、这次实时事件后到的情况），这里就不再重复调度。
    if (alreadyScheduled(absPath, mtimeMs)) return
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
  // 处理一遍（这个补扫只在 'ready' 时跑一次，不会重复触发，不会引发死循环）。
  // 用重复实验验证过：200 个文件、监听创建后立刻编辑主文件，0/20 次丢失
  // （未加这一步之前是 0/20 次收到，几乎每次都丢）。
  //
  // 注意：这条路径和上面的实时路径完全独立，都可能观察到同一次编辑——曾经
  // 以为"顶多在同一个 debounce 窗口内合并"，但复审用人为延迟 400ms 补扫的
  // 方式实测证伪了这个假设：只要补扫比实时路径的 debounce flush 晚到超过
  // debounceMs，两者就会各自独立 emit 一次，导致同一次保存触发两次编译。
  // 靠 alreadyScheduled（按 mtime 去重，和先后顺序无关）堵住，而不是指望
  // debounce 窗口的时序巧合。
  watcher.on('ready', async () => {
    if (testOnlyLateScanDelayMs > 0) {
      await new Promise((r) => setTimeout(r, testOnlyLateScanDelayMs))
      if (closed) return
    }
    const late = await scanForLateEdits(config.root, config, startedAt, isClosed)
    for (const { path: p, mtimeMs } of late) {
      if (closed) break // 已关闭：不再继续派发补扫发现的变更
      const kind = classify(p, { config })
      if (!kind) continue
      if (alreadyScheduled(p, mtimeMs)) continue // 实时路径已经先处理过同一个 mtime
      scheduleEmit(kind)
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

// 预览页渲染逻辑：pdf.js 渲染 + WebSocket 状态处理。
//
// pdf.js API 说明（针对内置的 pdfjs-dist v6.3.289，实测查证 node_modules/pdfjs-dist/
// build/pdf.mjs 里 PDFPageProxy#render 的参数处理，而非照抄旧版文档/教程）：
//   render({ canvas, viewport })
// v6.3.289 的 render() 仍然接受 `canvasContext` 参数（并未移除), 但推荐、更直接的
// 写法是直接传 `canvas`——pdf.js 内部会自己用 canvas.getContext('2d', {...}) 取上下文
// （见 pdf.mjs 里 InternalRenderTask#initializeGraphics）。这里用 `canvas` 形式。
import * as pdfjsLib from '/vendor/pdfjs/pdf.mjs'
import { captureAnchor, anchorToScrollTop } from '/scroll-anchor.js'
import { createVersionTracker } from '/version-tracker.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs'

const pagesEl = document.getElementById('pages')
const statusEl = document.getElementById('status')
const summaryEl = document.getElementById('summary')
const staleEl = document.getElementById('stale')
const diagEl = document.getElementById('diagnostics')
const draftEl = document.getElementById('draft')

// 版本记账：决定「要不要为这条消息里的 pdfVersion 发起一次新渲染」，以及渲染
// 失败时该不该把已渲染版本回滚，好让后续同版本的消息还能再次触发渲染。算法与
// 测试见 client/version-tracker.js / test/version-tracker.test.js——这里只有
// 一份实现，测试验证的就是实际运行的这份。
const versionTracker = createVersionTracker()

const scale = 1.4
let ws = null

// 并发渲染的版本仲裁：onMessage 与 renderPdf 之间没有互斥，携带不同 pdfVersion
// 的两条消息背靠背到达（连续保存两次、触发两次成功编译）时会并发跑两次
// renderPdf()——各自独立地 getDocument / 逐页 render，谁先跑完就先 replaceChildren
// 一次，最终显示哪个版本取决于谁先完成，而不是谁更新。而 renderedVersion 早就
// 被 onMessage 同步更新成最新值了，不会再有消息来纠正，用户就会看到旧 PDF 却
// 毫无提示。
//
// 用一个单调递增的 token 做仲裁：每次调用 renderPdf 时占用一个新 token；只有在
// DOM 写入（replaceChildren / 滚动恢复）的那一刻，token 仍是最新的那次调用才
// 允许写入，否则整份渲染结果直接丢弃。因为 onMessage 是按消息到达顺序同步调用
// renderPdf 的（JS 单线程，调用发生在任何 await 之前），"最后一次发起调用" 必然
// 对应 "最新的 pdfVersion"，不需要额外传版本号比较。
let renderToken = 0

async function renderPdf() {
  const myToken = ++renderToken

  // 用「视口顶部所在页号 + 页内相对偏移比例」而不是绝对 scrollTop：改一段文字
  // 可能导致后面全部内容重新分页，绝对偏移会飘。
  const before = [...pagesEl.querySelectorAll('canvas')].map((c) => ({
    offsetTop: c.offsetTop,
    offsetHeight: c.offsetHeight,
  }))
  const anchor = captureAnchor(before, window.scrollY)

  const doc = await pdfjsLib.getDocument({
    url: `/pdf?v=${Date.now()}`,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
  }).promise

  const dpr = window.devicePixelRatio || 1
  const frag = document.createDocumentFragment()
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const viewport = page.getViewport({ scale: scale * dpr })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    canvas.style.width = `${viewport.width / dpr}px`
    canvas.dataset.page = String(n)
    await page.render({ canvas, viewport }).promise
    frag.appendChild(canvas)
  }

  // 这次渲染在异步过程中已经被更新的一次调用（更高的 token）超越——说明中途
  // 又有一条更新的 pdfVersion 消息到达并发起了新的渲染。丢弃这次结果，不碰
  // DOM，让更新的那次渲染负责最终显示。
  if (myToken !== renderToken) return

  pagesEl.replaceChildren(frag)

  // 布局要等一帧才稳定，否则 offsetTop 全是 0
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

  // 等这一帧的过程中也可能被更新的渲染超越（它会在自己的写入点用同样的 DOM
  // 再刷一次），这里就不必再恢复滚动位置了。
  if (myToken !== renderToken) return

  if (before.length > 0) {
    const after = [...pagesEl.querySelectorAll('canvas')].map((c) => ({
      offsetTop: c.offsetTop,
      offsetHeight: c.offsetHeight,
    }))
    window.scrollTo({ top: anchorToScrollTop(after, anchor), behavior: 'instant' })
  }
}

function renderStatus(msg) {
  statusEl.className = msg.state === 'compiling' || msg.state === 'queued' ? 'compiling' : msg.state
  const secs = msg.durationMs ? `${(msg.durationMs / 1000).toFixed(1)}s` : ''
  const label = {
    idle: '空闲',
    compiling: '编译中…',
    queued: '编译中（有新改动排队）…',
    ok: `编译成功 ${secs}`,
    error: `编译失败 ${secs}`,
  }[msg.state] ?? msg.state
  summaryEl.textContent = label
  staleEl.textContent = msg.pdfStale ? '⚠︎ 当前 PDF 不是最新源码' : ''
  draftEl.checked = !!msg.draft

  diagEl.replaceChildren(
    ...(msg.diagnostics ?? []).map((d) => {
      const div = document.createElement('div')
      div.className = `diag ${d.severity}`
      const loc = d.file ? `${d.file}${d.line ? `:${d.line}` : ''}  ` : ''
      const locSpan = document.createElement('span')
      locSpan.className = 'loc'
      locSpan.textContent = loc
      const msgSpan = document.createElement('span')
      msgSpan.className = 'msg'
      msgSpan.textContent = d.message
      div.append(locSpan, msgSpan)
      if (d.hint) {
        const hint = document.createElement('div')
        hint.className = 'hint'
        hint.textContent = `→ ${d.hint}`
        div.appendChild(hint)
      }
      return div
    })
  )
}

async function onMessage(msg) {
  renderStatus(msg)
  // 只有 pdfVersion 真正变化才重新拉取/渲染 PDF——否则每条状态消息（哪怕只是
  // "编译中"）都会触发一次 getDocument + 全页重绘，白白闪烁。pdfVersion 为 0
  // 表示还没有编译成功过一次，此时 /pdf 还不存在，不必请求。
  if (versionTracker.shouldRender(msg.pdfVersion)) {
    const claim = versionTracker.claim(msg.pdfVersion)
    try {
      await renderPdf()
    } catch (err) {
      console.error('渲染 PDF 失败', err)
      // 回滚 renderedVersion：否则下次收到同一个 pdfVersion（典型场景：断线
      // 重连后服务端重发同一份未变的状态）会因为"版本号没变"被永久跳过，
      // 预览卡死在空白或旧内容上，除非真的又有一次新编译。
      claim.fail()
    }
  }
}

// 指数退避重连的当前延迟，成功连上一次后重置。
let retryDelay = 500

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`)
  // 必须在 `new WebSocket(...)` 之后紧接着同步挂上 onmessage，不能先 await 连接
  // 建立（比如放进 onopen，或者等一个 "open" Promise）再挂监听器，重连时也一样。
  // 服务端在 wss.on('connection') 里同步发送第一条完整状态，如果客户端挂监听器
  // 慢了一拍，这条消息会永久丢失——重连后页面会白屏，要等下一次编译才有内容。
  ws.onmessage = (e) => onMessage(JSON.parse(e.data))

  ws.onopen = () => {
    retryDelay = 500
    statusEl.classList.remove('error')
    // 额外一道保险：重连成功后强制当作"还没渲染过任何版本"，这样即使服务端
    // 重发的 pdfVersion 和断线前一样，紧接着到来的那条完整状态消息也一定会
    // 触发一次重渲染，不完全依赖上面 claim/fail 的回滚逻辑覆盖到所有失败
    // 场景（比如某次失败是在还没来得及调用 claim.fail() 之前，页面本身就被
    // 关掉重开的极端情况）。
    versionTracker.reset()
  }

  ws.onclose = () => {
    summaryEl.textContent = '与 texwatch 断开，重连中…'
    statusEl.className = 'error'
    setTimeout(connect, retryDelay)
    retryDelay = Math.min(retryDelay * 2, 10_000)
  }

  ws.onerror = (err) => {
    console.error('WebSocket 错误', err)
    // 触发 onclose 里的重连逻辑；避免同一次失败重复安排两次重连。
    ws.close()
  }
}

draftEl.addEventListener('change', () => {
  ws?.send(JSON.stringify({ type: 'setDraft', value: draftEl.checked }))
})

connect()

// 版本记账：决定「要不要为这条消息里的 pdfVersion 发起一次新渲染」，以及渲染
// 失败时该不该把"已渲染版本"回滚，好让后续同版本的消息还能再次触发渲染。
// 纯逻辑、不碰 DOM，可以在 node --test 里直接跑（不需要浏览器/jsdom）。
//
// 背景（Task 14 修复轮 1 的 Important）：onMessage 必须在 await renderPdf()
// 之前就同步把 renderedVersion 置成 msg.pdfVersion——这是必要的，否则同一条
// 消息还没渲染完，下一条消息到达时会重复触发。但如果 renderPdf() 中途真的
// 失败（比如 /pdf 的 fetch 恰好和 WS 断线撞在一起），renderedVersion 已经
// "声称"渲染到了该版本，DOM 却没更新。以前唯一的恢复手段是刷新页面（会把
// renderedVersion 重置为 -1），不容易触发；Task 14 引入的断线重连不刷新页面
// ——重连后服务端会重发同一个（未变的）pdfVersion，客户端因为版本号"没变"而
// 永远跳过重渲染，预览永久卡在空白或旧版本上，直到下一次真正的新编译为止。
//
// 用 claim()/fail() 显式建模"乐观声明 + 出错回滚"，把两种容易混淆的情况分开：
//   - 【被仲裁放弃，不是失败】renderPdf() 内部有自己的 token 仲裁（见
//     client/app.js 里 renderToken 的注释）：一次渲染中途被更晚发起的渲染
//     超越时，会在写 DOM 之前静默 return，Promise 正常 resolve，不抛异常。
//     这种情况下 onMessage 的 try 块正常走完，不会进 catch，也就不会调用
//     fail()——renderedVersion 维持在（更新的）新版本是正确的，因为真正显示
//     出来的就是那个新版本。
//   - 【真正失败】renderPdf() 抛出异常时才会调用 fail()：只有在没有更新的
//     claim 已经把 renderedVersion 往前推进时才回滚到 claim 之前的版本，
//     避免用一次旧的失败结果去覆盖新版本已经声明的状态。
export function createVersionTracker(initial = -1) {
  let renderedVersion = initial

  function shouldRender(version) {
    return version > 0 && version !== renderedVersion
  }

  function claim(version) {
    const previousVersion = renderedVersion
    renderedVersion = version
    let settled = false
    return {
      fail() {
        if (settled) return // 每个 claim 句柄的 fail() 只应该生效一次
        settled = true
        // 只有在没有更晚的 claim 已经把 renderedVersion 推进到别的版本时，
        // 才回滚到这次 claim 之前的版本。
        if (renderedVersion === version) renderedVersion = previousVersion
      },
    }
  }

  // 重连时的额外保险：把记账重置成"还没渲染过任何版本"，这样即使服务端重发
  // 的是和之前一样的 pdfVersion，下一条消息也会强制重新触发一次渲染，不依赖
  // 上面的回滚逻辑是否覆盖到了所有失败场景。
  function reset() {
    renderedVersion = initial
  }

  return {
    shouldRender,
    claim,
    reset,
    get current() {
      return renderedVersion
    },
  }
}

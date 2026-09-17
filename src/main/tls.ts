import { app, session } from 'electron'
import { logger } from './logger'

/**
 * AI 请求的 HTTPS 证书校验策略。
 *
 * ## 为什么默认**不校验**
 *
 * 目标平台是 Win7 SP1。它的根证书库是随系统更新的，而 Win7 早已停止
 * 主流支持，**新根 CA 装不进去** —— 典型的就是 Let's Encrypt 的
 * ISRG Root X1 那一批。而中转站里用 Let's Encrypt 免费证书的非常多。
 *
 * 结果是：在没打过补丁的 Win7 上，Chromium 会判定证书链不可信、
 * 在建连阶段直接拒掉请求，报 `net::ERR_CERT_AUTHORITY_INVALID`。
 * 这不是「中转站配错了」，而是**这台机器老了** —— 用户无论怎么换
 * 中转站都没用。默认开着校验，等于让目标平台默认连不上。
 *
 * 所以默认 `verifyTls: false`：**能连上优先**。
 *
 * ## 那为什么还留一个开关
 *
 * 因为「不校验」是有代价的：不验证证书就无法确认对面是谁，
 * API Key 与整段对话都可能被能插进链路的人截获（公共 WiFi、
 * 被劫持的路由器、校园网的透明代理）。
 * 在证书链正常的环境（Win10/11，或打过补丁的 Win7）里，
 * 用户可以在设置里把它打开，换回这道防护。
 *
 * 开关的文案必须把两边的代价都写清楚，而不是让它看起来像个性能优化项。
 *
 * ## 关掉时是「整个会话都不校验」，不是「只放行某个域名」
 *
 * 这里曾经写的是「只对配置的中转站域名放行」，看起来更克制，
 * 但它在 Win7 上**修不好问题**：请求是 `redirect: 'follow'`，
 * 中转站完全可能 302 到另一个域名（CDN、http→https、换主域名），
 * 那一跳的证书仍然是老的、仍然会被拒 —— 用户看到的现象与没加开关一样。
 *
 * 而这个会话只承载 AI 请求：渲染层加载的是本地文件，预览服务绑在
 * 127.0.0.1 的 http 上，MCP 是独立子进程自己的 TLS。
 * 所以「整个 defaultSession 不校验」的实际影响面就是 AI 请求本身。
 *
 * ## 与 Electron API 的关系
 *
 * `setCertificateVerifyProc(null)` = 恢复 Chromium 默认校验。
 * 传入自定义 proc 时：`callback(0)` 接受，`callback(-2)` 拒绝。
 *
 * ## 调用时机（有一个真实的坑）
 *
 * `session.defaultSession` 在 **app ready 之前不可访问**，碰它就抛
 * 「Cannot access session before app is ready」。而 `initConfig()`
 * 恰恰是在 `main()` 最前面调的（那时还没 ready）——
 * 所以这里不能直接装，必须把「想要什么」记下来，等 ready 之后再落地。
 * 设置页里改开关时 app 早就 ready 了，那条路径是同步立即生效的。
 */

/** 最近一次被要求应用的策略。app ready 之前先记在这里 */
let desired: boolean | null = null

/** ready 钩子只挂一次 */
let readyHookInstalled = false

/**
 * 已经真正装上去的那个值（null = 还没装过）。
 *
 * 用「值没变就什么都不做」做短路。**这不是优化，是正确性问题**：
 * `setConfig` 在用户改**任何**设置时都会跑（字号、主题、工具开关……），
 * 而 install 里会断掉所有在飞连接。不短路的话，改一个无关设置
 * 就能把正在流式输出的 AI 回答掐断 —— 表现是「调个字号，回答没了」。
 */
let installed: boolean | null = null

/**
 * 把策略真正装到 defaultSession 上。
 *
 * 只在 app ready 之后调用，所以这里不会再撞上「session 尚不可用」。
 */
function install(verifyTls: boolean): void {
  /*
   * defaultSession 用可选链取：离线护栏（scripts/check-profile-io.mjs）
   * 用一个不含 session 的 electron 桩加载同样的代码，那里不该因为
   * 「没有网络层」而报错刷屏。
   */
  const ses = session?.defaultSession
  if (!ses) return

  // 值没变就原样返回：既省一次重装，也避免断掉在飞的 AI 流（见 installed 的注释）
  if (installed === verifyTls) return

  /*
   * 换策略之前先断掉在飞的连接。
   *
   * Electron 的文档写得很明白：**验证结果会被网络服务缓存**。
   * 不断连接的话，「刚把开关打开 → 再点测试连接」很可能复用一条
   * 已经带着旧结论的连接 / 缓存，表现是「改了开关但没有用」——
   * 而用户只会以为这个开关是坏的。
   */
  void ses.closeAllConnections().catch(() => {
    /* 断连接失败不影响策略本身，忽略 */
  })

  if (verifyTls) {
    /*
     * 关键：恢复成 null，而不是装一个「按标准来」的自定义 proc。
     * 只有这条路径能保证「开启校验」与「从没装过任何东西」完全等价。
     */
    ses.setCertificateVerifyProc(null)
    installed = true
    logger.info('tls', 'HTTPS 证书校验：已开启（Chromium 默认策略）')
    return
  }

  /*
   * 不校验。
   *
   * 直接 `callback(0)` 接受一切 —— 不做「只放行中转站域名」那种收窄，
   * 理由见文件头：redirect 会跳到别的域名，收窄等于修不好 Win7。
   */
  ses.setCertificateVerifyProc((_request, callback) => {
    callback(0)
  })
  installed = false
  logger.warn(
    'tls',
    'HTTPS 证书校验：已关闭（兼容 Win7 的旧根证书库）。' +
      '该连接无法确认对端身份，密钥与对话内容可能被中间人截获；' +
      '在证书正常的环境里建议到「设置 → AI 模型」重新开启。'
  )
}

/**
 * 应用证书校验策略。
 *
 * app ready 之前调用只是记下来（并挂一个 ready 钩子），ready 之后调用
 * 立即生效。两种情况调用方都不需要关心时序。
 */
export function applyTlsPolicy(verifyTls: boolean): void {
  desired = verifyTls

  if (app.isReady()) {
    install(verifyTls)
    return
  }

  if (!readyHookInstalled) {
    readyHookInstalled = true
    void app.whenReady().then(() => {
      // 用记下来的那一份，而不是闭包捕获的旧值：
      // ready 之前可能已经被改过好几次，只有最后一次算数
      if (desired !== null) install(desired)
    })
  }
}

/**
 * 网络错误的统一出口：证书问题给出可照做的中文，其它原样返回。
 *
 * 为什么不直接在几个错误回调里各写一遍 `describeCertificateError(msg) || msg`：
 * 那样迟早会漏掉一处 —— 而漏掉的那一处恰好就是用户撞上的那一条路径，
 * 表现是「设置里有开关、但报错里没提」，等于这个开关白做。
 */
export function describeNetworkError(message: string): string {
  return describeCertificateError(message) || `网络错误: ${message}`
}

/**
 * 把证书类网络错误翻译成能直接照做的中文。
 *
 * 默认不校验之后，这条路径主要出现在两种情况下：
 *   1. 用户自己把校验打开了（设置 → AI 模型），而对端证书确实有问题
 *   2. 校验虽然关着，但错误来自别的环节（比如系统代理拦了一道）
 *
 * 无论哪种，都要把「去哪里改」写清楚 —— 报错不指向开关，开关就等于不存在。
 *
 * 不是证书错误就返回 null，由调用方走原来的错误文案。
 */
export function describeCertificateError(message: string): string | null {
  const text = message || ''
  // Chromium 的证书错误码都是 net::ERR_CERT_* 的形状
  const match = /ERR_CERT_[A-Z_]+/.exec(text)
  if (!match) return null
  const code = match[0]

  const common =
    `中转站的 HTTPS 证书没能通过校验（${code}）。` +
    '常见原因是这台机器的根证书库太旧（Win7 上很常见）、' +
    '或者对方用的是自签名 / 已过期 / 域名对不上的证书。'

  return (
    common +
    '你可以在「设置 → AI 模型 → 校验中转站的 HTTPS 证书」里把这一项取消勾选后重试 —— ' +
    '默认就是关掉的，所以出现这条说明它被打开过。' +
    '关掉之后连接无法确认对端身份，请只在确认该地址可信时这么做。'
  )
}

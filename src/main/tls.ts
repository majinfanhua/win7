import { app, session } from 'electron'
import { logger } from './logger'

/**
 * AI 请求的 HTTPS 证书校验策略。
 *
 * ## 为什么需要这个开关
 *
 * 中转站里有一批是用**自签名证书**跑的：学校/公司内网自建，或者
 * 图省事没买证书的小站。此时 Chromium 会在建连阶段直接拒掉请求，
 * 报 `net::ERR_CERT_AUTHORITY_INVALID` —— 而那条错误以前只在界面上
 * 显示成「网络错误: net::ERR_CERT_AUTHORITY_INVALID」，
 * 学生既看不懂这句话，也没有任何地方能把它改通。
 *
 * ## 为什么默认必须是「校验」
 *
 * 关掉证书校验等于**对中间人攻击完全不设防**：API Key 与整段对话
 * 都会暴露给任何一个能插进链路的人（公共 WiFi、被劫持的路由器、
 * 校园网的透明代理）。所以默认开，且只有用户明确去设置里关才生效。
 *
 * 这里刻意**不做「探测到证书错误就自动放行」**那种贴心设计：
 * 那等于把开关的默认值变成「关」—— 因为第一个撞上自签证书的人，
 * 有可能正是被中间人拦下的那一个。必须由人显式决定。
 *
 * ## 关掉时的作用范围：只认中转站那一个域名
 *
 * 关掉校验时**不是**把整个进程的证书校验都关了 —— 那种写法会连带
 * 放过浏览器预览、以及以后任何新增的网络请求。这里只对「当前配置的
 * 中转站域名」放行不可信证书，其它域名一律照旧拒绝。
 *
 * ## 与 Electron API 的关系
 *
 * `setCertificateVerifyProc(null)` = 恢复 Chromium 默认校验。
 * 传入自定义 proc 时：`callback(0)` 接受，`callback(-2)` 拒绝。
 *
 * proc 装在 **defaultSession** 上，而 `net.request` 不指定 session 时
 * 走的正是它（`llm.ts` / `ipc/ai.ts` 都是这样）。渲染层加载的是本地
 * 文件、预览服务绑在 127.0.0.1，都不受影响。
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
let desired: { verifyTls: boolean; baseUrl: string } | null = null

/** ready 钩子只挂一次 */
let readyHookInstalled = false

/**
 * 已经真正装上去的那份策略（null = 还没装过）。
 *
 * 用它做「值没变就什么都不做」的短路。**这不是优化，是正确性问题**：
 * `setConfig` 在用户改**任何**设置时都会跑（字号、主题、工具开关……），
 * 而 install 里会断掉所有在飞连接。不短路的话，改一个无关设置
 * 就能把正在流式输出的 AI 回答掐断 —— 表现是「调个字号，回答没了」。
 */
let installed: { verifyTls: boolean; baseUrl: string } | null = null

/** 从配置的地址里取主机名；取不到返回空串 */
function hostOf(baseUrl: string): string {
  const raw = (baseUrl || '').trim()
  if (!raw) return ''
  try {
    // 用户可能没写协议（normalizeBaseUrl 只补 /v1，不补协议），补一个再解析
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 判断两份策略是否等价（等价就没有必要重装、更不该断连接） */
function samePolicy(
  a: { verifyTls: boolean; baseUrl: string } | null,
  b: { verifyTls: boolean; baseUrl: string }
): boolean {
  // 域名也要比：verifyTls=false 时放行的是那个具体域名，换了地址就得重装
  return Boolean(a && a.verifyTls === b.verifyTls && hostOf(a.baseUrl) === hostOf(b.baseUrl))
}

/**
 * 把策略真正装到 defaultSession 上。
 *
 * 只在 app ready 之后调用，所以这里不会再撞上「session 尚不可用」。
 */
function install(verifyTls: boolean, baseUrl: string): void {
  /*
   * defaultSession 用可选链取：离线护栏（scripts/check-profile-io.mjs）
   * 用一个不含 session 的 electron 桩加载同样的代码，那里不该因为
   * 「没有网络层」而报错刷屏。
   */
  const ses = session?.defaultSession
  if (!ses) return

  const next = { verifyTls, baseUrl }
  // 值没变就原样返回：既省一次重装，也避免断掉在飞的 AI 流（见 installed 的注释）
  if (samePolicy(installed, next)) return

  /*
   * 换策略之前先断掉在飞的连接。
   *
   * Electron 的文档写得很明白：**验证结果会被网络服务缓存**。
   * 不断连接的话，「刚把开关关掉 → 再点测试连接」很可能复用一条
   * 已经带着旧结论的连接 / 缓存，表现是「改了开关但没有用」——
   * 而用户只会以为这个开关是坏的。
   */
  void ses.closeAllConnections().catch(() => {
    /* 断连接失败不影响策略本身，忽略 */
  })

  if (verifyTls) {
    /*
     * 关键：恢复成 null，而不是装一个「总是接受」的 proc。
     * 只有这条路径能保证「默认」与「从没装过任何东西」完全等价。
     */
    ses.setCertificateVerifyProc(null)
    installed = next
    logger.info('tls', 'HTTPS 证书校验：已开启（Chromium 默认策略）')
    return
  }

  const allowedHost = hostOf(baseUrl)
  ses.setCertificateVerifyProc((request, callback) => {
    /*
     * 证书本身没问题就照常放行 —— 关掉校验不代表要绕过正常验证，
     * 只是不再因为「链不可信」而拒绝。
     */
    if (request.verificationResult === 'OK') {
      callback(0)
      return
    }
    /*
     * 只对中转站那一个域名放行。
     *
     * hostname 取不到（allowedHost 为空，比如用户还没填地址）时一律拒绝：
     * 「配置不完整」不该被翻译成「对所有域名都不校验」。
     */
    const host = (request.hostname || '').toLowerCase()
    if (allowedHost && host === allowedHost) {
      logger.warn(
        'tls',
        `已按设置放行 ${host} 的不可信证书（${request.verificationResult}）—— 该连接的机密性无保障`
      )
      callback(0)
      return
    }
    /*
     * 非中转站域名保持拒绝。
     * 注意这里**不能**「忽略掉、当作没装过 proc」—— 装上了就必须给结论。
     */
    callback(-2)
  })

  logger.warn(
    'tls',
    allowedHost
      ? `HTTPS 证书校验：已关闭（仅对 ${allowedHost} 放行不可信证书，其它域名照旧拒绝）`
      : 'HTTPS 证书校验：已关闭，但接口地址为空，因此实际不放行任何域名'
  )
  installed = next
}

/**
 * 应用证书校验策略。
 *
 * app ready 之前调用只是记下来（并挂一个 ready 钩子），ready 之后调用
 * 立即生效。两种情况调用方都不需要关心时序。
 */
export function applyTlsPolicy(verifyTls: boolean, baseUrl: string): void {
  desired = { verifyTls, baseUrl }

  if (app.isReady()) {
    install(verifyTls, baseUrl)
    return
  }

  if (!readyHookInstalled) {
    readyHookInstalled = true
    void app.whenReady().then(() => {
      // 用记下来的那一份，而不是闭包捕获的旧值：
      // ready 之前可能已经被改过好几次，只有最后一次算数
      if (desired) install(desired.verifyTls, desired.baseUrl)
    })
  }
}

/**
 * 网络错误的统一出口：证书问题给出可照做的中文，其它原样返回。
 *
 * 为什么不直接在三个错误回调里各写一遍 `describeCertificateError(msg) || msg`：
 * 那样迟早会漏掉一处 —— 而漏掉的那一处恰好就是用户撞上的那一条路径，
 * 表现是「设置里有开关、但报错里没提」，等于这个开关白做。
 */
export function describeNetworkError(message: string): string {
  return describeCertificateError(message) || `网络错误: ${message}`
}

/**
 * 把证书类网络错误翻译成能直接照做的中文。
 *
 * 这段的存在理由与开关本身一样重要：**报错不指向开关，开关就等于不存在**。
 * 学生看到「ERR_CERT_AUTHORITY_INVALID」只会以为程序坏了，
 * 而实际上只要去设置里关掉一个开关就能用（代价写在那条设置下面）。
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
    '常见原因是该地址用的是自签名证书，或者证书已过期 / 域名对不上。'

  switch (code) {
    case 'ERR_CERT_AUTHORITY_INVALID':
    case 'ERR_CERT_COMMON_NAME_INVALID':
    case 'ERR_CERT_DATE_INVALID':
    case 'ERR_CERT_REVOKED':
    case 'ERR_CERT_INVALID':
      return (
        common +
        '如果这个中转站是你自己搭的、或者你确认它是可信的，' +
        '可以在「设置 → AI 模型 → 允许不安全的 HTTPS 证书」里关掉校验后重试；' +
        '否则请先找管理员换一张正规证书 —— 关掉校验会让密钥与对话内容可能被他人截获。'
      )
    default:
      return `${common}请检查中转站地址是否写错。`
  }
}

# HangKe 开发记录索引

给后来者（包括下次的 AI）快速接手用。**先读这里，再按需展开 ./claude/ 下的细分文件。**

## 这是什么项目

带 AI 助手的桌面代码编辑器，Electron 22 + React 18 + Monaco，**目标运行环境是 Windows 7 SP1 及以上**。
AI 不只是聊天：它能读写工作区里的文件，在 Win10/11 上还能跑命令（Win7 上不能，见下）。

## 三条不能忘的硬约束

1. **Win7 是硬目标**：Chromium 锁 108、Node 锁 16。`npm run check:node16` 会扫源码里用到的 Node API 是否都支持。
2. **不能上 Electron 23+**：那版起 Chromium 110，Win7 跑不起来。
   **打包只走 GitHub Actions**（本地 `npm run dist:win` 会被 `scripts/guard-ci.mjs` 拦住）——
   交叉打包的产物与 CI 不一致，测了没意义。本地只做三件静态检查。
3. **单文件不超 800 行**（这是目标，不是现状 —— 见下面的欠账）。
   `useAppStore.ts` 曾是 1100 行，已拆成三个 slice（session / tree / editor）——
   **别再合回去**：改文件树的移动逻辑不该碰到会话逻辑，这是拆它的全部理由。
   依赖方向是单向的 `editor → tree → session`，反向调用会让循环 import 爆炸。
   已经拆过、同样**别再合回去**的：
   - `store/explorer-helpers.ts`：文件树/排序/标签恢复的纯函数
   - `store/confirm.ts`：`askConfirm` / `askUnsaved`（tree 与 editor 都要用，避免互相 import）
   - `dev-stub-fs.ts`：浏览器预览的内存文件系统
   - `components/file-tree/`：文件树的行为（`useFileTreeController`）与外壳分开
   - `main/shell.ts`：解释器定位与临时脚本（capabilities 与 exec 共用）
   - `main/tools/search-tools.ts`：Glob / Grep
   - `main/runtimes.ts`：python / node 等运行时探测
   注意 `parentOf` 已经从 useAppStore 删掉、统一用 `explorer-helpers` 的
   `parentDirOf`（import 时 as 重命名成 parentOf）—— 曾经两份实现并存过。
   样式已按界面区块拆成 `styles/` 下的十三份 ——
   **层叠顺序写在 `styles/index.css`，动样式前先看那份注释。**

   ⚠️ **当前有 8 个文件超了 800 行**（这份文档以前写着「最长 407 行」，
   是过期信息）。按严重程度：`components/AiPanel.tsx`（1867）、
   `main.tsx`（1402，大半是自检断言）、`components/SettingsPage.tsx`（1259）、
   `styles/chat.css`（1011）、`main/ipc/ai.ts`（994）、`shared/types.ts`（929）、
   `dev-api-stub.ts`（911）、`scripts/check-profile-io.mjs`（890）。
   **动这几个文件时优先考虑顺手拆一刀**，别再往里加。

4. **Electron 里 `window.prompt` 不可用**（调用即抛错、不弹框）。
   任何「让用户输入一个名字」的地方都必须走应用内弹层：
   `components/InputDialog.tsx`（原语）→ `components/NewEntryDialog.tsx`（新建文件/文件夹）。
   `alert` / `confirm` 是好的，只有 `prompt` 被移除。**这是「新建文件点了没反应」的根因。**

5. **主进程的「单向推送」必须在渲染层有消费者**。踩过两次，都是同一类错误：
   - `evtLog`（日志）：主进程 `pushLog` 一路写进 `store.logs`，但渲染层从来
     没订阅 `onLog`，也没渲染过它 —— 于是 `handleFileChanged` 在
     「AI 改了文件但编辑器里有未保存改动」时唯一的动作（pushLog 一条 warn）
     学生**看不到**，界面上什么都不会发生。
   - 菜单动作：`doctor` / `about` 早就发了，`onMenu` 不处理 = 点了没反应。
   **新增任何 `evt*` 通道或 `sendMenu` 动作时，顺手确认对面有人接**，
   否则它就是一个静默失效的功能，而且不会报错。

## 常用命令

```bash
npm run typecheck    # 主进程 + 渲染层两份 tsconfig
npm run build        # 会先跑全部护栏（17 道）再 electron-vite build
npm run smoke        # 启动窗口自检（Linux 无 DISPLAY 时自动套 xvfb）
npm run check:watch  # 纯 Node 校验文件监视时序

# 自检支持追加参数，用来复现 CI 的那几次不同配置
npm run smoke -- --capability-profile=win7
```

> **打包收尾（给 zip 套一层顶层文件夹）没有本地命令。**
> 它只由 electron-builder 的 `afterAllArtifactBuild` 钩子调用，
> 想验那套逻辑请跑 `npm run check:zipwrap`（自造 zip 做字节级断言，
> 不碰打包、不需要产物）。理由见下面「打包产物」一节 ——
> 本地开发机是 Linux，而打包只出 Windows 包。

## CI 失败时怎么定位

**拿不到 job 日志。** `actions/jobs/<id>/logs` 接口需要仓库 admin 权限，无 token 时返回 403。
但下面两样是公开可读的（不用 token，直接 curl 即可）：

```bash
# 各步骤的结论与耗时 —— 耗时很能说明问题
curl -s https://api.github.com/repos/majinfanhua/win7/actions/jobs/<job_id>
# 失败注解（::error / ::warning 都会出现在这里）
curl -s https://api.github.com/repos/majinfanhua/win7/check-runs/<job_id>/annotations
```

所以构建链特意做了两件事，**改动 CI 时请保持**：

1. **护栏拆成独立步骤**（Node 16 检查 / 文件监视检查 / electron-vite 构建），不串在
   `npm run build` 里。合成一步就只知道「构建失败」，分不清是哪个护栏。
2. **失败输出用 `::error title=...::` 注解发出去**。日志要权限，注解不要。

判断小技巧：看步骤耗时。比如「构建」只跑了 6 秒就挂，而 `check:node16` 只要约 0.5 秒、
`check:watch` 固定耗时约 5.3 秒 —— 6 秒正好说明挂在 `check:watch` 的断言上。

## 架构速览

| 层 | 位置 | 说明 |
|---|---|---|
| 主进程 | src/main/ | 窗口、IPC、文件监视、工具执行、快照、解释器/运行时探测 |
| 预加载 | src/preload/index.ts | 唯一的渲染层 API 出口（无 nodeIntegration） |
| 渲染层 | src/renderer/src/ | React 界面 |
| 共享契约 | src/shared/ | 主/渲染两侧共用的类型与 IPC 通道常量 |

界面两栏：左侧栏（项目/会话/文件树）+ 内容区（编辑器在左、对话在右，中间可拖拽）。

### AI 工具能力（改动最频繁的一块）

```
config.capability（人愿意放开到哪）
   ∩  capabilities.ts 的探测（这台机器实际能做到哪）
   − disabled（逐项关掉）
   =  发给模型的工具表（tools/meta.ts 的 TOOL_SCHEMAS 过滤后）
```

结果是：**Win7 与 Win10/11 现在都是 18 个工具**
（文件 8 + 命令 4 + 记忆/会话 4 + 技能 2）。
同一份包、同一套代码，差的是探测结果 —— 命令类那 4 个在没找到
cmd.exe 的机器上会被过滤掉，其余 14 个不依赖外部程序。

⚠️ 这里改过一次判断：以前 Win7 分支**直接写死** `commandExec = false`，
理由是「只有 cmd.exe，PowerShell 要装 WMF」—— 那个理由站不住，
cmd.exe 在所有 Windows 上都有，python/node 装好会写进 PATH。
代价是 Win7 白白少掉 4 个工具。现在统一「探测到 cmd 就启用」。

| 文件 | 干什么 |
|---|---|
| `tools/meta.ts` | 工具清单 / 中文名 / 能力要求 / 模型可见的 schema |
| `tools/limits.ts` | 数值上限（超时、输出）。schema 与实作共用，别分两处写 |
| `tools/file-tools.ts` | 跨系统那 6 个文件工具的实作 |
| `tools/exec.ts` | 命令执行底层：PowerShell / 编码 / 超时 / 杀进程树 |
| `tools/command-tools.ts` | 命令类 4 个工具的实作与结果文案 |
| `tools/jobs.ts` | 后台任务注册表（jobRun / jobPoll / jobKill 的落点） |
| `tools/index.ts` | 调度：过滤工具表 + 执行 + 把失败变成可读错误 |
| `tools/snapshot.ts` | 写盘前存原文，供「撤销」 |

新增一个工具要同步改五处（主进程实作 / `IMPLEMENTED_TOOLS` / `TOOL_SCHEMAS` / 实作表 / 自检），
漏一处就静默失败。

### 界面上的几条硬约束（改之前先看）

- **弹层（`.overlay`）必须是 `position: fixed`**。它会被渲染在左侧栏内部，
  而侧栏有 `overflow: hidden` —— 用 `absolute` 的话 560px 宽的弹窗会被
  232px 的栏裁掉，右边一大截和底部按钮都点不到。学生看到的是
  「弹窗被按钮挡住了」。z-index 50 > 右键菜单的 40。
- **`.dialog` 必须有 `background`**。它没有挂 `.glass`，背景色只能自己写 ——
  漏了就是**透明弹窗**，后面的文件树直接透出来，文字叠文字。
- **`.chat` 必须有 `flex: 1`**。少了它，高度由内容决定，消息少的时候
  输入框会悬在半空而不是贴底。配套 `.chat-scroll { flex: 1 }` 把
  多余高度全给消息区。
- **折叠按钮在顶栏最左侧，不在侧栏里**。曾经在侧栏自己头上，
  收起后它被挤进 52px 的图标列、和别的图标长得一样 ——
  学生找不到「把栏拉回来」的入口，界面等于坏了。
- **新建文件的类型胶囊跟着名字里的扩展名走**（打 `a.css` 就高亮 CSS）。
  文件名是主输入，类型是它的推论；胶囊只是给不想敲扩展名的人用的快捷方式。
  这是 VS Code 的做法，也避免「胶囊高亮 HTML 而名字是 .css」的自相矛盾。

### 其他本轮新增的模块

| 文件 | 干什么 |
|---|---|
| `main/shell.ts` | 解释器定位（cmd/powershell）、临时 .cmd 脚本、启动清扫 |
| `main/tools/search-tools.ts` | Glob / Grep 的实现（自写 glob 匹配，不引库）|
| `main/runtimes.ts` | 探测 python / node / git 等，结果进 system prompt |
| `main/stream-watchdog.ts` | 流式超时的全部规则（停顿看门狗，见下）|
| `shared/chat-text.ts` | 聊天气泡正文的换行清理（纯函数、幂等）|
| `scripts/zip-wrap-folder.mjs` | 打包收尾：给 zip 套一层顶层文件夹 |
| `renderer/src/image-input.ts` | 图片压缩（canvas → JPEG，长边 1568）|
| `renderer/src/snippets.ts` | `!` / `css` / `js` 等触发词片段，与 file-templates 共用数据 |
| `renderer/src/components/LogDrawer.tsx` | 底部日志抽屉 |
| `main/tls.ts` | AI 请求的 HTTPS 证书校验策略（**默认不校验**，兼容 Win7 的旧根证书库；设置里可开启）|

**搜索工具的两条约束**（改之前先看 `search-tools.ts` 的头注释）：
不引 `fast-glob` / `minimatch`（依赖链长、启动开销），
不引 ripgrep（每平台一个 exe，Win7 杀软误报率高）。
自己实现的 `compileGlob` 支持 `*` `?` `**` `[abc]`，
**不支持 `{a,b}` 时明确报错而不是静默当字面量**。

**内嵌预览面板已删除**（顶栏那个第三栏）。现在「预览文件」只有一条路：
右键 HTML → 用系统浏览器打开，走的是绑在 `127.0.0.1` 的临时静态服务。
所以 `--preview-share`、`PreviewPane.tsx`、`wsPreviewUrl` 这些都不存在了 ——
**看到旧文档提到它们时，那是过期内容，不是要你去实现的东西**。

**AI 请求的 HTTPS 证书校验**（`main/tls.ts`）：
**默认不校验**。原因是目标平台：Win7 的根证书库随系统更新，
而 Win7 早已停止主流支持，新根 CA（Let's Encrypt 的 ISRG Root X1 等）
装不进去，而中转站用免费证书的非常多 —— 开着校验会让 Win7 默认
连不上，报 `net::ERR_CERT_AUTHORITY_INVALID`，用户会以为软件坏了。
设置里留了开关，证书链正常的环境（新装 Win10/11）可以勾上换回防护。

三条容易写错的地方：
1. `config.ts` 的 normalize 里必须是 `input.verifyTls === true`。
   写成 `!== false` 是**错的**：老配置没有这个字段，
   `undefined !== false` 得到 true，等于**给老用户升级后静默打开校验** ——
   在 Win7 上表现为「升级前能用、升级后连不上」。
2. 不校验就是 `callback(0)` 放行一切，**不做「只放行中转站域名」的收窄**：
   请求是 `redirect: 'follow'`，302 到别的域名时那一跳仍会被拒，
   收窄在 Win7 上等于没修好。
3. `session.defaultSession` 在 app ready 之前不可访问，而这个策略是在
   `initConfig()`（main 最前面）里装的 —— 所以 `tls.ts` 会先记下来、
   挂 `app.whenReady()` 再落地，不能直接同步装。

**图片输入只在最后这一轮带图**：历史消息只发文本。base64 有几 MB，
每轮重发会让同一张图被计费十几次，部分中转站还会因请求体过大直接 413。

**流式超时是「停顿」判定，不是「一轮 N 秒」**（`main/stream-watchdog.ts`）。
原来的 `setTimeout(120_000)` 覆盖**整次 HTTP 往返**（建连 + 等首字 + 输出），
是「总时长上限」而非「空闲上限」，导致
「AI 明明在输出却被超时结束」（长回答超过 2 分钟必被砍）与
「改代码改到一半被中断」（要调 editFile 的那一轮，参数还没吐完就被掐断；
工具**执行**本身不在计时范围内，那时表已撤）。
现在：每收到一片数据就重置（5 分钟），另加一个 15 分钟的单轮硬上限兜底
（防「一直发心跳、模型永不答」）。
`scripts/check-idle-timeout.mjs` 钉住这个写法 —— 光把常量改大不算修好。

**聊天气泡正文要过一遍 `normalizeChatText`**（`shared/chat-text.ts`）。
一次回答由好几轮拼成，每轮正文都带换行，不清理就是「每执行一次工具，
气泡就多一片空白」。三条不能动的规则：**只压连续空行**（保留一个空行的分段）、
**只动行尾**（行首缩进是代码，且结果会存进会话记录）、**必须幂等**。
测试在 `scripts/check-chat-text.mjs`。

**打包产物 zip 里有一层顶层文件夹**，靠 `afterAllArtifactBuild` 钩子
（`scripts/zip-wrap-folder.mjs`）在打包后**直接改 zip 字节**实现 ——
electron-builder 24.x 的 zip 目标在 Windows 上写死平铺，配置里改不了。
压缩数据原样搬运（CRC / 时间戳 / 压缩方法 / UTF-8 标志位都不动），
名字在 local header 与中央目录里各存一份、两份都要加前缀，
CD 里的 local 偏移要按**累计**平移量改。

⚠️ **第一版调外部 `7za rn` 在 CI 上挂了**，这个坑值得记住：
它依赖「外部 7za 的版本行为」（开发机 Linux p7zip 16.02 vs runner
Windows 7-Zip 21.07）与「7za 的文本输出」（按控制台代码页输出文件名，
英文 runner 表示不了「使用说明.txt」，读回乱码后 `rn` 匹配不到，
**而退出码仍是 0**）。**本项目只出 Windows 包，拿 Linux 的 7za 验证等于没验证。**
现在纯 Node、零外部进程。护栏 `scripts/check-zip-wrap.mjs` 钉住那串细节
（名字存两份、偏移累计平移、元数据不变、幂等、Zip64 要拒绝）。

### 图标

`scripts/make-icon.py` 从 `build/logo-source.png`（竖版 logo：火箭 / 中文 / 英文）
**裁出火箭那一段**生成全部图标。为什么必须裁：竖版直接缩放当图标的话，
256px 下每个字只有几个像素，等于一团噪点。

产物：`build/icon.ico`（打包）/ `resources/icon.png`（窗口）/
`src/renderer/public/logo.png`（界面左上角、欢迎页、关于页）/ `favicon.png`。

界面里**只有一种火箭**：欢迎页、左上角、关于页都用同一张 `logo.png`，
不再有手绘的 `RocketIcon`（已删除）。

### 样式（`src/renderer/src/styles/`）

按界面区块分文件，入口是 `index.css`。**只在 main.tsx 里 import 这一个入口** ——
层叠顺序是契约，散在组件里就看不见了。

| 文件 | 行数 | 管什么 |
|---|---|---|
| `index.css` | 52 | 入口。只放 @import 与顺序说明 |
| `base.css` | 362 | 主题变量、基础元素、控件、布局骨架 |
| `ui.css` | 134 | 通用原语（自绘下拉 `Select`）。**紧跟 base**：依赖它的变量，又要被后面的组件样式覆盖 |
| `chat.css` | 1011 | 对话面板：消息气泡、空态/欢迎、输入区、引用胶囊、会话抬头、授权卡片。**已超 800 行，再加东西前先拆** |
| `dialog.css` | 236 | 弹窗与表单原语（含 `ConfirmDialog` 的实心危险按钮）|
| `settings.css` | 772 | 设置页（已并入原 settings-extra.css）|
| `dormant.css` | 169 | 暂未渲染的界面（输出）。**看着没人用也不要删** —— 里面的 `.report` 系列正被 `DoctorDialog` 用着 |
| `sidebar.css` | 734 | 左侧栏：导航、文件树、右键菜单、拖拽落点 |
| `explorer.css` | 290 | 文件树工具栏 / 排序 / 弹层补充（含 `MoveDialog`）。**必须在 sidebar.css 之后、responsive.css 之前** |
| `logs.css` | 71 | 底部日志抽屉外壳。**必须在 dormant.css 之后**（那里面已有一份 `.logs`）|
| `topbar.css` | 191 | 顶栏 |
| `responsive.css` | 51 | 所有 `@media`。**必须最后** |
| `editor.css` | 102 | 编辑器面板。**必须在拆分文件之后** |

改样式前必读的四条顺序约束（也写在 `index.css` 里）：`base` 最前、
`responsive` 在拆分文件里最后、`editor.css` 在所有拆分文件之后、
`explorer.css` 在 `sidebar.css` 之后但在 `responsive.css` 之前。
另外 `.nav-item` 在 `settings.css` 与 `sidebar.css` 里各有一份，靠顺序共存。

### 文件树

**只有一个形态**：嵌在左侧栏的「文件树」分组里。
曾经还有一个占满内容区的整页「资源管理器」视图（`ExplorerPanel.tsx`），
已按用户要求**彻底删除** —— 它与侧栏那份是同一逻辑的第二套皮，
两边都要跟着改，改一边漏一边就出现行为不一致。

改之前先理清这两句话：

- **行为只有一份**：全部交互（右键菜单、新建/重命名弹层、排序、落点计算、面包屑）
  都在 `components/file-tree/useFileTreeController.ts` 里；外壳只负责头与工具栏。
- **右键菜单的落点语义**（`resolveParentDir`）：右键文件夹 → 进它；右键文件 → 它同级；右键空白 → 项目根。
  这是「建完文件夹接着在里面建 html」能成立的地方，改动前先看那段注释。

| 文件 | 管什么 |
|---|---|
| `components/FileTree.tsx` | 装配容器（快捷键挂在这里）|
| `components/file-tree/TreeNode.tsx` | 递归节点。**保留 `data-path` / `data-kind` / `.tree-node` / `paddingLeft: 6 + depth*13`**，自检脚本依赖 |
| `components/file-tree/TreeToolbar.tsx` | 工具栏按钮 + 排序下拉 |
| `components/file-tree/tree-menu.ts` | 菜单项定义与「失效置灰」规则（纯函数）|
| `components/file-tree/TreeOverlays.tsx` | 右键菜单浮层 + 新建/重命名/移动弹层 |
| `components/file-tree/useFileTreeController.ts` | 上面这些的全部行为 |
| `components/file-tree/MoveDialog.tsx` | 「移动到…」目录选择器（拖拽的等价备选路径）|
| `components/file-tree/shared.ts` | 扩展名 / 基名 / 图标短标签 / `isDescendantOf` |
| `file-templates.ts` | 新建文件时的初始骨架（HTML / CSS / JS / MD / JSON / TXT）|
| `store/explorer-helpers.ts` | `sortNodesBy` / `extOf` / `baseName` / `parentDirOf` / `tabsFromSession` 等纯函数 |
| `dev-stub-fs.ts` | 浏览器预览的内存文件系统（`files` / `dirs` / `readDirSync` / `stubMtime`）|
| `components/InputDialog.tsx` | 应用内输入弹层原语（**替代 `window.prompt`**）|
| `components/NewEntryDialog.tsx` | 新建文件/文件夹弹层（类型胶囊 + 落点面包屑 + 重名校验）|

排序偏好落在 `config.explorer.sortBy`（`'name' | 'type' | 'mtime'`），
**新增枚举值要同步改 `src/main/config.ts` 的 `normalizeExplorer()` 白名单**，
否则会被静默吞掉。`FileNode.mtime` 由主进程 `wsReadDir` 一次 `statSync` 带上（size 与 mtime 同一次 stat）。

### 拖拽移动（文件树）

**两条等价路径，一份行为**：树上直接拖到目标文件夹上，或右键「移动到…」弹层。
两者最终都调 `store.moveEntry` → 主进程 `wsMove`，不存在两套移动逻辑。

| 位置 | 干什么 |
|---|---|
| `TreeNode.tsx` | 原生 HTML5 DnD（`draggable` + dragstart/dragover/drop）。**dragover 必须 preventDefault**，漏了 drop 根本不派发 |
| `store.dropOn` | 界面层的合法性过滤（自己、自己的目录、自己的子孙）——非法时静默 |
| `MoveDialog.tsx` | 备选路径：目标在折叠深层目录、或鼠标拖不稳时用 |
| `main/ipc/workspace.ts` 的 `wsMove` | **权威守卫**（渲染层路径不可信）：重名拦住、目录环拦住、跨盘回退 copy+unlink |

拖拽状态（`dragPath` / `dropTarget`）放 store 而不是组件 state：
TreeNode 是递归渲染的，拖拽起点在另一个节点里，只有公共祖先能同时看到两边。

### 未保存改动（dirty）的三道守卫

`EditorTab.dirty` 以前只用来在标签上画一个 `•`，**不拦任何操作** ——
学生改了文件没存、点了标签上的 × 或换了项目，改动无声消失。
这和 README 里「绝不覆盖学生未保存改动」是同一条原则的两个面：
那条守的是 AI 写入路径，这三道守的是关闭路径。

| 入口 | 实现 | 行为 |
|---|---|---|
| 关标签 × | `store.closeTabChecked` | 二次确认：「先保存」/「放弃」（再问一次）/「取消」 |
| 换项目 | `store.confirmLeaveWorkspace` | 逐个保存，**有一个存不上就取消整个切换** |
| 关窗口 | `App.tsx` 的 `beforeunload` | 有脏标签就 `preventDefault()`，走 Chromium 原生确认框 |

`closeTab`（无守卫）与 `closeTabChecked`（有守卫）**必须分开**：
前者还被「文件已删除」「重命名」这些非用户主动路径调用，
在那些路径上弹「要保存吗」是纯干扰。

### 目录变更后的缓存失效（`forgetSubtrees`）

`childMap` 是「路径 → 该目录的子项」的缓存，`toggleDir` 靠 `if (!childMap[dir])`
判断「加载过没有」。**删目录 / 改名目录 / 移动目录之后必须调 `forgetSubtrees`**，
否则重名的目录重建后会被判定为「已加载」而直接显示旧内容 —— 幽灵文件。
同一个函数也清 `expanded`，因为那些 key 同样指向已经不存在的路径。

顺带：删除 / 移动目录时，**打开着的标签要按前缀一起处理**。
只按精确路径匹配的话，那些标签会留在界面上，一点保存就把刚删掉的目录建回来。

## 详细记录

- ./claude/todo.md —— **未完成的事、坑、需要验证的点**（要动代码前先看这份）
- ./docs/7gai工具对照与实现规划.md —— 工具范围与门控设计（§6.9 记了命令类工具的关键决策）
- ./docs/多系统-测试清单.md —— 分发前真机验证清单
- ./docs/技术框架方案.md —— 完整技术方案
- README.md —— 面向使用者的功能说明与架构取舍理由（踩过的坑基本都写在这里）

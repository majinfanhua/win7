# HangKe 开发记录索引

给后来者（包括下次的 AI）快速接手用。**先读这里，再按需展开 ./claude/ 下的细分文件。**

## 这是什么项目

带 AI 助手的桌面代码编辑器，Electron 22 + React 18 + Monaco，**目标运行环境是 Windows 7 SP1 及以上**。
AI 不只是聊天：它能读写工作区里的文件，在 Win10/11 上还能跑命令（Win7 上不能，见下）。

## 三条不能忘的硬约束

1. **Win7 是硬目标**：Chromium 锁 108、Node 锁 16。`npm run check:node16` 会扫源码里用到的 Node API 是否都支持。
2. **不能上 Electron 23+**：那版起 Chromium 110，Win7 跑不起来。
3. **单文件不超 800 行**。当前最长的 TS/TSX 是 `src/renderer/src/dev-api-stub.ts`（757 行），
   再加东西就该拆。样式已按界面区块拆成 `styles/` 下的十份，最长的是 `sidebar.css`（599 行）——
   **层叠顺序写在 `styles/index.css`，动样式前先看那份注释。**

## 常用命令

```bash
npm run typecheck    # 主进程 + 渲染层两份 tsconfig
npm run build        # 会先跑 check:node16 与 check:watch
npm run smoke        # 启动窗口自检（Linux 无 DISPLAY 时自动套 xvfb）
npm run check:watch  # 纯 Node 校验文件监视时序

# 自检支持追加参数，用来复现 CI 的那几次不同配置
npm run smoke -- --capability-profile=win7
```

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
| 主进程 | src/main/ | 窗口、IPC、文件监视、工具执行、快照 |
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

结果是：**Win7 上 6 个工具，Win10/11 上 10 个**。同一份包、同一套代码，差的是探测结果。

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

### 样式（`src/renderer/src/styles/`）

按界面区块分文件，入口是 `index.css`。**只在 main.tsx 里 import 这一个入口** ——
层叠顺序是契约，散在组件里就看不见了。

| 文件 | 行数 | 管什么 |
|---|---|---|
| `index.css` | 35 | 入口。只放 @import 与顺序说明 |
| `base.css` | 347 | 主题变量、基础元素、控件、布局骨架 |
| `chat.css` | 450 | 对话面板：消息气泡、空态/欢迎、输入区、引用胶囊 |
| `dialog.css` | 106 | 弹窗与表单原语 |
| `settings.css` | 397 | 设置页（已并入原 settings-extra.css）|
| `dormant.css` | 169 | 暂未渲染的界面（输出/体检）。**看着没人用也不要删** |
| `sidebar.css` | 599 | 左侧栏：导航、文件树、右键菜单 |
| `topbar.css` | 156 | 顶栏 |
| `responsive.css` | 44 | 所有 `@media`。**必须最后** |
| `editor.css` | 108 | 编辑器面板。**必须在拆分文件之后** |

改样式前必读的三条顺序约束（也写在 `index.css` 里）：`base` 最前、
`responsive` 在拆分文件里最后、`editor.css` 在所有拆分文件之后。
另外 `.nav-item` 在 `settings.css` 与 `sidebar.css` 里各有一份，靠顺序共存。

## 详细记录

- ./claude/todo.md —— **未完成的事、坑、需要验证的点**（要动代码前先看这份）
- ./docs/7gai工具对照与实现规划.md —— 工具范围与门控设计（§6.9 记了命令类工具的关键决策）
- ./docs/多系统-测试清单.md —— 分发前真机验证清单
- ./docs/技术框架方案.md —— 完整技术方案
- README.md —— 面向使用者的功能说明与架构取舍理由（踩过的坑基本都写在这里）

# HangKe 开发记录索引

给后来者（包括下次的 AI）快速接手用。**先读这里，再按需展开 ./claude/ 下的细分文件。**

## 这是什么项目

带 AI 助手的桌面代码编辑器，Electron 22 + React 18 + Monaco，**目标运行环境是 Windows 7 SP1 及以上**。
AI 不只是聊天：它能读写工作区里的文件，在 Win10/11 上还能跑命令（Win7 上不能，见下）。

## 三条不能忘的硬约束

1. **Win7 是硬目标**：Chromium 锁 108、Node 锁 16。`npm run check:node16` 会扫源码里用到的 Node API 是否都支持。
2. **不能上 Electron 23+**：那版起 Chromium 110，Win7 跑不起来。
3. **单文件不超 800 行**。当前最长的 TS/TSX 是 `src/renderer/src/dev-api-stub.ts`（757 行），
   再加东西就该拆；CSS 那边 `global.css` 已 2100+ 行，是笔待还的债，见 ./claude/todo.md。

## 常用命令

```bash
npm run typecheck    # 主进程 + 渲染层两份 tsconfig
npm run build        # 会先跑 check:node16 与 check:watch
npm run smoke        # 启动窗口自检（Linux 无 DISPLAY 时自动套 xvfb）
npm run check:watch  # 纯 Node 校验文件监视时序

# 自检支持追加参数，用来复现 CI 的那几次不同配置
npm run smoke -- --capability-profile=win7
```

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

## 详细记录

- ./claude/todo.md —— **未完成的事、坑、需要验证的点**（要动代码前先看这份）
- ./docs/7gai工具对照与实现规划.md —— 工具范围与门控设计（§6.9 记了命令类工具的关键决策）
- ./docs/多系统-测试清单.md —— 分发前真机验证清单
- ./docs/技术框架方案.md —— 完整技术方案
- README.md —— 面向使用者的功能说明与架构取舍理由（踩过的坑基本都写在这里）

import type { ToolName, ToolRequirement } from '../../shared/types'

/**
 * 工具元数据。
 *
 * 单独一个文件、不 import 任何东西，是为了让能力探测（capabilities.ts）
 * 能拿到工具清单而不会和工具实现互相 import 成环。
 */

/** 跨系统都能跑的工具：纯文件操作，不依赖任何外部程序 */
export const CROSS_OS_TOOLS: ToolName[] = [
  'readFile',
  'writeFile',
  'editFile',
  'multiEdit',
  'listDir',
  'undoSnapshot'
]

/** 全部规划中的工具（含尚未实现的），用于设置界面展示与门控计算 */
export const ALL_TOOLS: ToolName[] = [
  ...CROSS_OS_TOOLS,
  'runCommand',
  'jobRun',
  'jobPoll',
  'jobKill'
]

/**
 * 已经实现、可以真正交给模型的工具。
 * 尚未实现的工具即使门控通过也不会进工具表 —— 模型看不到就不会去调。
 */
export const IMPLEMENTED_TOOLS: ToolName[] = [...CROSS_OS_TOOLS]

export const TOOL_REQUIREMENTS: Record<ToolName, ToolRequirement> = {
  readFile: 'none',
  writeFile: 'none',
  editFile: 'none',
  multiEdit: 'none',
  listDir: 'none',
  undoSnapshot: 'none',
  runCommand: 'commandExec',
  jobRun: 'backgroundJobs',
  jobPoll: 'backgroundJobs',
  jobKill: 'backgroundJobs'
}

export const TOOL_LABELS: Record<ToolName, string> = {
  readFile: '读取文件',
  writeFile: '写入文件',
  editFile: '替换一处',
  multiEdit: '替换多处',
  listDir: '列出目录',
  undoSnapshot: '撤销修改',
  runCommand: '执行命令',
  jobRun: '后台任务',
  jobPoll: '查询任务',
  jobKill: '终止任务'
}

/** 要求对应的人类说法，用于「本机不支持」的原因文案 */
export const REQUIREMENT_LABELS: Record<ToolRequirement, string> = {
  none: '基础文件操作',
  commandExec: '命令执行能力',
  backgroundJobs: '后台任务能力'
}

/** OpenAI 函数调用格式的工具定义 */
export interface ToolSchema {
  type: 'function'
  function: {
    name: ToolName
    description: string
    parameters: Record<string, unknown>
  }
}

/**
 * 交给模型的工具定义。
 * description 写得像在教学生怎么用，而不是 API 文档 —— 模型据此决定什么时候调。
 */
export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'readFile',
      description:
        '读取工作区里的一个文本文件。大文件请用 offset/limit 分次读，不要一次拉完。返回值开头会标明本次读到的是全文还是片段。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          offset: { type: 'integer', description: '从第几行开始读（从 1 开始），默认 1' },
          limit: { type: 'integer', description: '最多读多少行，默认 800' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'writeFile',
      description:
        '把整个文件覆盖成新内容。仅用于新建文件或确实要整篇重写的情况；只改几处请用 editFile。调本工具前必须先用 readFile 完整读过这个文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          content: { type: 'string', description: '新的完整文件内容' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'editFile',
      description:
        '把文件里的一段文字替换成另一段。oldString 必须在文件里**只出现一次**，否则会报错——多给几行上下文就能保证唯一。改错地方比改不动更麻烦，所以宁可报错。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          oldString: { type: 'string', description: '要被替换掉的原文（需在文件中唯一）' },
          newString: { type: 'string', description: '替换成的新内容' },
          replaceAll: { type: 'boolean', description: 'true 时替换全部出现处，默认 false' }
        },
        required: ['path', 'oldString', 'newString']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'multiEdit',
      description:
        '对同一个文件做多处替换，**要么全部成功、要么全部不写**。任何一处失败都会中止且不修改文件，所以可以放心地把一组修改一次性提交。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径' },
          edits: {
            type: 'array',
            description: '按顺序应用的替换列表',
            items: {
              type: 'object',
              properties: {
                oldString: { type: 'string', description: '要被替换掉的原文' },
                newString: { type: 'string', description: '替换成的新内容' },
                replaceAll: { type: 'boolean', description: 'true 时替换全部出现处' }
              },
              required: ['oldString', 'newString']
            }
          }
        },
        required: ['path', 'edits']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listDir',
      description: '列出目录内容，返回缩进的树形文本。先看清楚项目里有什么再动手，比直接猜文件名靠谱。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录绝对路径' },
          depth: { type: 'integer', description: '递归层数，默认 1，最大 3' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'undoSnapshot',
      description:
        '把文件回退到上一次修改之前。只有在你发现刚才改错了、或者学生说「帮我改回去」时使用；不要用它来试探。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '只回退这个文件；不填则回退最近一次修改' }
        },
        required: []
      }
    }
  }
]

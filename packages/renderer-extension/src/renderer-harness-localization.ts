import type { HarnessCommandDescriptor, HarnessPermissionMode } from "@codexhost/shared-contracts";

import type { RendererSettingsLocale } from "./settings/localization.js";

export interface RendererHarnessMessages {
  readonly commands: string;
  readonly harnessCommands: string;
  readonly textArgument: string;
  readonly permissionMode: string;
  readonly permissions: string;
  readonly loadingPermissions: string;
  readonly selecting: string;
  readonly permissionsUnavailable: string;
  readonly openExistingSession: string;
  readonly existingSessionUnavailable: string;
  readonly existingSessionTitle: string;
  readonly existingSessionDescription: string;
  readonly loadingExistingSessions: string;
  readonly noExistingSessions: string;
  readonly existingSessionsFailed: string;
  readonly retry: string;
  readonly cancel: string;
  readonly open: string;
  readonly linkingExistingSession: string;
  readonly openingExistingSession: string;
  readonly untitledSession: string;
  readonly runningSession: string;
  readonly emptySession: string;
  readonly sessionId: string;
  readonly updatedAt: string;
  readonly workingDirectory: string;
}

const ENGLISH_HARNESS_MESSAGES: RendererHarnessMessages = Object.freeze({
  commands: "Commands",
  harnessCommands: "Harness commands",
  textArgument: "Text",
  permissionMode: "Permission mode",
  permissions: "Permissions",
  loadingPermissions: "Loading permissions...",
  selecting: "Selecting...",
  permissionsUnavailable: "Permissions unavailable",
  openExistingSession: "Open existing session",
  existingSessionUnavailable: "Existing sessions are unavailable for this draft",
  existingSessionTitle: "Open an existing DeepSeek Harness session",
  existingSessionDescription:
    "Choose an unmapped session from this workspace. Its native data will remain in DeepSeek Harness.",
  loadingExistingSessions: "Loading sessions...",
  noExistingSessions: "No unmapped sessions were found in this workspace.",
  existingSessionsFailed: "Sessions could not be loaded.",
  retry: "Retry",
  cancel: "Cancel",
  open: "Open",
  linkingExistingSession: "Linking session...",
  openingExistingSession: "Opening session...",
  untitledSession: "Untitled session",
  runningSession: "Running",
  emptySession: "Empty session",
  sessionId: "Session ID",
  updatedAt: "Updated",
  workingDirectory: "Working directory",
});

const CHINESE_HARNESS_MESSAGES: RendererHarnessMessages = Object.freeze({
  commands: "命令",
  harnessCommands: "Harness 命令",
  textArgument: "文本",
  permissionMode: "权限模式",
  permissions: "权限",
  loadingPermissions: "正在加载权限...",
  selecting: "正在选择...",
  permissionsUnavailable: "权限不可用",
  openExistingSession: "打开已有会话",
  existingSessionUnavailable: "此草稿暂时无法打开已有会话",
  existingSessionTitle: "打开已有 DeepSeek Harness 会话",
  existingSessionDescription:
    "选择当前工作区中尚未关联的会话。原生数据仍由 DeepSeek Harness 管理。",
  loadingExistingSessions: "正在加载会话...",
  noExistingSessions: "当前工作区没有尚未关联的会话。",
  existingSessionsFailed: "无法加载会话。",
  retry: "重试",
  cancel: "取消",
  open: "打开",
  linkingExistingSession: "正在关联会话...",
  openingExistingSession: "正在打开会话...",
  untitledSession: "未命名会话",
  runningSession: "正在运行",
  emptySession: "空会话",
  sessionId: "会话 ID",
  updatedAt: "更新时间",
  workingDirectory: "工作目录",
});

const CHINESE_PERMISSION_MODE_LABELS = new Map<string, string>([
  ["Always ask", "始终询问"],
  ["Write", "写入"],
  ["Full access", "完全访问"],
  ["Plan mode", "规划模式"],
  ["Default", "默认"],
  ["Accept edits", "接受编辑"],
  ["Auto mode", "自动模式"],
  ["Bypass permissions", "绕过权限"],
  ["Ask", "询问"],
  ["Auto", "自动"],
  ["Always approve", "始终批准"],
]);

const CHINESE_PERMISSION_MODE_DESCRIPTIONS = new Map<string, string>([
  [
    "Automatically allow reads and ask before write or execution actions.",
    "自动允许读取；写入或执行操作前询问。",
  ],
  [
    "Automatically allow reads and writes; ask before execution actions.",
    "自动允许读取和写入；执行操作前询问。",
  ],
  ["Run all tool actions without approval prompts.", "无需批准提示即可运行所有工具操作。"],
  ["Analyze and plan without executing tools.", "仅分析和规划，不执行工具。"],
  ["Ask before edits and other protected actions.", "编辑和其他受保护操作前询问。"],
  ["Allow file edits and ask for other protected actions.", "允许文件编辑；其他受保护操作前询问。"],
  ["Let Claude classify permission requests.", "由 Claude 判断权限请求。"],
  ["Skip Claude Code permission checks.", "跳过 Claude Code 权限检查。"],
  [
    "Use Grok Build's default interactive approval policy.",
    "使用 Grok Build 的默认交互式批准策略。",
  ],
  ["Ask before protected tool actions.", "执行受保护的工具操作前询问。"],
  [
    "Let Grok Build decide which tool actions may run automatically.",
    "由 Grok Build 决定哪些工具操作可自动运行。",
  ],
  ["Approve all tool actions without prompting.", "无需提示即可批准所有工具操作。"],
]);

export function rendererHarnessMessages(locale: RendererSettingsLocale): RendererHarnessMessages {
  return locale === "zh-CN" ? CHINESE_HARNESS_MESSAGES : ENGLISH_HARNESS_MESSAGES;
}

export function rendererHarnessCommandPresentation(
  command: HarnessCommandDescriptor,
  locale: RendererSettingsLocale,
): { label: string; description: string } {
  if (locale === "zh-CN" && command.invocation === "/compact") {
    return { label: "压缩上下文", description: "压缩当前对话上下文" };
  }
  return {
    label: command.label,
    description: command.description ?? command.label,
  };
}

export function rendererPermissionModePresentation(
  mode: HarnessPermissionMode,
  locale: RendererSettingsLocale,
): { label: string; description: string | undefined } {
  if (locale !== "zh-CN") return { label: mode.label, description: mode.description };
  return {
    label: CHINESE_PERMISSION_MODE_LABELS.get(mode.label) ?? mode.label,
    description:
      mode.description === undefined
        ? undefined
        : (CHINESE_PERMISSION_MODE_DESCRIPTIONS.get(mode.description) ?? mode.description),
  };
}

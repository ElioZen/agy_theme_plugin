import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveAppDataDir } from './storage.mjs';

const MODEL_PRICING = [
  { match: /gemini-4-neon/i, input: 1.5, cacheRead: 0.15, output: 6.0 },
  { match: /gemini-4-hydrogen/i, input: 1.25, cacheRead: 0.125, output: 5.0 },
  { match: /gemini-4-argon/i, input: 0.6, cacheRead: 0.06, output: 2.5 },
  { match: /gemini-4-carbon/i, input: 0.35, cacheRead: 0.035, output: 1.5 },
  { match: /gemini/i, input: 0.35, cacheRead: 0.035, output: 1.5 },
  { match: /claude.*opus/i, input: 15.0, cacheRead: 1.5, output: 75.0 },
  { match: /claude.*sonnet/i, input: 3.0, cacheRead: 0.3, output: 15.0 },
  { match: /claude/i, input: 3.0, cacheRead: 0.3, output: 15.0 },
  { match: /gpt|codex|astra|o1|o3|o4/i, input: 2.5, cacheRead: 0.25, output: 10.0 },
];

const MODEL_PALETTE = ['#6EA8FF', '#F4B860', '#38D9A9', '#C084FC', '#F472B6', '#38BDF8', '#A3E635'];

const TOOL_ACTION_LABELS = {
  run_command: '执行命令',
  exec_command: '执行命令',
  shell_command: '执行命令',
  edit_file: '修改代码',
  write_file: '写入文件',
  apply_patch: '应用补丁',
  read_file: '读取文件',
  search_web: '检索网页',
  invoke_subagent: '调度子智能体',
  manage_task: '检查后台任务',
};

export function parseModelAndEffort(rawModel, explicitEffort = '') {
  const m = String(rawModel || '').trim();
  if (!m) return { baseModel: '未知模型', effort: explicitEffort || '—' };

  let effort = String(explicitEffort || '').trim().toLowerCase();
  let base = m;

  if (/^MODEL_PLACEHOLDER_/i.test(m)) {
    return { baseModel: `未映射模型 (${m.replace(/^MODEL_PLACEHOLDER_/, '')})`, effort: effort || '—' };
  }

  const suffixMatch = /-(xhigh|high|medium|low|max|thinking)$/i.exec(base);
  if (suffixMatch) {
    if (!effort) effort = suffixMatch[1].toLowerCase();
    base = base.slice(0, -suffixMatch[0].length);
  }
  base = base.replace(/-tiered$/i, '');

  const effortMap = {
    xhigh: 'XHigh',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
    max: 'Max',
    thinking: 'Thinking',
  };

  return {
    baseModel: base,
    effort: effortMap[effort] || (effort ? effort.toUpperCase() : '—'),
  };
}

export function formatModelName(modelId) {
  if (!modelId) return '未知模型';
  if (/^MODEL_PLACEHOLDER_/i.test(modelId)) {
    return `未映射模型 (${modelId.replace(/^MODEL_PLACEHOLDER_/, '')})`;
  }
  return modelId;
}

export function classifyAgyQuotaFamily(modelId) {
  const s = String(modelId || '').toLowerCase();
  if (s.includes('claude') || s.includes('gpt')) return 'claude';
  if (s.includes('gemini')) return 'gemini';
  return 'other';
}

export function estimateCostUsd(modelId, uncachedInput, cacheRead, output) {
  const pricing = MODEL_PRICING.find((p) => p.match.test(String(modelId || ''))) || {
    input: 1.0,
    cacheRead: 0.1,
    output: 4.0,
  };
  return (
    (uncachedInput / 1_000_000) * pricing.input +
    (cacheRead / 1_000_000) * pricing.cacheRead +
    (output / 1_000_000) * pricing.output
  );
}

function normalizePathFromUri(uriOrPath) {
  const s = String(uriOrPath || '').trim();
  if (!s) return '';
  try {
    return decodeURIComponent(s.replace(/^file:\/\//, '')).replace(/\/+$/, '');
  } catch {
    return s.replace(/^file:\/\//, '').replace(/\/+$/, '');
  }
}

function parseTimestampMs(raw) {
  if (!raw) return 0;
  if (typeof raw === 'number') return raw;
  const str = String(raw).trim().replace(' ', 'T');
  const ms = Date.parse(str);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Load ONLY the real user Projects shown in Antigravity's left sidebar:
 * ~/.gemini/config/projects/*.json (excluding internal sidecars & empty default-cli-project).
 */
export function loadConfiguredProjects() {
  const dir = join(homedir(), '.gemini', 'config', 'projects');
  if (!existsSync(dir)) return [];

  const projects = [];
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      if (!raw || raw.sidecar || raw.id === 'default-cli-project') continue;
      const resources = raw.projectResources?.resources || [];
      const folders = [];
      for (const r of resources) {
        const uri = r?.gitFolder?.folderUri || r?.folder?.folderUri || r?.folderUri || '';
        const norm = normalizePathFromUri(uri);
        if (norm) folders.push(norm);
      }
      if (!folders.length && raw.isWorkspaceOnly) continue;
      if (!folders.length) continue;

      projects.push({
        id: String(raw.id || f.replace(/\.json$/, '')),
        name: String(raw.name || basename(folders[0]) || '未命名项目'),
        folders,
      });
    } catch {
      // ignore invalid JSON
    }
  }

  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

const gitWorktreeRootCache = new Map();

function resolveGitWorktreeMainRoot(dirPath) {
  const norm = normalizePathFromUri(dirPath);
  if (!norm) return '';
  if (gitWorktreeRootCache.has(norm)) return gitWorktreeRootCache.get(norm);

  let mainRoot = '';
  try {
    const dotGit = join(norm, '.git');
    if (existsSync(dotGit) && statSync(dotGit).isFile()) {
      const content = readFileSync(dotGit, 'utf-8');
      const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(content);
      if (m) {
        const gitDir = m[1].trim();
        const wtMatch = /^(.+?)\/\.git\/worktrees\/[^/]+\/?$/.exec(gitDir);
        if (wtMatch) {
          mainRoot = normalizePathFromUri(wtMatch[1]);
        }
      }
    }
  } catch {
    // ignore filesystem errors on removed worktrees
  }
  gitWorktreeRootCache.set(norm, mainRoot);
  return mainRoot;
}

function matchProjectByPathOrId(projects, { projectId = '', paths = [] } = {}) {
  if (projectId) {
    const byId = projects.find((p) => p.id === projectId);
    if (byId) return byId;
  }

  let bestExact = null;
  let bestExactLen = -1;
  let bestWorktree = null;
  let bestWorktreeLen = -1;

  for (const rawP of paths) {
    const p = normalizePathFromUri(rawP);
    if (!p) continue;
    for (const proj of projects) {
      for (const folder of proj.folders) {
        if (p === folder || p.startsWith(`${folder}/`)) {
          if (folder.length > bestExactLen) {
            bestExact = proj;
            bestExactLen = folder.length;
          }
        } else if (
          p === `${folder}-worktrees` ||
          p.startsWith(`${folder}-worktrees/`) ||
          p === `${folder}_worktrees` ||
          p.startsWith(`${folder}_worktrees/`) ||
          p === `${folder}.worktrees` ||
          p.startsWith(`${folder}.worktrees/`)
        ) {
          if (folder.length > bestWorktreeLen) {
            bestWorktree = proj;
            bestWorktreeLen = folder.length;
          }
        }
      }
    }
    if (!bestExact && !bestWorktree) {
      const mainRoot = resolveGitWorktreeMainRoot(p);
      if (mainRoot) {
        for (const proj of projects) {
          for (const folder of proj.folders) {
            if (mainRoot === folder || mainRoot.startsWith(`${folder}/`)) {
              if (folder.length > bestWorktreeLen) {
                bestWorktree = proj;
                bestWorktreeLen = folder.length;
              }
            }
          }
        }
      }
    }
  }
  return bestExact || bestWorktree || null;
}

const UUID_GLOBAL_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Matches only genuine CLI invocation / JSON result / resume UUIDs (ignores `ls` listings & handoff doc prose)
const STRONG_CLI_UUID_RE =
  /(?:\\?"(?:conversation_id|conversationId|session_id|sessionId|thread_id|threadId)\\?"\s*:\s*\\?"|session\s+id\s*:\s*|--(?:conversation|resume)\s+(?:\\?["'])?|codex\s+exec\s+resume[^\n]{0,200}?\s+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const BRAIN_PATH_UUID_RE = /\/brain\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//gi;

function extractRegexGroupUuids(text, re, selfId = '') {
  const out = new Set();
  if (!text) return out;
  const selfLower = String(selfId || '').toLowerCase();
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const lo = m[1].toLowerCase();
    if (lo !== selfLower) out.add(lo);
  }
  return out;
}

function extractStrongCliUuids(text, selfId = '') {
  return extractRegexGroupUuids(text, STRONG_CLI_UUID_RE, selfId);
}

function extractBrainPathUuids(text, selfId = '') {
  return extractRegexGroupUuids(text, BRAIN_PATH_UUID_RE, selfId);
}

function extractReferencedUuidsFromCodexLines(lines, selfId = '') {
  const out = new Set();
  if (!Array.isArray(lines) || !lines.length) return out;
  const selfLower = String(selfId || '').toLowerCase();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.length < 36 || line.length > 131072) continue;
    if (
      !line.includes('codex') &&
      !line.includes('session') &&
      !line.includes('thread') &&
      !line.includes('agent') &&
      !line.includes('brain/') &&
      !line.includes('item.completed') &&
      !line.includes('turn.completed')
    ) {
      continue;
    }
    const matches = line.match(UUID_GLOBAL_RE);
    if (!matches) continue;
    for (const m of matches) {
      const lo = m.toLowerCase();
      if (lo !== selfLower) out.add(lo);
    }
  }
  return out;
}

function normalizePromptMatchText(rawText) {
  return String(rawText || '')
    .replace(/<\/?USER_REQUEST>/gi, ' ')
    .replace(/<\/?ADDITIONAL_METADATA>[\s\S]*$/gi, ' ')
    .replace(/\\r\\n|\\n|\\r|\\t/g, ' ')
    .replace(/\\["'`]/g, '')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildPromptProbes(rawPrompt) {
  let clean = normalizePromptMatchText(rawPrompt);
  if (!clean) return [];
  // Strip leading slash commands (e.g. "/plan " auto-injected by `agy --mode plan`)
  clean = clean.replace(/^\/[a-z0-9_-]{1,24}\s+/i, '').trim();
  if (clean.length < 28) return [];

  const probes = [];
  const p1 = clean.slice(0, Math.min(clean.length, 96));
  if (p1.length >= 28) probes.push(p1);
  // Add a second probe further into the task body to avoid false collisions on shared worker preambles
  if (clean.length >= 165) {
    const p2 = clean.slice(96, Math.min(clean.length, 168)).trim();
    if (p2.length >= 40) probes.push(p2);
  }
  return probes;
}

function parseToolCallArgsObject(rawArgs) {
  if (!rawArgs) return null;
  if (typeof rawArgs === 'object') return rawArgs;
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim();
    if (trimmed.startsWith('{')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    }
  }
  return null;
}

const scratchSignalsCache = new Map();

function readConversationScratchSignals(convDir, selfId = '') {
  const scratchDir = join(convDir, 'scratch');
  if (!existsSync(scratchDir)) return { uuids: new Set(), dispatchNorm: '' };

  let entries = [];
  let dirMtimeMs = 0;
  try {
    dirMtimeMs = statSync(scratchDir).mtimeMs;
    entries = readdirSync(scratchDir, { withFileTypes: true });
  } catch {
    return { uuids: new Set(), dispatchNorm: '' };
  }

  const fileInfos = [];
  let sigParts = `${dirMtimeMs}`;
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!/\.(txt|md|json|jsonl|log)$/i.test(ent.name)) continue;
    const full = join(scratchDir, ent.name);
    try {
      const st = statSync(full);
      if (st.size <= 0 || st.size > 512 * 1024) continue;
      fileInfos.push({ full, name: ent.name, size: st.size, mtimeMs: st.mtimeMs });
      sigParts += `|${ent.name}:${st.mtimeMs}:${st.size}`;
    } catch {
      // ignore
    }
  }

  const cached = scratchSignalsCache.get(scratchDir);
  if (cached && cached.sig === sigParts) return cached.data;

  const uuids = new Set();
  const promptParts = [];
  let promptBudget = 120_000;
  const selfLower = String(selfId || '').toLowerCase();

  for (const fi of fileInfos) {
    let content = '';
    try {
      content = readFileSync(fi.full, 'utf-8');
    } catch {
      continue;
    }
    const strongMatches = extractStrongCliUuids(content, selfLower);
    for (const lo of strongMatches) uuids.add(lo);
    if (promptBudget > 0 && /\.(txt|md)$/i.test(fi.name)) {
      const head = normalizePromptMatchText(content.slice(0, 1200));
      if (head.length >= 28) {
        promptParts.push(head);
        promptBudget -= head.length;
      }
    }
  }

  const data = { uuids, dispatchNorm: promptParts.join('\n') };
  scratchSignalsCache.set(scratchDir, { sig: sigParts, data });
  return data;
}

// ==================== TRANSCRIPT PARSER (AGY Desktop + AGY CLI) ====================
const transcriptCache = new Map();

function describeToolAction(toolName) {
  if (!toolName) return '执行工具';
  const base = String(toolName).replace(/^default_api:/, '');
  const label = TOOL_ACTION_LABELS[base];
  return label ? `${label} (${base})` : `执行 ${base}`;
}

function unwrapArgScalar(v) {
  if (v === null || v === undefined) return '';
  let s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') s = parsed;
    } catch {
      s = s.slice(1, -1);
    }
  }
  return s.replace(/\s+/g, ' ').trim();
}

function shortPathTail(p) {
  const clean = unwrapArgScalar(p);
  if (!clean) return '';
  const parts = clean.split('/').filter(Boolean);
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : clean;
}

function truncateLine(str, maxLen = 88) {
  const clean = String(str || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

function summarizeToolCallDetail(toolName, rawArgs) {
  const base = String(toolName || '').replace(/^default_api:/, '');
  let args = rawArgs;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (trimmed.startsWith('{')) {
      try {
        args = JSON.parse(trimmed);
      } catch {
        // leave as string
      }
    }
  }

  if (typeof args === 'string') {
    const cmdMatch = /cmd\s*:\s*[`'"]([^`'"]{2,120})[`'"]/.exec(args);
    if (cmdMatch) return truncateLine(`$ ${cmdMatch[1]}`);
    const patchMatch = /\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+([^\n]+)/.exec(args);
    if (patchMatch) return truncateLine(`patch ${shortPathTail(patchMatch[1])}`);
    return truncateLine(args);
  }

  if (!args || typeof args !== 'object') return '';

  const cmd = unwrapArgScalar(args.CommandLine || args.cmd || args.command || args.Script || '');
  if (cmd) return truncateLine(`$ ${cmd}`);

  const filePath = args.Path || args.TargetFile || args.file_path || args.path || args.ScriptPath || '';
  if (filePath) {
    const shortP = shortPathTail(filePath);
    const start = unwrapArgScalar(args.StartLine || '');
    const end = unwrapArgScalar(args.EndLine || '');
    const rangeTxt = start ? (end ? `#L${start}-${end}` : `#L${start}`) : '';
    return truncateLine(`${base}: ${shortP}${rangeTxt}`);
  }

  const query = unwrapArgScalar(args.query || args.Query || args.Pattern || args.Description || '');
  if (query) return truncateLine(`${base}: ${query}`);

  const role = unwrapArgScalar(args.Role || args.TypeName || '');
  if (role) return truncateLine(`${base}: ${role}`);

  for (const [k, v] of Object.entries(args)) {
    const val = unwrapArgScalar(v);
    if (val && val.length <= 120) return truncateLine(`${k}=${val}`);
  }
  return '';
}

const ZH_TASK_PHRASES = [
  [/\bFull[- ]Stack Kernel Architecture Mapper\b/gi, '全栈内核架构梳理'],
  [/\bPrototype Out[- ]of[- ]Factory QA Agent\b/gi, '原型出厂验收测试'],
  [/\bOut[- ]of[- ]Factory QA Agent\b/gi, '出厂验收测试'],
  [/\bDocumentation\s*&\s*Conflict Auditor\b/gi, '文档与冲突审计'],
  [/\bDefect\s*&\s*Edge[- ]Case Finisher\b/gi, '缺陷与边界收口'],
  [/\bFrontend Finisher Agent\b/gi, '前端收口实现'],
  [/\bBackend Finisher Agent\b/gi, '后端收口实现'],
  [/\bCanvas\s*&\s*Toolbox Polish Agent\b/gi, '画布与工具栏打磨'],
  [/\bCodebase Researcher\b/gi, '代码库调研'],
  [/\bDatabase Debugger\b/gi, '数据库排查'],
  [/\bWallpaper Artist\b/gi, '壁纸生成'],
  [/\bUI Designer\b/gi, '界面设计'],
  [/\bFormal Frontend Review Fixes\s*&\s*Strict Grid Alignment\b/gi, '正式前端评审修复与网格严格对齐'],
  [/\bFormal Frontend\b/gi, '正式前端'],
  [/\bFormal Backend\b/gi, '正式后端'],
  [/\bBackend Kernel\b/gi, '后端内核'],
  [/\bFrontend Kernel\b/gi, '前端内核'],
  [/\bInteractive Prototype\b/gi, '交互原型'],
  [/\bGlobal Filter Bar\b/gi, '全局条件栏'],
  [/\bCondition Drag[- ]to[- ]Reorder\b/gi, '条件拖拽排序'],
  [/\bReview Fixes\b/gi, '评审修复'],
  [/\bStrict Grid Alignment\b/gi, '网格严格对齐'],
  [/\bIndependent new read-only review\b/gi, '独立只读代码评审'],
  [/\bread-only review\b/gi, '只读代码评审'],
  [/\bproject rules\b/gi, '项目规范'],
  [/\bcomponent POST exports? routes?\b/gi, '组件 POST 导出接口'],
  [/\bJSON body\b/gi, 'JSON 请求体'],
  [/\bsurface prep\b/gi, '视图准备'],
  [/\ball DuckDB reads?\b/gi, '全部 DuckDB 读取'],
  [/\bDuckDB reads?\b/gi, 'DuckDB 读取'],
  [/\bquery and response work\b/gi, '查询与响应开发'],
  [/\bquery and response\b/gi, '查询与响应'],
  [/\bexport persistence\b/gi, '导出持久化'],
  [/\bpersonal center\b/gi, '个人导出中心'],
  [/\bre-authorization\b/gi, '重新鉴权'],
  [/\blayered retention\b/gi, '分层保留'],
  [/\breference tracking\b/gi, '引用追踪'],
  [/\bfull-scope totals\b/gi, '全量总计'],
  [/\bsparkline\b/gi, '迷你趋势'],
  [/\bdefinition\b/gi, '定义'],
  [/\bvalidation\b/gi, '校验'],
  [/\bpackaging\b/gi, '打包'],
  [/\bpersistence\b/gi, '持久化'],
  [/\bservice\b/gi, '服务'],
  [/\bexport routes?\b/gi, '导出接口'],
  [/\bunit tests?\b/gi, '单元测试'],
  [/\bintegration tests?\b/gi, '集成测试'],
  [/\bYou are implementing(?: the)?(?: Coordinator-approved)?\b/gi, '实现'],
  [/\bYou are building(?: the)?\b/gi, '构建'],
  [/\bYou are fixing(?: the)?\b/gi, '修复'],
  [/\bYou are auditing(?: the)?\b/gi, '审计'],
  [/\bYou are reviewing(?: the)?\b/gi, '评审'],
  [/\bYou are refactoring(?: the)?\b/gi, '重构'],
  [/\bYou are testing(?: the)?\b/gi, '测试'],
  [/\bOwn all\b/gi, '负责全部'],
  [/\bOwn\b/g, '负责'],
  [/\bImplement(?:ing)?\b/gi, '实现'],
  [/\bBuild(?:ing)?\b/gi, '构建'],
  [/\bFix(?:ing)?\b/gi, '修复'],
  [/\bAudit(?:or|ing)?\b/gi, '审计'],
  [/\bPolish\b/gi, '打磨'],
  [/\bFrontend\b/gi, '前端'],
  [/\bBackend\b/gi, '后端'],
  [/\bPrototype\b/gi, '原型'],
  [/\bArchitecture\b/gi, '架构'],
  [/\bDocumentation\b/gi, '文档'],
  [/\bRefactor(?:ing)?\b/gi, '重构'],
  [/\bMigration\b/gi, '迁移'],
  [/\bOptimization\b/gi, '优化'],
  [/\bSubagent\b/gi, '子智能体'],
  [/\bAgent\b/gi, '智能体'],
  [/\bWorker\b/gi, '执行节点'],
  [/\bQA\b/g, '验收测试'],
  [/\bincl\.?\b/gi, '含'],
  [/\bper\b/gi, '按'],
  [/\btheir\b/gi, '对应'],
  [/\bfor\b/gi, '·'],
  [/\band\b/gi, '与'],
  [/\ball\b/gi, '全部'],
];

function localizeTaskTitleToZh(rawText) {
  let s = String(rawText || '').trim();
  if (!s) return '';
  for (const [re, rep] of ZH_TASK_PHRASES) {
    s = s.replace(re, rep);
  }
  s = s
    .replace(/[`*#]/g, '')
    .replace(/\(\s*([^)]+)\s*\)/g, '（$1）')
    .replace(/\s*,\s*/g, '、')
    .replace(/\s*·\s*·\s*/g, ' · ')
    .replace(/\s+/g, ' ')
    .replace(/^[:：·,\-.\s]+|[:：·,\s]+$/g, '')
    .trim();
  return truncateLine(s, 56);
}

function extractTaskSubjectFromPrompt(promptText) {
  let clean = String(promptText || '')
    .replace(/<\/?USER_REQUEST>/gi, ' ')
    .replace(/<\/?ADDITIONAL_METADATA>[\s\S]*$/gi, ' ')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!clean) return '';

  // 1. Prefer explicit markdown bold task headline within the opening 360 chars (e.g. **P0-3 正式前端 (...)**)
  const headSlice = clean.slice(0, 380);
  const boldMatch = /\*\*([^*]{4,140})\*\*/.exec(headSlice);
  if (boldMatch) {
    const leadMatch = /^(You are (?:implementing|building|fixing|auditing|reviewing|refactoring|testing)|请[^*]{0,20}?(?:完成|更新|修复|实现))/i.exec(
      headSlice.trim(),
    );
    const verb = leadMatch ? leadMatch[1].replace(/^请[^，。]*?(?=(?:完成|更新|修复|实现))/, '') : '';
    const inner = boldMatch[1].replace(/[`]/g, '').trim();
    const combined = verb && !inner.includes(verb) ? `${verb} ${inner}` : inner;
    return combined;
  }

  // 2. Strip Codex/worker boilerplate preamble sentences to find the actual task ownership sentence
  const sentences = clean
    .replace(/\n+/g, '. ')
    .split(/(?<=[.。!?！？])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const boilerplateRe =
    /^(Independent\s+\w+\s+development\s+session|First\s+cat\b|Do\s+not\b|Root\s+agent\b|This\s+is\s+authorized\b|No\s+subagents\b|Parallel\s+workers\b|Keep\s+each\s+change\b|Read\s+\/|ONLY\s+read)/i;
  const substantive = sentences.find((s) => s.length >= 6 && !boilerplateRe.test(s));
  let chosen = substantive || sentences[0] || clean;

  // 3. Strip Chinese stylistic filler prefix (e.g. "请用自然、清晰的中文更新 ...") & strict-scope parentheticals
  chosen = chosen
    .replace(/^请(?:用|以)[^，。:\n]{1,28}?中文(?:（[^）]*）|\([^)]*\))?[，,\s]*/u, '')
    .replace(/（严禁[^）]*）/gu, '')
    .replace(/\s+in\s+`?\/Users\/[^\s`]+`?\.?$/i, '')
    .replace(/`[^`]*\/([^/`]+)`/g, '$1')
    .trim();

  return chosen.slice(0, 140);
}

function buildChineseTaskTitle({ dbTitle = '', role = '', prompt = '' } = {}) {
  const cleanDb = String(dbTitle || '').trim();
  const cleanRole = String(role || '').trim();
  const extractedPrompt = extractTaskSubjectFromPrompt(prompt);

  const raw = cleanDb || cleanRole || extractedPrompt || '';
  if (!raw) return { taskTitle: '', rawTaskTitle: '' };

  const taskTitle = localizeTaskTitleToZh(raw);
  return {
    taskTitle: taskTitle || truncateLine(raw, 54),
    rawTaskTitle: truncateLine(raw, 160),
  };
}

function estimateWeightedTextTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  let cjk = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xffef)) {
      cjk += 1;
    }
  }
  return cjk * 0.65 + (s.length - cjk) * 0.34;
}

function estimateAgyStepReasoningTokens(obj, outTok, tcJson = '') {
  if (!outTok || outTok <= 0) return 0;
  const thinking = String(obj.thinking || '');
  const content = String(obj.content || '');
  const hasThinking = thinking.trim().length > 0;
  const tThink = estimateWeightedTextTokens(thinking);
  const tVis = estimateWeightedTextTokens(content) + estimateWeightedTextTokens(tcJson);
  const trunc = Array.isArray(obj.truncated_fields) ? new Set(obj.truncated_fields) : null;

  let est = 0;
  if (trunc && (trunc.has('content') || trunc.has('tool_calls')) && tThink > 0) {
    const denom = tThink + tVis;
    est = denom > 0 ? outTok * (tThink / denom) : 0;
  } else if (hasThinking) {
    est = Math.max(Math.min(outTok, tThink), Math.max(0, outTok - tVis));
  } else if (tVis > 0) {
    // Only count clear residual excess above 1.35x visible tokens when no thinking field is present
    est = Math.max(0, outTok - tVis * 1.35);
  }
  return Math.round(Math.max(0, Math.min(outTok, est)));
}

function parseAgyTranscript(filePath, convId = '') {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }
  const cacheKey = `${stat.mtimeMs}:${stat.size}`;
  const cached = transcriptCache.get(filePath);
  if (cached && cached.cacheKey === cacheKey) return cached.data;

  let text = '';
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const turns = [];
  const checkpoints = [];
  let pendingCheckpoint = null;
  let userChars = 0;
  let assistantChars = 0;
  let thinkingChars = 0;
  let toolChars = 0;
  let lastModel = '';
  let firstStepAt = 0;
  let lastStepAt = 0;
  let prevStepMs = 0;
  let totalSteps = 0;
  let lastObj = null;
  let lastToolDetail = '';
  let firstUserPrompt = '';
  let currentTurnOutput = 0;
  let currentTurnSteps = 0;
  let hasCliInvocation = false;
  const cliCmdSnippets = [];
  const writtenPromptSnippets = [];
  let writtenPromptBudget = 160_000;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    totalSteps += 1;
    lastObj = obj;
    const ts = parseTimestampMs(obj.created_at);
    if (ts > 0 && (!firstStepAt || ts < firstStepAt)) firstStepAt = ts;
    if (ts > lastStepAt) lastStepAt = ts;

    // Close out the preceding CHECKPOINT's exact duration using the immediately following step's start time
    // (In Antigravity transcripts, every step's created_at marks its exact start timestamp.)
    if (pendingCheckpoint) {
      if (ts > 0 && pendingCheckpoint.startMs > 0 && obj.type !== 'USER_INPUT') {
        const delta = ts - pendingCheckpoint.startMs;
        if (delta >= 0 && delta <= 20 * 60 * 1000) {
          pendingCheckpoint.endMs = ts;
          pendingCheckpoint.durationMs = delta;
          pendingCheckpoint.inProgress = false;
        }
      }
      if (obj.type === 'PLANNER_RESPONSE') {
        pendingCheckpoint.postTokens = Number(obj.input_tokens || 0) + Number(obj.cache_read_tokens || 0);
      }
      pendingCheckpoint = null;
    }

    if (obj.type === 'USER_INPUT') {
      const uText = String(obj.content || '');
      userChars += uText.length;
      if (!firstUserPrompt && uText.trim()) {
        firstUserPrompt = uText.slice(0, 1200);
      }
      currentTurnOutput = 0;
      currentTurnSteps = 0;
    } else if (obj.type === 'PLANNER_RESPONSE') {
      const model = String(obj.model || '');
      if (model) lastModel = model;
      const inTok = Number(obj.input_tokens || 0);
      const cacheTok = Number(obj.cache_read_tokens || 0);
      const outTok = Number(obj.output_tokens || 0);
      if (outTok > 0) {
        currentTurnOutput += outTok;
        currentTurnSteps += 1;
      }
      thinkingChars += String(obj.thinking || '').length;
      assistantChars += String(obj.content || '').length;
      let tcJson = '';
      if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
        tcJson = JSON.stringify(obj.tool_calls);
        toolChars += tcJson.length;
        const lastTc = obj.tool_calls[obj.tool_calls.length - 1];
        const detail = summarizeToolCallDetail(lastTc?.name || lastTc?.tool_name || '', lastTc?.args || lastTc?.arguments);
        if (detail) lastToolDetail = detail;

        for (const tc of obj.tool_calls) {
          const tcName = String(tc?.name || tc?.tool_name || '').replace(/^default_api:/, '');
          const argsObj = parseToolCallArgsObject(tc?.args ?? tc?.arguments);
          if (!argsObj) continue;
          if (tcName === 'run_command' || tcName === 'exec_command' || tcName === 'shell_command') {
            const cmdRaw = unwrapArgScalar(argsObj.CommandLine || argsObj.cmd || argsObj.command || '');
            if (cmdRaw && /\b(?:agy|codex)\b/i.test(cmdRaw)) {
              hasCliInvocation = true;
              const normCmd = normalizePromptMatchText(cmdRaw.slice(0, 2400));
              if (normCmd) cliCmdSnippets.push(normCmd);
            }
          } else if (tcName === 'write_file' && writtenPromptBudget > 0) {
            const pth = unwrapArgScalar(argsObj.Path || argsObj.TargetFile || argsObj.path || '');
            const contentRaw = unwrapArgScalar(argsObj.Content || argsObj.content || '');
            if (contentRaw.length >= 28 && (/\/scratch\/|prompt|\/tmp\/|\.(?:txt|md)$/i.test(pth) || hasCliInvocation)) {
              const normBody = normalizePromptMatchText(contentRaw.slice(0, 1200));
              if (normBody.length >= 28) {
                writtenPromptSnippets.push(normBody);
                writtenPromptBudget -= normBody.length;
              }
            }
          }
        }
      }

      let tokPerSec = null;
      if (prevStepMs > 0 && ts > prevStepMs && outTok >= 15) {
        const deltaSec = (ts - prevStepMs) / 1000;
        if (deltaSec >= 0.8 && deltaSec <= 240) {
          const rate = outTok / deltaSec;
          if (rate > 0.5 && rate < 450) tokPerSec = Math.round(rate * 10) / 10;
        }
      }

      if (inTok > 0 || cacheTok > 0 || outTok > 0) {
        const estReason = estimateAgyStepReasoningTokens(obj, outTok, tcJson);
        turns.push({
          stepIndex: Number(obj.step_index || 0),
          ts,
          model: model || lastModel || 'unknown',
          uncachedInput: inTok,
          cacheRead: cacheTok,
          output: outTok,
          reasoning: estReason,
          contextTokens: inTok + cacheTok + outTok,
          tokPerSec,
          isCheckpoint: false,
        });
      }
    } else if (obj.type === 'CHECKPOINT') {
      // Context compaction is a real LLM summarization call that also hits KV cache.
      const inTok = Number(obj.input_tokens || 0);
      const cacheTok = Number(obj.cache_read_tokens || 0);
      const outTok = Number(obj.output_tokens || 0);
      const cpModel = String(obj.model || lastModel || 'unknown');
      if (inTok > 0 || cacheTok > 0 || outTok > 0) {
        turns.push({
          stepIndex: Number(obj.step_index || 0),
          ts,
          model: cpModel,
          uncachedInput: inTok,
          cacheRead: cacheTok,
          output: outTok,
          contextTokens: outTok,
          tokPerSec: null,
          isCheckpoint: true,
        });
      }
      // Compaction resets active prompt history for subsequent context breakdown weights
      const cpRec = {
        stepIndex: Number(obj.step_index || 0),
        startMs: ts,
        endMs: 0,
        durationMs: null,
        preTokens: inTok + cacheTok,
        summaryTokens: outTok,
        postTokens: 0,
        inProgress: Boolean(obj.status && obj.status !== 'DONE' && obj.status !== 'ERROR'),
      };
      checkpoints.push(cpRec);
      pendingCheckpoint = cpRec;

      userChars = 0;
      assistantChars = String(obj.content || '').length;
      thinkingChars = 0;
      toolChars = 0;
    } else {
      toolChars += String(obj.content || '').length;
    }

    if (ts > 0) prevStepMs = ts;
  }

  // Backfill any early unknown-model turns if a later step established the model
  if (lastModel) {
    for (const t of turns) {
      if (t.model === 'unknown') t.model = lastModel;
    }
  }

  const referencedUuids = extractStrongCliUuids(text, convId);
  const brainPathUuids = extractBrainPathUuids(text, convId);
  const cliDispatchBlob = hasCliInvocation
    ? [...cliCmdSnippets, ...writtenPromptSnippets].join('\n')
    : '';
  const promptProbes = buildPromptProbes(firstUserPrompt);

  // Infer exact live activity & whether the turn has truly finished:
  // In Antigravity transcripts, every completed step has status === 'DONE'.
  // A turn is ONLY finished when the last step is a PLANNER_RESPONSE with status === 'DONE' AND no pending tool_calls!
  let activity = '本轮已完成';
  let activityKind = 'idle';
  let isTurnFinished = true;
  if (lastObj) {
    const tools = Array.isArray(lastObj.tool_calls) ? lastObj.tool_calls : [];
    const lastToolName = tools.length > 0 ? tools[tools.length - 1]?.name || tools[tools.length - 1]?.tool_name || '' : '';
    const notDone = Boolean(lastObj.status && lastObj.status !== 'DONE' && lastObj.status !== 'ERROR');

    if (lastObj.type === 'PLANNER_RESPONSE') {
      if (tools.length > 0) {
        isTurnFinished = false;
        activity = describeToolAction(lastToolName);
        activityKind = 'tool';
      } else if (notDone || (lastObj.thinking && !lastObj.content)) {
        isTurnFinished = false;
        activity = '正在思考 (Thinking)';
        activityKind = 'thinking';
      } else {
        isTurnFinished = true;
        activity = '本轮已完成';
        activityKind = 'idle';
      }
    } else if (lastObj.type === 'USER_INPUT') {
      isTurnFinished = false;
      activity = '正在思考 (Thinking)';
      activityKind = 'thinking';
    } else {
      // GENERIC (tool output) or SYSTEM_MESSAGE right after a tool call -> model is now thinking next step!
      isTurnFinished = false;
      activity = notDone ? '执行工具中' : '正在思考下一步 (Thinking)';
      activityKind = notDone ? 'tool' : 'thinking';
    }
  }

  const data = {
    turns,
    checkpoints,
    totalSteps,
    lastModel,
    firstStepAt,
    lastStepAt,
    mtimeMs: stat.mtimeMs,
    activity,
    activityKind,
    lastToolDetail,
    firstUserPrompt,
    promptProbes,
    referencedUuids,
    brainPathUuids,
    hasCliInvocation,
    cliDispatchBlob,
    isTurnFinished,
    currentTurnOutput,
    currentTurnSteps,
    lastStatus: String(lastObj?.status || ''),
    charWeights: {
      user: userChars,
      assistant: assistantChars,
      thinking: thinkingChars,
      tool: toolChars,
    },
  };

  transcriptCache.set(filePath, { cacheKey, data });
  return data;
}

// ==================== CODEX CLI SESSION PARSER (~/.codex/sessions) ====================
const codexCache = new Map();

function listRecentCodexFiles(maxAgeMs = 7 * 24 * 60 * 60 * 1000, maxFiles = 2000) {
  const roots = [
    join(homedir(), '.codex', 'sessions'),
    join(homedir(), '.codex', 'archived_sessions'),
  ];
  const cutoff = maxAgeMs > 0 ? Date.now() - maxAgeMs : 0;
  const results = [];
  const seen = new Set();

  function walk(dir, depth) {
    if (depth > 5 || !existsSync(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith('.jsonl') && !seen.has(full)) {
        seen.add(full);
        try {
          const st = statSync(full);
          if (cutoff <= 0 || st.mtimeMs >= cutoff) {
            results.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
          }
        } catch {
          // ignore
        }
      }
    }
  }

  for (const root of roots) walk(root, 0);
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return maxFiles > 0 ? results.slice(0, maxFiles) : results;
}

const codexHeaderCwdCache = new Map();

function readCodexHeaderCwd(filePath) {
  if (codexHeaderCwdCache.has(filePath)) return codexHeaderCwdCache.get(filePath);
  let fd;
  let cwd = '';
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(32 * 1024);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead).toString('utf-8');
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      if (!line.includes('"session_meta"') && !line.includes('"turn_context"')) continue;
      try {
        const obj = JSON.parse(line);
        const c = obj?.payload?.cwd;
        if (c) {
          cwd = String(c);
          break;
        }
      } catch {
        // ignore truncated last line in head buffer
      }
    }
  } catch {
    // ignore
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
  if (cwd) codexHeaderCwdCache.set(filePath, cwd);
  return cwd;
}

function parseCodexSession(filePath, statInfo) {
  const cacheKey = `${statInfo.mtimeMs}:${statInfo.size}`;
  const cached = codexCache.get(filePath);
  if (cached && cached.cacheKey === cacheKey) return cached.data;

  let text = '';
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  let sessionId = basename(filePath, '.jsonl');
  let parentThreadId = '';
  let cwd = '';
  let originator = '';
  let source = '';
  let model = '';
  let effort = '';
  let totalTokens = 0;
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let firstEventTs = 0;
  let lastEventTs = 0;
  let isCompleted = false;
  let activity = '运行中';
  let activityKind = 'thinking';
  let lastToolDetail = '';
  let firstUserPrompt = '';
  let turnCount = 0;
  let prevUsage = null;
  let prevTokenTs = 0;
  let prevContextTokens = 0;
  let contextWindowLimit = 0;
  let lastContextTokens = 0;
  let currentTurnOutput = 0;
  let currentTurnSteps = 0;
  let lastReasoningOutput = 0;
  const turns = [];
  const checkpoints = [];

  const lines = text.split('\n');
  const tailStartIdx = Math.max(0, lines.length - 50);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const isTail = i >= tailStartIdx;
    const isHead = i < 45 && !firstUserPrompt;
    // Fast-skip giant historical response_item lines outside head (for prompt) and live tail
    if (
      !isTail &&
      !isHead &&
      !line.includes('"token_count"') &&
      !line.includes('"turn_context"') &&
      !line.includes('"session_meta"') &&
      !line.includes('"thread_settings_applied"') &&
      !line.includes('"task_started"') &&
      !line.includes('"task_complete"') &&
      !line.includes('"turn_aborted"') &&
      !line.includes('compact')
    ) {
      continue;
    }

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = parseTimestampMs(obj.timestamp);
    if (ts > 0 && (!firstEventTs || ts < firstEventTs)) firstEventTs = ts;
    if (ts > lastEventTs) lastEventTs = ts;
    const p = obj.payload || {};

    if (obj.type === 'session_meta') {
      if (p.id || p.session_id) sessionId = String(p.id || p.session_id);
      const rawParentTid =
        p.parent_thread_id ||
        p.source?.subagent?.thread_spawn?.parent_thread_id ||
        '';
      if (rawParentTid) parentThreadId = String(rawParentTid).toLowerCase();
      if (p.cwd) cwd = String(p.cwd);
      if (p.originator) originator = String(p.originator);
      if (p.source) source = typeof p.source === 'string' ? p.source : 'subagent';
    } else if (obj.type === 'turn_context') {
      if (p.model) model = String(p.model);
      if (p.effort || p.reasoning_effort) effort = String(p.effort || p.reasoning_effort);
      if (p.cwd && !cwd) cwd = String(p.cwd);
      turnCount += 1;
      currentTurnOutput = 0;
      currentTurnSteps = 0;
    } else if (obj.type === 'event_msg') {
      if (p.type === 'thread_settings_applied') {
        if (p.thread_settings?.model) model = String(p.thread_settings.model);
        if (p.thread_settings?.reasoning_effort) effort = String(p.thread_settings.reasoning_effort);
      } else if (p.type === 'token_count' && p.info?.total_token_usage) {
        const u = p.info.total_token_usage;
        const curIn = Number(u.input_tokens || 0);
        const curCached = Number(u.cached_input_tokens || 0);
        const curOut = Number(u.output_tokens || 0);
        const curReason = Number(u.reasoning_output_tokens || 0);
        const curTot = Number(u.total_tokens || curIn + curOut);

        // Compute exact per-event delta from cumulative total_token_usage
        // (automatically deduplicates repeated token_count snapshots and enables accurate date slicing)
        let dIn = 0;
        let dCached = 0;
        let dOut = 0;
        let dReason = 0;
        if (!prevUsage) {
          dIn = curIn;
          dCached = curCached;
          dOut = curOut;
          dReason = curReason;
        } else if (
          curIn === prevUsage.input_tokens &&
          curCached === prevUsage.cached_input_tokens &&
          curOut === prevUsage.output_tokens
        ) {
          // Exact duplicate snapshot — skip
        } else if (curIn >= prevUsage.input_tokens && curOut >= prevUsage.output_tokens) {
          dIn = curIn - prevUsage.input_tokens;
          dCached = Math.max(0, curCached - prevUsage.cached_input_tokens);
          dOut = curOut - prevUsage.output_tokens;
          dReason = Math.max(0, curReason - (prevUsage.reasoning_output_tokens || 0));
        } else if (p.info.last_token_usage) {
          const lu = p.info.last_token_usage;
          dIn = Number(lu.input_tokens || 0);
          dCached = Number(lu.cached_input_tokens || 0);
          dOut = Number(lu.output_tokens || 0);
          dReason = Number(lu.reasoning_output_tokens || 0);
        }
        prevUsage = {
          input_tokens: curIn,
          cached_input_tokens: curCached,
          output_tokens: curOut,
          reasoning_output_tokens: curReason,
        };

        if (p.info.model_context_window) {
          const win = Number(p.info.model_context_window || 0);
          if (win > 0) contextWindowLimit = win;
        }
        const lu = p.info.last_token_usage || null;
        const curCtx = lu ? Number(lu.total_tokens || Number(lu.input_tokens || 0) + Number(lu.output_tokens || 0)) : 0;
        if (lu && typeof lu.reasoning_output_tokens === 'number') {
          lastReasoningOutput = Number(lu.reasoning_output_tokens || 0);
        }

        if (dIn > 0 || dCached > 0 || dOut > 0) {
          if (dOut > 0) {
            currentTurnOutput += dOut;
            currentTurnSteps += 1;
          }
          const clampedCached = Math.min(dIn, dCached);
          // Detect automatic compaction drop in Codex context size
          if (prevContextTokens >= 150000 && curCtx > 0 && curCtx < prevContextTokens * 0.55) {
            checkpoints.push({
              stepIndex: turns.length,
              startMs: ts,
              endMs: ts,
              durationMs: null,
              preTokens: prevContextTokens,
              summaryTokens: curCtx,
              postTokens: curCtx,
              inProgress: false,
            });
            turns.push({
              stepIndex: turns.length,
              ts,
              model: model || 'codex',
              effort,
              uncachedInput: 0,
              cacheRead: 0,
              output: 0,
              contextTokens: curCtx,
              tokPerSec: null,
              isCheckpoint: true,
            });
          }

          let tokPerSec = null;
          if (prevTokenTs > 0 && ts > prevTokenTs && dOut >= 15) {
            const deltaSec = (ts - prevTokenTs) / 1000;
            if (deltaSec >= 0.8 && deltaSec <= 240) {
              const rate = dOut / deltaSec;
              if (rate > 0.5 && rate < 450) tokPerSec = Math.round(rate * 10) / 10;
            }
          }

          turns.push({
            stepIndex: turns.length + 1,
            ts,
            model: model || 'codex',
            effort,
            uncachedInput: Math.max(0, dIn - clampedCached),
            cacheRead: clampedCached,
            output: dOut,
            reasoning: Math.max(0, Math.min(dOut, dReason)),
            contextTokens: curCtx || dIn + dOut,
            tokPerSec,
            isCheckpoint: false,
          });
          if (curCtx > 0) {
            lastContextTokens = curCtx;
            prevContextTokens = curCtx;
          }
          if (ts > 0) prevTokenTs = ts;
        } else if (curCtx > 0) {
          lastContextTokens = curCtx;
        }

        inputTokens = curIn;
        cachedTokens = curCached;
        outputTokens = curOut;
        reasoningTokens = curReason;
        totalTokens = curTot;
      } else if (String(p.type || '').toLowerCase().includes('compact')) {
        if (prevContextTokens > 0) {
          checkpoints.push({
            stepIndex: turns.length,
            startMs: ts,
            endMs: ts,
            durationMs: null,
            preTokens: prevContextTokens,
            summaryTokens: 0,
            postTokens: 0,
            inProgress: false,
          });
        }
      } else if (p.type === 'user_message' && !firstUserPrompt && p.message) {
        const msg = String(p.message).trim();
        if (msg && !msg.startsWith('<') && !msg.startsWith('# AGENTS')) {
          firstUserPrompt = msg.slice(0, 1800);
        }
      } else if (p.type === 'task_started') {
        isCompleted = false;
        activity = '正在思考 (Thinking)';
        activityKind = 'thinking';
      } else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
        isCompleted = true;
        activity = p.type === 'turn_aborted' ? '已中止' : '本轮已完成';
        activityKind = 'idle';
      }
    } else if (obj.type === 'response_item') {
      if (p.type === 'message' && p.role === 'user') {
        if (!firstUserPrompt) {
          const content = p.content;
          const txt = Array.isArray(content)
            ? content.map((x) => (x && typeof x === 'object' ? String(x.text || '') : '')).join(' ')
            : String(content || '');
          const cleanTxt = txt.trim();
          if (cleanTxt && !cleanTxt.startsWith('<') && !cleanTxt.startsWith('# AGENTS')) {
            firstUserPrompt = cleanTxt.slice(0, 1800);
          }
        }
        continue;
      }
      if (!isTail) continue;
      isCompleted = false;
      if (p.type === 'reasoning') {
        activity = '正在思考 (Thinking)';
        activityKind = 'thinking';
      } else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
        activity = describeToolAction(p.name || 'tool');
        activityKind = 'tool';
        const detail = summarizeToolCallDetail(p.name || 'tool', p.arguments ?? p.input);
        if (detail) lastToolDetail = detail;
      } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
        activity = '工具返回 · 继续思考';
        activityKind = 'thinking';
      } else if (p.type === 'message') {
        activity = p.status === 'completed' ? '输出回复' : '生成回复中';
        activityKind = 'responding';
      }
    }
  }

  // Backfill model/effort onto any early turns that preceded the first turn_context event
  if (model) {
    for (const t of turns) {
      if (t.model === 'codex') t.model = model;
      if (!t.effort && effort) t.effort = effort;
    }
  }

  const uncachedInput = Math.max(0, inputTokens - cachedTokens);
  const referencedUuids = extractReferencedUuidsFromCodexLines(lines, sessionId);
  const brainPathUuids = extractBrainPathUuids(text, sessionId);
  const promptProbes = buildPromptProbes(firstUserPrompt);
  const data = {
    id: sessionId,
    idLower: String(sessionId || '').toLowerCase(),
    parentThreadId,
    shortId: sessionId.slice(-8),
    filePath,
    cwd,
    originator,
    source,
    isCliExec: originator === 'codex_exec' || source === 'exec' || originator.toLowerCase().includes('cli'),
    model: model || 'codex',
    effort,
    totalTokens,
    uncachedInput,
    cacheRead: cachedTokens,
    output: outputTokens,
    reasoningTokens,
    currentTurnOutput,
    currentTurnSteps,
    lastReasoningOutput,
    turnCount,
    turns,
    checkpoints,
    contextWindowLimit,
    lastContextTokens,
    lastModel: model || 'codex',
    lastEffort: effort,
    firstEventTs: firstEventTs || statInfo.mtimeMs,
    lastActiveMs: Math.max(lastEventTs, statInfo.mtimeMs),
    mtimeMs: statInfo.mtimeMs,
    isCompleted,
    activity,
    activityKind,
    lastToolDetail,
    firstUserPrompt,
    promptProbes,
    referencedUuids,
    brainPathUuids,
  };

  codexCache.set(filePath, { cacheKey, data });
  return data;
}

// ==================== DB METADATA READER ====================
function readSummariesDb(dbPath) {
  const summaryById = new Map();
  const parentOfChild = new Map();
  if (!existsSync(dbPath)) return { summaryById, parentOfChild };

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 1000;');
    const rows = db
      .prepare(`
        SELECT
          conversation_id,
          title,
          preview,
          step_count,
          status,
          not_fully_idle,
          killed,
          last_modified_time,
          workspace_uris,
          project_id,
          agent_name,
          parent_conversation_id,
          nesting_depth,
          source
        FROM conversation_summaries
        ORDER BY last_modified_time DESC
      `)
      .all();

    for (const r of rows) {
      let uris = [];
      try {
        const parsed = JSON.parse(r.workspace_uris || '[]');
        if (Array.isArray(parsed)) uris = parsed.map(String);
      } catch {
        // ignore
      }
      const running = Boolean(r.not_fully_idle) || r.status === 'CASCADE_RUN_STATUS_RUNNING';
      summaryById.set(r.conversation_id, {
        id: r.conversation_id,
        explicitTitle: (r.title || '').trim(),
        title: (r.title || '').trim() || (r.preview || '').trim().slice(0, 44) || '',
        workspaceUris: uris,
        projectId: String(r.project_id || ''),
        stepCount: Number(r.step_count || 0),
        isRunning: running && !r.killed,
        killed: Boolean(r.killed),
        statusLabel: r.killed ? '已结束' : running ? '运行中' : '空闲',
        lastModifiedMs: parseTimestampMs(r.last_modified_time),
        agentName: String(r.agent_name || ''),
        parentId: String(r.parent_conversation_id || ''),
        nestingDepth: Number(r.nesting_depth || 0),
        source: String(r.source || ''),
      });
      if (r.parent_conversation_id) {
        parentOfChild.set(r.conversation_id, String(r.parent_conversation_id));
      }
    }

    try {
      const pRows = db.prepare('SELECT conversation_id, parent_id FROM conversation_parents').all();
      for (const p of pRows) {
        if (p.conversation_id && p.parent_id) {
          parentOfChild.set(String(p.conversation_id), String(p.parent_id));
        }
      }
    } catch {
      // ignore
    }
  } catch (err) {
    console.error(`[prism_studio] Failed to read ${dbPath}:`, err.message);
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
  return { summaryById, parentOfChild };
}

function readSubagentDescriptors(brainDir, parentIds) {
  const map = new Map();
  for (const parentId of parentIds) {
    const dir = join(brainDir, parentId, '.system_generated', 'subagents');
    if (!existsSync(dir)) continue;
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
        const cid = raw.conversationId || f.replace(/\.json$/, '');
        map.set(cid, {
          parentId,
          typeName: raw.subagentDescriptor?.typeName || '',
          role: raw.subagentDescriptor?.role || '',
          state: raw.state || '',
          workspaceUris: Array.isArray(raw.workspaceUris) ? raw.workspaceUris : [],
        });
      } catch {
        // ignore
      }
    }
  }
  return map;
}

function summarizeModelEntries(entries) {
  const map = new Map();
  let totalUncached = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let totalReasoning = 0;
  let totalTurns = 0;
  let totalCostUsd = 0;
  const bySource = { gui: 0, agyCli: 0, codexCli: 0 };

  for (const t of entries) {
    const mId = t.model || 'unknown';
    const src = t.sourceKind || 'gui';
    const { baseModel, effort } = parseModelAndEffort(mId, t.effort || '');
    const key = `${mId}::${src}`;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        model: mId,
        displayName: formatModelName(mId),
        baseModel,
        effort,
        sourceKind: src,
        sourceLabel: src === 'agy-cli' ? 'AGY CLI' : src === 'codex-cli' ? 'Codex CLI' : 'AGY GUI',
        uncachedInput: 0,
        cacheRead: 0,
        output: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        turns: 0,
        costUsd: 0,
      };
      map.set(key, entry);
    }
    const rowTok = t.uncachedInput + t.cacheRead + t.output;
    const rowReason = Math.max(0, Math.min(Number(t.output || 0), Number(t.reasoning || 0)));
    const rowTurns = t.turns || 1;
    entry.uncachedInput += t.uncachedInput;
    entry.cacheRead += t.cacheRead;
    entry.output += t.output;
    entry.reasoningTokens += rowReason;
    entry.totalTokens += rowTok;
    entry.turns += rowTurns;
    const cost = estimateCostUsd(mId, t.uncachedInput, t.cacheRead, t.output);
    entry.costUsd += cost;

    if (src === 'agy-cli') bySource.agyCli += rowTok;
    else if (src === 'codex-cli') bySource.codexCli += rowTok;
    else bySource.gui += rowTok;

    totalUncached += t.uncachedInput;
    totalCacheRead += t.cacheRead;
    totalOutput += t.output;
    totalReasoning += rowReason;
    totalTurns += rowTurns;
    totalCostUsd += cost;
  }

  const grandTotal = Math.max(1, totalUncached + totalCacheRead + totalOutput);
  const models = [...map.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((m, idx) => {
      const promptTotal = m.uncachedInput + m.cacheRead;
      return {
        ...m,
        color: MODEL_PALETTE[idx % MODEL_PALETTE.length],
        sharePercent: Math.round((m.totalTokens / grandTotal) * 1000) / 10,
        cacheHitRate: promptTotal > 0 ? Math.round((m.cacheRead / promptTotal) * 1000) / 10 : 0,
        reasoningShareOfOutput: m.output > 0 ? Math.round((m.reasoningTokens / m.output) * 1000) / 10 : 0,
        reasoningShareOfTotal: m.totalTokens > 0 ? Math.round((m.reasoningTokens / m.totalTokens) * 10000) / 100 : 0,
        reasoningPerTurn: m.turns > 0 ? Math.round(m.reasoningTokens / m.turns) : 0,
        costUsd: Math.round(m.costUsd * 100) / 100,
      };
    });

  const promptAll = totalUncached + totalCacheRead;
  const totalAll = totalUncached + totalCacheRead + totalOutput;
  return {
    totalTokens: totalAll,
    uncachedInput: totalUncached,
    cacheRead: totalCacheRead,
    output: totalOutput,
    reasoningTokens: totalReasoning,
    reasoningShareOfOutput: totalOutput > 0 ? Math.round((totalReasoning / totalOutput) * 1000) / 10 : 0,
    reasoningShareOfTotal: totalAll > 0 ? Math.round((totalReasoning / totalAll) * 10000) / 100 : 0,
    reasoningPerTurn: totalTurns > 0 ? Math.round(totalReasoning / totalTurns) : 0,
    cacheHitRate: promptAll > 0 ? Math.round((totalCacheRead / promptAll) * 1000) / 10 : 0,
    costUsd: Math.round(totalCostUsd * 100) / 100,
    bySource,
    models,
  };
}

function buildQuotaWindowStats(turns, windowMs, anchor, nowMs) {
  const cutoff = nowMs - windowMs;
  let tokens = 0;
  let guiTokens = 0;
  let cliTokens = 0;
  let calls = 0;
  let sinceAnchorTokens = 0;
  let sinceAnchorCalls = 0;

  const anchorValid = Boolean(anchor && typeof anchor.leftPct === 'number' && anchor.anchoredAtMs);
  const resetAtMs = anchorValid && anchor.resetAtMs ? Number(anchor.resetAtMs) : 0;
  const anchorExpired = resetAtMs > 0 && nowMs >= resetAtMs;

  for (const t of turns) {
    if (!t.ts || t.ts < cutoff) continue;
    const tot = t.uncachedInput + t.cacheRead + t.output;
    tokens += tot;
    if (t.sourceKind === 'agy-cli') cliTokens += tot;
    else guiTokens += tot;
    calls += 1;
    if (anchorValid && !anchorExpired && t.ts > anchor.anchoredAtMs) {
      sinceAnchorTokens += tot;
      sinceAnchorCalls += 1;
    }
  }

  return {
    tokens,
    guiTokens,
    cliTokens,
    calls,
    anchor: anchorValid
      ? {
          leftPct: anchorExpired ? 100 : anchor.leftPct,
          resetAtMs: anchorExpired ? 0 : resetAtMs,
          resetInMs: anchorExpired ? 0 : Math.max(0, resetAtMs - nowMs),
          anchoredAtMs: anchor.anchoredAtMs,
          expired: anchorExpired,
          sinceAnchorTokens: anchorExpired ? 0 : sinceAnchorTokens,
          sinceAnchorCalls: anchorExpired ? 0 : sinceAnchorCalls,
        }
      : null,
  };
}

function toLocalDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildFamilyQuotaActivity(turns, cutoffMs) {
  const hourlyMap = new Map();
  const dailyCost = Object.create(null);
  const hourWeight = new Array(24).fill(0);
  const activeDays = new Set();
  let totalWeight = 0;

  for (const t of turns) {
    if (!t.ts || t.ts < cutoffMs) continue;
    const cost = estimateCostUsd(t.model, t.uncachedInput, t.cacheRead, t.output);
    if (!Number.isFinite(cost) || cost <= 0) continue;
    const hourMs = Math.floor(t.ts / 3_600_000) * 3_600_000;
    hourlyMap.set(hourMs, (hourlyMap.get(hourMs) || 0) + cost);

    const dayKey = toLocalDayKey(t.ts);
    dailyCost[dayKey] = (dailyCost[dayKey] || 0) + cost;
    activeDays.add(dayKey);

    const h = new Date(t.ts).getHours();
    hourWeight[h] += cost;
    totalWeight += cost;
  }

  const hourlyBuckets = [...hourlyMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hourMs, costUsd]) => ({ hourMs, costUsd }));

  return {
    hourlyBuckets,
    dailyCost,
    hourWeight,
    totalWeight,
    activeDayCount: activeDays.size,
  };
}

function normalizeHourlyShare(hourWeight, totalWeight, activeDayCount) {
  const uniform = 1 / 24;
  if (!totalWeight || totalWeight <= 0 || activeDayCount <= 0) {
    return new Array(24).fill(uniform);
  }
  // Smooth empirical diurnal curve with uniform Laplace prior (stronger smoothing when few active days)
  const uniformAlpha = activeDayCount >= 5 ? 0.15 : activeDayCount >= 2 ? 0.35 : 0.65;
  return hourWeight.map((w) => (1 - uniformAlpha) * (w / totalWeight) + uniformAlpha * uniform);
}

function buildQuotaActivityProfile(agyGeminiTurns, agyClaudeTurns, nowMs) {
  const LOOKBACK_MS = 21 * 24 * 60 * 60 * 1000;
  const cutoffMs = nowMs - LOOKBACK_MS;
  const gemini = buildFamilyQuotaActivity(agyGeminiTurns, cutoffMs);
  const claude = buildFamilyQuotaActivity(agyClaudeTurns, cutoffMs);

  const globalHourWeight = new Array(24).fill(0);
  let globalTotalWeight = 0;
  const globalDays = new Set([
    ...Object.keys(gemini.dailyCost),
    ...Object.keys(claude.dailyCost),
  ]);
  for (let h = 0; h < 24; h += 1) {
    const w = gemini.hourWeight[h] + claude.hourWeight[h];
    globalHourWeight[h] = w;
    globalTotalWeight += w;
  }

  const globalHourlyShare = normalizeHourlyShare(globalHourWeight, globalTotalWeight, globalDays.size);
  return {
    generatedAtMs: nowMs,
    globalHourlyShare,
    globalActiveDayCount: globalDays.size,
    gemini: {
      hourlyBuckets: gemini.hourlyBuckets,
      dailyCost: gemini.dailyCost,
      hourlyShare:
        gemini.activeDayCount >= 3
          ? normalizeHourlyShare(gemini.hourWeight, gemini.totalWeight, gemini.activeDayCount)
          : globalHourlyShare,
      activeDayCount: gemini.activeDayCount,
    },
    claude: {
      hourlyBuckets: claude.hourlyBuckets,
      dailyCost: claude.dailyCost,
      hourlyShare:
        claude.activeDayCount >= 3
          ? normalizeHourlyShare(claude.hourWeight, claude.totalWeight, claude.activeDayCount)
          : globalHourlyShare,
      activeDayCount: claude.activeDayCount,
    },
  };
}

function getRangeCutoffMs(range) {
  const now = new Date();
  if (range === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  if (range === '7d') return Date.now() - 7 * 24 * 60 * 60 * 1000;
  if (range === '30d') return Date.now() - 30 * 24 * 60 * 60 * 1000;
  return 0;
}

let codexConfigCache = { key: '', data: { modelContextWindow: 0, autoCompactLimit: 0 } };

function readCodexConfigLimits() {
  const cfgPath = join(homedir(), '.codex', 'config.toml');
  if (!existsSync(cfgPath)) return codexConfigCache.data;
  try {
    const st = statSync(cfgPath);
    const key = `${st.mtimeMs}:${st.size}`;
    if (codexConfigCache.key === key) return codexConfigCache.data;
    const raw = readFileSync(cfgPath, 'utf-8');
    const ctxMatch = raw.match(/^\s*model_context_window\s*=\s*(\d+)/m);
    const cpMatch = raw.match(/^\s*model_auto_compact_token_limit\s*=\s*(\d+)/m);
    const data = {
      modelContextWindow: ctxMatch ? Number(ctxMatch[1]) : 0,
      autoCompactLimit: cpMatch ? Number(cpMatch[1]) : 0,
    };
    codexConfigCache = { key, data };
    return data;
  } catch {
    return codexConfigCache.data;
  }
}

function inferModelSpecContextLimit(rawModel) {
  const m = String(rawModel || '').toLowerCase();
  if (!m) return 0;
  if (m.includes('gpt-oss-120b')) return 131072;
  if (m.includes('gemini-4') || m.includes('gemini-3') || m.includes('gemini-2.5') || m.includes('orchestrator')) {
    return 1048576;
  }
  if (m.includes('claude-opus-5') || m.includes('claude-sonnet-5')) return 1000000;
  if (m.includes('claude')) return 200000;
  if (m.includes('gpt-6') || m.includes('gpt-5')) {
    return readCodexConfigLimits().modelContextWindow || 1000000;
  }
  return 0;
}

const AGY_RUNTIME_CONTEXT_CAP = 512000;

function resolveDynamicContextLimit({
  source = null,
  rawModel = '',
  isCodex = false,
  usedTokens = 0,
  maxObservedTokens = 0,
  fallbackLimit = AGY_RUNTIME_CONTEXT_CAP,
  resolveModelContextWindow = null,
} = {}) {
  const peakObserved = Math.max(Number(usedTokens || 0), Number(maxObservedTokens || 0));

  if (isCodex) {
    const sessionLimit = Number(source?.contextWindowLimit || 0);
    if (sessionLimit >= 32000) {
      return {
        limit: sessionLimit,
        apiModelLimit: sessionLimit,
        isRuntimeCapped: false,
        isNativeLimit: true,
        limitSource: 'codex-session',
        limitSourceLabel: 'Codex 原生',
      };
    }
    const cfgLimit = readCodexConfigLimits().modelContextWindow;
    if (cfgLimit >= 32000) {
      return {
        limit: cfgLimit,
        apiModelLimit: cfgLimit,
        isRuntimeCapped: false,
        isNativeLimit: true,
        limitSource: 'codex-config',
        limitSourceLabel: 'Codex 配置',
      };
    }
  }

  let apiModelLimit = 0;
  let fromOfficialProbe = false;
  if (!isCodex && typeof resolveModelContextWindow === 'function' && rawModel) {
    const official = resolveModelContextWindow(rawModel);
    if (official && Number(official.limit) >= 32000) {
      apiModelLimit = Number(official.limit);
      fromOfficialProbe = true;
    }
  }
  if (!apiModelLimit) {
    apiModelLimit = inferModelSpecContextLimit(rawModel) || Math.max(32000, Number(fallbackLimit) || AGY_RUNTIME_CONTEXT_CAP);
  }

  // Antigravity Desktop & AGY CLI enforce a hard 512K runtime ceiling before forced compaction,
  // even when the underlying model's API capability is 1M (1,048,576 / 1,000,000).
  // Auto-unlock if a future Antigravity update or tier ever lets a session exceed 540K.
  if (!isCodex && apiModelLimit > AGY_RUNTIME_CONTEXT_CAP && peakObserved <= 540000) {
    return {
      limit: AGY_RUNTIME_CONTEXT_CAP,
      apiModelLimit,
      isRuntimeCapped: true,
      isNativeLimit: true,
      limitSource: 'agy-cap',
      limitSourceLabel: 'AGY 上限',
    };
  }

  let effectiveLimit = apiModelLimit;
  if (peakObserved > effectiveLimit) {
    const steps = [200000, 512000, 1000000, 1048576, 2097152];
    const nextStep = steps.find((s) => s >= peakObserved);
    effectiveLimit = nextStep || Math.ceil(peakObserved * 1.15);
  }
  return {
    limit: effectiveLimit,
    apiModelLimit: effectiveLimit,
    isRuntimeCapped: false,
    isNativeLimit: fromOfficialProbe,
    limitSource: fromOfficialProbe ? 'agy-official' : 'model-spec',
    limitSourceLabel: fromOfficialProbe ? '官方识别' : '模型规格',
  };
}

function buildContextSnapshotFromSource(
  source,
  { isCodex = false, fallbackLimit = AGY_RUNTIME_CONTEXT_CAP, nowMs = Date.now(), targetMeta = null, resolveModelContextWindow = null } = {},
) {
  const turns = source?.turns || [];
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const nonCheckpointTurns = turns.filter((t) => !t.isCheckpoint);
  const latestModelTurn = nonCheckpointTurns.length > 0 ? nonCheckpointTurns[nonCheckpointTurns.length - 1] : null;
  const rawModel = source?.lastModel || latestModelTurn?.model || latestTurn?.model || '';

  const usedTokens = isCodex
    ? Number(source?.lastContextTokens || latestModelTurn?.contextTokens || latestTurn?.contextTokens || 0)
    : latestTurn
    ? Number(latestTurn.contextTokens || 0)
    : 0;
  let maxObservedTokens = usedTokens;
  for (const cp of source?.checkpoints || []) {
    if (Number(cp?.preTokens || 0) > maxObservedTokens) maxObservedTokens = Number(cp.preTokens);
  }
  const { limit, apiModelLimit, isRuntimeCapped, isNativeLimit, limitSource, limitSourceLabel } = resolveDynamicContextLimit({
    source,
    rawModel,
    isCodex,
    usedTokens,
    maxObservedTokens,
    fallbackLimit,
    resolveModelContextWindow,
  });
  const usedPercent = Math.min(100, Math.round((usedTokens / limit) * 1000) / 10);
  const remainingTokens = Math.max(0, limit - usedTokens);

  let systemBase = 0;
  let thinkingTokens = 0;
  let dialogTokens = 0;
  let toolTokens = 0;
  if (usedTokens > 0) {
    systemBase = Math.min(usedTokens, Math.round(Math.min(isCodex ? 18000 : 14000, usedTokens * 0.22)));
    const variableTokens = Math.max(0, usedTokens - systemBase);
    if (isCodex) {
      // Codex logs don't expose char-level role weights; estimate split from reasoning/output ratio
      const reasonShare =
        source?.output > 0 ? Math.min(0.28, (Number(source.reasoningTokens || 0) / Math.max(1, source.output)) * 0.16) : 0.08;
      thinkingTokens = Math.round(variableTokens * reasonShare);
      dialogTokens = Math.round(variableTokens * 0.12);
      toolTokens = Math.max(0, variableTokens - thinkingTokens - dialogTokens);
    } else {
      const w = source?.charWeights || { user: 0, assistant: 0, thinking: 0, tool: 0 };
      const weightSum = Math.max(1, w.user + w.assistant + w.thinking + w.tool);
      thinkingTokens = Math.round(variableTokens * (w.thinking / weightSum));
      dialogTokens = Math.round(variableTokens * ((w.user + w.assistant) / weightSum));
      toolTokens = Math.max(0, variableTokens - thinkingTokens - dialogTokens);
    }
  }

  const lastTurnPrompt = latestModelTurn ? latestModelTurn.uncachedInput + latestModelTurn.cacheRead : 0;
  const lastTurnCacheHitRate =
    lastTurnPrompt > 0 ? Math.round((latestModelTurn.cacheRead / lastTurnPrompt) * 1000) / 10 : null;
  const isCacheDrop = Boolean(
    latestModelTurn &&
      nonCheckpointTurns.length >= 2 &&
      lastTurnPrompt >= 12000 &&
      (lastTurnCacheHitRate < 35 || (latestModelTurn.uncachedInput >= 50000 && lastTurnCacheHitRate < 65)),
  );
  const lastTurnCache = {
    hitRate: lastTurnCacheHitRate,
    cacheRead: latestModelTurn?.cacheRead || 0,
    uncachedInput: latestModelTurn?.uncachedInput || 0,
    isDrop: isCacheDrop,
  };

  const checkpoints = source?.checkpoints || [];
  const lastCp = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;
  const totalCpDurationMs = checkpoints.reduce(
    (acc, c) => acc + (typeof c.durationMs === 'number' ? c.durationMs : 0),
    0,
  );

  const preTokens = lastCp?.preTokens || 0;
  const postTokens = lastCp?.postTokens || lastCp?.summaryTokens || 0;
  const freedPercent =
    preTokens > 0 && postTokens > 0 && preTokens > postTokens
      ? Math.round(((preTokens - postTokens) / preTokens) * 1000) / 10
      : null;

  // Determine realistic auto-compaction trigger ceiling (observed checkpoint peak or Codex auto-compact config)
  let compactionThreshold = limit;
  let compactionThresholdSource = 'window-limit';
  if (preTokens >= 180000 && preTokens < limit * 0.9 && usedTokens < preTokens * 1.08) {
    compactionThreshold = preTokens;
    compactionThresholdSource = 'observed';
  } else if (isCodex) {
    const cfgAutoCp = readCodexConfigLimits().autoCompactLimit;
    if (cfgAutoCp >= 64000 && cfgAutoCp < limit) {
      compactionThreshold = cfgAutoCp;
      compactionThresholdSource = 'codex-config';
    }
  }

  let lastCpTurnIdx = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].isCheckpoint) {
      lastCpTurnIdx = i;
      break;
    }
  }
  const cycleTurns = turns.slice(lastCpTurnIdx + 1).filter((t) => !t.isCheckpoint && t.contextTokens > 0);
  let avgGrowthPerTurn = 0;
  let estTurnsToLimit = null;
  if (cycleTurns.length >= 2) {
    let avgDelta = (cycleTurns[cycleTurns.length - 1].contextTokens - cycleTurns[0].contextTokens) / (cycleTurns.length - 1);
    if (avgDelta < 50) {
      const posDeltas = [];
      for (let i = 1; i < cycleTurns.length; i += 1) {
        const d = cycleTurns[i].contextTokens - cycleTurns[i - 1].contextTokens;
        if (d > 0) posDeltas.push(d);
      }
      if (posDeltas.length) {
        avgDelta = posDeltas.reduce((a, b) => a + b, 0) / posDeltas.length;
      }
    }
    if (avgDelta >= 50) {
      avgGrowthPerTurn = Math.round(avgDelta);
      const tokensToCompact = Math.max(0, compactionThreshold - usedTokens);
      estTurnsToLimit = Math.max(0, Math.round(tokensToCompact / avgDelta));
    }
  }

  let sessUncached = 0;
  let sessCache = 0;
  for (const t of turns) {
    sessUncached += Number(t.uncachedInput || 0);
    sessCache += Number(t.cacheRead || 0);
  }
  const sessPromptTot = sessUncached + sessCache;
  const effectiveInputRatio =
    sessPromptTot > 0 ? Math.round(((sessUncached + sessCache * 0.1) / sessPromptTot) * 1000) / 10 : null;
  const savedInputPercent =
    effectiveInputRatio !== null ? Math.round((100 - effectiveInputRatio) * 10) / 10 : null;

  const compaction = {
    count: checkpoints.length,
    lastAtMs: lastCp?.startMs || 0,
    lastDurationMs:
      lastCp && typeof lastCp.durationMs === 'number'
        ? lastCp.durationMs
        : lastCp && lastCp.inProgress && lastCp.startMs
        ? Math.max(0, nowMs - lastCp.startMs)
        : null,
    inProgress: Boolean(lastCp?.inProgress),
    preTokens,
    postTokens,
    freedPercent,
    compactionThreshold,
    compactionThresholdSource,
    avgGrowthPerTurn,
    estTurnsToLimit,
    effectiveInputRatio,
    savedInputPercent,
    totalDurationMs: totalCpDurationMs,
  };

  const speedPoints = turns
    .filter((t) => typeof t.tokPerSec === 'number')
    .slice(-14)
    .map((t) => ({ step: t.stepIndex, rate: t.tokPerSec, ts: t.ts }));
  const latestSpeed = speedPoints.length > 0 ? speedPoints[speedPoints.length - 1].rate : 0;
  const avgSpeed =
    speedPoints.length > 0
      ? Math.round((speedPoints.reduce((acc, p) => acc + p.rate, 0) / speedPoints.length) * 10) / 10
      : 0;
  const explicitEffort = isCodex ? source?.lastEffort || source?.effort || '' : '';
  const parsedLastModel = parseModelAndEffort(rawModel, explicitEffort);
  const lastStepOutput = Number(latestModelTurn?.output || 0);
  const lastTurnOutput = Math.max(lastStepOutput, Number(source?.currentTurnOutput || 0));
  const lastOutput = {
    stepTokens: lastStepOutput,
    turnTokens: lastTurnOutput,
    turnSteps: Number(source?.currentTurnSteps || (lastStepOutput > 0 ? 1 : 0)),
    reasoningTokens: isCodex ? Number(source?.lastReasoningOutput || 0) : 0,
  };

  return {
    used: usedTokens,
    limit,
    apiModelLimit,
    isRuntimeCapped,
    isNativeLimit,
    limitSource,
    limitSourceLabel,
    percent: usedPercent,
    remaining: remainingTokens,
    lastOutput,
    target: targetMeta || {
      key: 'main',
      isMain: true,
      kind: 'gui',
      kindLabel: '主会话',
      title: '当前会话',
      projectName: '',
    },
    lastTurnCache,
    compaction,
    breakdown: {
      system: systemBase,
      thinking: thinkingTokens,
      dialog: dialogTokens,
      tools: toolTokens,
      remaining: remainingTokens,
    },
    speed: {
      latest: latestSpeed,
      average: avgSpeed,
      sparkline: speedPoints,
      model: parsedLastModel.baseModel,
      effort: parsedLastModel.effort,
      rawModel,
      turnCount: nonCheckpointTurns.length,
    },
  };
}

export function buildTelemetrySnapshot({
  conversationId = '',
  hostConversationId = '',
  activeWorkspaceUri = '',
  selectedProjectId = '',
  contextTarget = 'main',
  followLatest = true,
  statsScope = 'project', // 'project' | 'session' | 'all'
  sourceFilter = 'all', // 'all' | 'gui' | 'agy-cli' | 'codex-cli'
  range = 'today',
  windowLimit = 1048576,
  showRecentAgents = false,
  quotaAnchor = {},
  resolveModelContextWindow = null,
} = {}) {
  const appDataDir = resolveAppDataDir();
  const desktopBrainDir = join(appDataDir, 'brain');
  const cliAppDataDir = join(homedir(), '.gemini', 'antigravity-cli');
  const cliBrainDir = join(cliAppDataDir, 'brain');
  const nowMs = Date.now();

  // 1. Real configured projects matching Antigravity's left sidebar 1-to-1!
  const configuredProjects = loadConfiguredProjects();

  // 2. Read desktop & CLI DB metadata (smart-merge so empty desktop rows never overwrite valid CLI workspaces!)
  const desktopDb = readSummariesDb(join(appDataDir, 'conversation_summaries.db'));
  const cliDb = readSummariesDb(join(cliAppDataDir, 'conversation_summaries.db'));
  const isPlaceholderProjectId = (pid) =>
    !pid || pid === 'default-cli-project' || pid === 'outside-of-project';
  const summaryById = new Map(cliDb.summaryById);
  for (const [id, d] of desktopDb.summaryById.entries()) {
    const c = summaryById.get(id);
    if (!c) {
      summaryById.set(id, d);
      continue;
    }
    const uriSet = new Set();
    for (const u of [...(d.workspaceUris || []), ...(c.workspaceUris || [])]) {
      if (u) uriSet.add(u);
    }
    const projectId = !isPlaceholderProjectId(d.projectId)
      ? d.projectId
      : !isPlaceholderProjectId(c.projectId)
      ? c.projectId
      : d.projectId || c.projectId || '';
    summaryById.set(id, {
      ...c,
      ...d,
      explicitTitle: d.explicitTitle || c.explicitTitle || '',
      title: d.title || c.title || '',
      workspaceUris: [...uriSet],
      projectId,
      stepCount: Math.max(Number(d.stepCount || 0), Number(c.stepCount || 0)),
      isRunning: Boolean((d.isRunning && !d.killed) || (c.isRunning && !c.killed)),
      killed: Boolean(d.killed && c.killed),
      lastModifiedMs: Math.max(Number(d.lastModifiedMs || 0), Number(c.lastModifiedMs || 0)),
      parentId: d.parentId || c.parentId || '',
      nestingDepth: Math.max(Number(d.nestingDepth || 0), Number(c.nestingDepth || 0)),
      source: d.source || c.source || '',
    });
  }
  const parentOfChild = new Map([...cliDb.parentOfChild, ...desktopDb.parentOfChild]);

  // Helper: map any conversation or CLI session to one of the real configured Projects (multi-hop parent walk)
  function resolveProjectForConv(cid, extraPaths = []) {
    let cur = cid;
    const visited = new Set();
    for (let depth = 0; depth < 8 && cur && !visited.has(cur); depth += 1) {
      visited.add(cur);
      const s = summaryById.get(cur);
      const paths = depth === 0 ? [...(s?.workspaceUris || []), ...extraPaths] : s?.workspaceUris || [];
      const matched = matchProjectByPathOrId(configuredProjects, {
        projectId: isPlaceholderProjectId(s?.projectId) ? '' : s?.projectId || '',
        paths,
      });
      if (matched) return matched;
      cur = parentOfChild.get(cur) || s?.parentId || '';
    }
    return null;
  }

  // Build top-level conversations belonging to configured projects (or fallback)
  const topConversations = [];
  for (const s of desktopDb.summaryById.values()) {
    const isChild = Boolean(s.parentId || s.nestingDepth > 0 || parentOfChild.has(s.id));
    const isCliEphemeral = s.source === 'CORTEX_TRAJECTORY_SOURCE_CLI';
    if (isChild || isCliEphemeral) continue;
    const proj = resolveProjectForConv(s.id);
    if (!proj) continue; // Only include conversations belonging to real sidebar Projects!
    topConversations.push({
      id: s.id,
      title: s.title || '未命名会话',
      projectId: proj.id,
      projectName: proj.name,
      stepCount: s.stepCount,
      isRunning: s.isRunning,
      statusLabel: s.statusLabel,
      lastModifiedMs: s.lastModifiedMs,
    });
  }
  topConversations.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
  const topConversationIdSet = new Set(topConversations.map((c) => c.id));

  // Resolve active project & active conversation cleanly
  let activeConvId = conversationId;
  let activeProject = selectedProjectId ? configuredProjects.find((p) => p.id === selectedProjectId) : null;

  if (followLatest) {
    const hostSummary = hostConversationId ? summaryById.get(hostConversationId) : null;
    const hostProj = hostConversationId ? resolveProjectForConv(hostConversationId) : null;
    const wsProj = activeWorkspaceUri ? matchProjectByPathOrId(configuredProjects, { paths: [activeWorkspaceUri] }) : null;

    if (wsProj && hostProj && wsProj.id !== hostProj.id) {
      activeProject = wsProj;
      const inWs = topConversations.find((c) => c.projectId === wsProj.id);
      activeConvId = inWs?.id || hostConversationId || topConversations[0]?.id || '';
    } else if (hostConversationId && hostSummary) {
      activeConvId = hostConversationId;
      activeProject = hostProj || wsProj || configuredProjects[0] || null;
    } else if (wsProj) {
      activeProject = wsProj;
      activeConvId = topConversations.find((c) => c.projectId === wsProj.id)?.id || topConversations[0]?.id || '';
    } else {
      activeConvId = topConversations[0]?.id || '';
      activeProject = topConversations[0]
        ? configuredProjects.find((p) => p.id === topConversations[0].projectId) || configuredProjects[0] || null
        : configuredProjects[0] || null;
    }
  } else {
    if (activeConvId) {
      const convProj = resolveProjectForConv(activeConvId);
      if (!activeProject && convProj) activeProject = convProj;
    } else if (activeProject) {
      activeConvId = topConversations.find((c) => c.projectId === activeProject.id)?.id || '';
    } else {
      activeConvId = hostConversationId || topConversations[0]?.id || '';
      activeProject = resolveProjectForConv(activeConvId) || configuredProjects[0] || null;
    }
  }

  // Parse all desktop + agy-cli transcripts (prefer untruncated transcript_full.jsonl for exact reasoning split; cached by mtime:size)
  const resolveTranscriptFile = (baseDir, id) => {
    const logsDir = join(baseDir, id, '.system_generated', 'logs');
    const fullPath = join(logsDir, 'transcript_full.jsonl');
    return existsSync(fullPath) ? fullPath : join(logsDir, 'transcript.jsonl');
  };

  const parsedDesktop = new Map();
  if (existsSync(desktopBrainDir)) {
    for (const id of readdirSync(desktopBrainDir)) {
      if (!/^[0-9a-f-]{8,}$/i.test(id)) continue;
      const parsed = parseAgyTranscript(resolveTranscriptFile(desktopBrainDir, id), id);
      if (parsed) parsedDesktop.set(id, parsed);
    }
  }

  const parsedAgyCli = new Map();
  if (existsSync(cliBrainDir)) {
    for (const id of readdirSync(cliBrainDir)) {
      if (!/^[0-9a-f-]{8,}$/i.test(id)) continue;
      const parsed = parseAgyTranscript(resolveTranscriptFile(cliBrainDir, id), id);
      if (parsed) parsedAgyCli.set(id, parsed);
    }
  }

  // Parse Codex CLI sessions belonging to configured projects (no 40-file cap; fast-filter CWD from 32KB header first)
  const DAY_MS = 24 * 60 * 60 * 1000;
  const codexMaxAgeMs =
    range === 'all'
      ? 0
      : range === '30d'
      ? 35 * DAY_MS
      : range === '7d'
      ? 14 * DAY_MS
      : 7 * DAY_MS;
  const codexSessions = [];
  for (const f of listRecentCodexFiles(codexMaxAgeMs, 2000)) {
    const headerCwd = readCodexHeaderCwd(f.path);
    if (headerCwd && !matchProjectByPathOrId(configuredProjects, { paths: [headerCwd] })) {
      continue;
    }
    const parsed = parseCodexSession(f.path, f);
    if (!parsed) continue;
    const proj = matchProjectByPathOrId(configuredProjects, { paths: [parsed.cwd] });
    if (proj) {
      codexSessions.push({ ...parsed, projectId: proj.id, projectName: proj.name });
    }
  }

  // Active conversation metadata
  const activeSummary = summaryById.get(activeConvId);
  const activeData = parsedDesktop.get(activeConvId) || parsedAgyCli.get(activeConvId) || null;
  const activeConvObj = {
    id: activeConvId,
    title: activeSummary?.title || (activeConvId ? '当前会话' : '暂无会话'),
    projectId: activeProject?.id || '',
    projectName: activeProject?.name || '项目',
    isRunning: Boolean(activeSummary?.isRunning),
    statusLabel: activeSummary?.statusLabel || '就绪',
    stepCount: activeSummary?.stepCount || activeData?.totalSteps || 0,
  };

  // ==================== UNIFIED PROJECT & SESSION STATS ====================
  const cutoffRangeMs = getRangeCutoffMs(range);
  const filterByRange = (turns) => turns.filter((t) => !(cutoffRangeMs > 0 && t.ts > 0 && t.ts < cutoffRangeMs));
  const filterBySource = (entries) => {
    if (!sourceFilter || sourceFilter === 'all') return entries;
    return entries.filter((e) => e.sourceKind === sourceFilter);
  };

  // Subagent descriptors for parent->project linking
  const parentIds = new Set(topConversations.map((c) => c.id));
  for (const pid of parentOfChild.values()) parentIds.add(pid);
  const subDescriptors = readSubagentDescriptors(desktopBrainDir, [...parentIds]);
  for (const [cid, desc] of subDescriptors.entries()) {
    if (!parentOfChild.has(cid)) parentOfChild.set(cid, desc.parentId);
  }

  // Session stats: aggregate current conversation + ALL transitively dispatched workers
  // (native GUI subagents, AGY CLI sessions, and Codex CLI sessions + nested Codex subagents).
  const sessionRawEntries = [];
  let sessionSubagentCount = 0;
  let sessionAgyCliCount = 0;
  let sessionCodexCliCount = 0;

  if (activeConvId && activeData) {
    const rootProjId = activeProject?.id || resolveProjectForConv(activeConvId)?.id || '';
    const rootFirstMs = activeData.firstStepAt || activeData.turns?.[0]?.ts || 0;
    const rootLastMs = Math.max(activeData.lastStepAt || 0, activeData.mtimeMs || 0);
    const rootIsRecentOrLive = Boolean(
      activeSummary?.isRunning || !activeData.isTurnFinished || (rootLastMs > 0 && nowMs - rootLastMs <= 30 * 60_000),
    );
    const rootEndBoundMs = rootIsRecentOrLive ? 0 : rootLastMs + 25 * 60_000;
    const isTurnWithinRootWindow = (t) => {
      if (!t.ts || t.ts <= 0) return true;
      if (rootFirstMs > 0 && t.ts < rootFirstMs - 60_000) return false;
      if (rootEndBoundMs > 0 && t.ts > rootEndBoundMs) return false;
      return true;
    };
    const matchesPromptInBlob = (probes, blob) =>
      Boolean(probes && probes.length > 0 && blob && probes.every((p) => blob.includes(p)));

    // Build reverse indices for fast BFS traversal
    const childrenByParent = new Map();
    for (const [childId, parentId] of parentOfChild.entries()) {
      if (!parentId) continue;
      let list = childrenByParent.get(parentId);
      if (!list) {
        list = [];
        childrenByParent.set(parentId, list);
      }
      list.push(childId);
    }

    const codexChildrenByParentTid = new Map();
    const projectCodexList = [];
    for (const cs of codexSessions) {
      if (rootProjId && cs.projectId !== rootProjId) continue;
      projectCodexList.push(cs);
      if (cs.parentThreadId) {
        let list = codexChildrenByParentTid.get(cs.parentThreadId);
        if (!list) {
          list = [];
          codexChildrenByParentTid.set(cs.parentThreadId, list);
        }
        list.push(cs);
      }
    }

    const projectAgyCliList = [];
    for (const [cid, parsed] of parsedAgyCli.entries()) {
      const proj = resolveProjectForConv(cid);
      if (rootProjId && proj && proj.id !== rootProjId) continue;
      projectAgyCliList.push([cid, parsed]);
    }

    const attachedGuiIds = new Set();
    const attachedAgyCliIds = new Set();
    const attachedCodexIds = new Set();
    const queue = [];

    const enqueueAgyNode = (kind, id, parsed, brainDir) => {
      const idLower = String(id).toLowerCase();
      if (kind === 'gui') {
        if (attachedGuiIds.has(id)) return;
        attachedGuiIds.add(id);
      } else {
        if (attachedAgyCliIds.has(id)) return;
        attachedAgyCliIds.add(id);
      }
      const scratchSig = readConversationScratchSignals(join(brainDir, id), id);
      const uuids = new Set(parsed.referencedUuids || []);
      for (const u of scratchSig.uuids) uuids.add(u);
      const dispatchBlob =
        parsed.cliDispatchBlob && scratchSig.dispatchNorm
          ? `${parsed.cliDispatchBlob}\n${scratchSig.dispatchNorm}`
          : parsed.cliDispatchBlob || scratchSig.dispatchNorm || '';
      const firstMs = parsed.firstStepAt || parsed.turns?.[0]?.ts || parsed.mtimeMs || 0;
      const lastMs = Math.max(parsed.lastStepAt || 0, parsed.mtimeMs || 0);
      queue.push({ kind, id, idLower, parsed, firstMs, lastMs, uuids, dispatchBlob });
    };

    const enqueueCodexNode = (cs) => {
      if (attachedCodexIds.has(cs.idLower)) return;
      attachedCodexIds.add(cs.idLower);
      queue.push({
        kind: 'codex-cli',
        id: cs.id,
        idLower: cs.idLower,
        cs,
        firstMs: cs.firstEventTs || cs.turns?.[0]?.ts || cs.mtimeMs || 0,
        lastMs: cs.lastActiveMs || cs.mtimeMs || 0,
        uuids: cs.referencedUuids || new Set(),
        dispatchBlob: '',
      });
    };

    if (parsedDesktop.has(activeConvId)) {
      enqueueAgyNode('gui', activeConvId, activeData, desktopBrainDir);
    } else if (parsedAgyCli.has(activeConvId)) {
      enqueueAgyNode('agy-cli', activeConvId, activeData, cliBrainDir);
    }

    while (queue.length > 0) {
      const cur = queue.shift();

      // 1. Native GUI subagents & DB-linked children
      if (cur.kind === 'gui' || cur.kind === 'agy-cli') {
        for (const childId of childrenByParent.get(cur.id) || []) {
          if (childId === activeConvId || topConversationIdSet.has(childId)) continue;
          if (parsedAgyCli.has(childId)) {
            enqueueAgyNode('agy-cli', childId, parsedAgyCli.get(childId), cliBrainDir);
          } else if (parsedDesktop.has(childId)) {
            enqueueAgyNode('gui', childId, parsedDesktop.get(childId), desktopBrainDir);
          }
        }
      }

      // 2. Native Codex subagents (parent_thread_id / thread_spawn)
      if (cur.kind === 'codex-cli') {
        for (const subCs of codexChildrenByParentTid.get(cur.idLower) || []) {
          enqueueCodexNode(subCs);
        }
      }

      // 3. Dispatched AGY CLI workers (by exact UUID reference, reverse parent reference, or prompt fingerprint)
      for (const [cid, parsed] of projectAgyCliList) {
        if (attachedAgyCliIds.has(cid)) continue;
        const cidLower = cid.toLowerCase();
        const cFirst = parsed.firstStepAt || parsed.turns?.[0]?.ts || parsed.mtimeMs || 0;
        const cLast = Math.max(parsed.lastStepAt || 0, parsed.mtimeMs || 0);
        if (rootFirstMs > 0 && cLast > 0 && cLast < rootFirstMs - 60_000) continue;
        if (rootEndBoundMs > 0 && cFirst > 0 && cFirst > rootEndBoundMs) continue;

        const linkedByUuid =
          cur.uuids.has(cidLower) ||
          (cur.kind === 'gui' && Boolean(parsed.brainPathUuids?.has(cur.idLower)));
        const linkedByPrompt =
          !linkedByUuid &&
          Boolean(cur.dispatchBlob) &&
          parsed.promptProbes?.length > 0 &&
          cFirst >= cur.firstMs - 120_000 &&
          cFirst <= cur.lastMs + 10 * 60_000 &&
          matchesPromptInBlob(parsed.promptProbes, cur.dispatchBlob);

        if (linkedByUuid || linkedByPrompt) {
          enqueueAgyNode('agy-cli', cid, parsed, cliBrainDir);
        }
      }

      // 4. Dispatched Codex CLI workers & nested codex exec children
      for (const cs of projectCodexList) {
        if (attachedCodexIds.has(cs.idLower)) continue;
        const cFirst = cs.firstEventTs || cs.turns?.[0]?.ts || cs.mtimeMs || 0;
        const cLast = cs.lastActiveMs || cs.mtimeMs || 0;
        if (rootFirstMs > 0 && cLast > 0 && cLast < rootFirstMs - 60_000) continue;
        if (rootEndBoundMs > 0 && cFirst > 0 && cFirst > rootEndBoundMs) continue;

        const linkedByUuid =
          cur.uuids.has(cs.idLower) ||
          (cur.kind === 'gui' && Boolean(cs.brainPathUuids?.has(cur.idLower)));
        const linkedByPrompt =
          !linkedByUuid &&
          Boolean(cur.dispatchBlob) &&
          cs.promptProbes?.length > 0 &&
          cFirst >= cur.firstMs - 120_000 &&
          cFirst <= cur.lastMs + 10 * 60_000 &&
          matchesPromptInBlob(cs.promptProbes, cur.dispatchBlob);

        if (linkedByUuid || linkedByPrompt) {
          enqueueCodexNode(cs);
        }
      }
    }

    // Collect turns from all attached nodes within range (trimming any turns outside root session span on resumed worker threads)
    for (const gid of attachedGuiIds) {
      const parsed = parsedDesktop.get(gid);
      if (!parsed) continue;
      const isRoot = gid === activeConvId;
      const ranged = filterByRange(isRoot ? parsed.turns : parsed.turns.filter(isTurnWithinRootWindow));
      if (ranged.length) {
        if (!isRoot) sessionSubagentCount += 1;
        sessionRawEntries.push(...ranged.map((t) => ({ ...t, sourceKind: 'gui' })));
      }
    }
    for (const cid of attachedAgyCliIds) {
      const parsed = parsedAgyCli.get(cid);
      if (!parsed) continue;
      const isRoot = cid === activeConvId;
      const ranged = filterByRange(isRoot ? parsed.turns : parsed.turns.filter(isTurnWithinRootWindow));
      if (ranged.length) {
        if (!isRoot) sessionAgyCliCount += 1;
        sessionRawEntries.push(...ranged.map((t) => ({ ...t, sourceKind: 'agy-cli' })));
      }
    }
    for (const cs of projectCodexList) {
      if (!attachedCodexIds.has(cs.idLower)) continue;
      const ranged = filterByRange((cs.turns || []).filter(isTurnWithinRootWindow));
      if (ranged.length) {
        sessionCodexCliCount += 1;
        sessionRawEntries.push(...ranged.map((t) => ({ ...t, sourceKind: 'codex-cli' })));
      }
    }
  }

  const sessionAllStats = summarizeModelEntries(sessionRawEntries);
  const sessionFilteredStats =
    sourceFilter === 'all' ? sessionAllStats : summarizeModelEntries(filterBySource(sessionRawEntries));
  const sessionStats = {
    ...sessionFilteredStats,
    allBySource: sessionAllStats.bySource,
    subagentCount: sessionSubagentCount,
    agyCliCount: sessionAgyCliCount,
    codexCliCount: sessionCodexCliCount,
  };

  // Project stats map (ONLY configured sidebar Projects! Strictly tags gui vs agy-cli vs codex-cli!)
  const projectStatsMap = new Map();
  for (const proj of configuredProjects) {
    projectStatsMap.set(proj.id, {
      id: proj.id,
      name: proj.name,
      sessionIds: new Set(),
      agyCliCount: 0,
      codexCliCount: 0,
      entries: [],
    });
  }

  // Also collect ALL Antigravity turns (AGY GUI + AGY CLI ONLY — never external Codex CLI!) for 5h/7d quota tracking
  const agyGeminiTurns = [];
  const agyClaudeTurns = [];

  for (const [cid, parsed] of parsedDesktop.entries()) {
    if (parsedAgyCli.has(cid)) continue;
    for (const t of parsed.turns) {
      const fam = classifyAgyQuotaFamily(t.model);
      if (fam === 'gemini') agyGeminiTurns.push({ ...t, sourceKind: 'gui' });
      else if (fam === 'claude') agyClaudeTurns.push({ ...t, sourceKind: 'gui' });
    }
    const desc = subDescriptors.get(cid);
    const proj = resolveProjectForConv(cid, desc?.workspaceUris || []);
    if (!proj) continue;
    const bucket = projectStatsMap.get(proj.id);
    if (!parentOfChild.has(cid)) bucket.sessionIds.add(cid);
    const ranged = filterByRange(parsed.turns);
    if (ranged.length) {
      bucket.entries.push(...ranged.map((t) => ({ ...t, sourceKind: 'gui' })));
    }
  }

  for (const [cid, parsed] of parsedAgyCli.entries()) {
    for (const t of parsed.turns) {
      const fam = classifyAgyQuotaFamily(t.model);
      if (fam === 'gemini') agyGeminiTurns.push({ ...t, sourceKind: 'agy-cli' });
      else if (fam === 'claude') agyClaudeTurns.push({ ...t, sourceKind: 'agy-cli' });
    }
    const proj = resolveProjectForConv(cid);
    if (!proj) continue;
    const bucket = projectStatsMap.get(proj.id);
    const ranged = filterByRange(parsed.turns);
    if (ranged.length) {
      bucket.agyCliCount += 1;
      bucket.entries.push(...ranged.map((t) => ({ ...t, sourceKind: 'agy-cli' })));
    }
  }

  for (const cs of codexSessions) {
    const ranged = filterByRange(cs.turns || []);
    if (!ranged.length) continue;
    const bucket = projectStatsMap.get(cs.projectId);
    if (!bucket) continue;
    bucket.codexCliCount += 1;
    bucket.entries.push(...ranged.map((t) => ({ ...t, sourceKind: 'codex-cli' })));
  }

  const projectSummaries = configuredProjects.map((proj) => {
    const bkt = projectStatsMap.get(proj.id);
    const allStats = summarizeModelEntries(bkt.entries);
    const filteredStats = sourceFilter === 'all' ? allStats : summarizeModelEntries(filterBySource(bkt.entries));
    return {
      id: proj.id,
      name: proj.name,
      sessionCount: topConversations.filter((c) => c.projectId === proj.id).length,
      agyCliCount: bkt.agyCliCount,
      codexCliCount: bkt.codexCliCount,
      isActive: proj.id === activeProject?.id,
      ...filteredStats,
      allBySource: allStats.bySource,
    };
  });

  const activeProjectStats =
    projectSummaries.find((p) => p.id === activeProject?.id) ||
    projectSummaries[0] || {
      id: '',
      name: '当前项目',
      sessionCount: 0,
      agyCliCount: 0,
      codexCliCount: 0,
      ...summarizeModelEntries([]),
      allBySource: { gui: 0, agyCli: 0, codexCli: 0 },
    };

  const allProjectsRawEntries = [];
  for (const bkt of projectStatsMap.values()) allProjectsRawEntries.push(...bkt.entries);
  const allProjectsUnfiltered = summarizeModelEntries(allProjectsRawEntries);
  const allProjectsStats = {
    ...(sourceFilter === 'all' ? allProjectsUnfiltered : summarizeModelEntries(filterBySource(allProjectsRawEntries))),
    allBySource: allProjectsUnfiltered.bySource,
  };

  // Real Antigravity 5h & Weekly (7d) Quota Windows (strictly AGY GUI + AGY CLI, never external Codex!)
  const FIVE_H = 5 * 60 * 60 * 1000;
  const SEVEN_D = 7 * 24 * 60 * 60 * 1000;
  const quotas = {
    gemini: {
      label: 'Gemini 系列',
      h5: buildQuotaWindowStats(agyGeminiTurns, FIVE_H, quotaAnchor?.gemini5h, nowMs),
      d7: buildQuotaWindowStats(agyGeminiTurns, SEVEN_D, quotaAnchor?.gemini7d, nowMs),
    },
    claude: {
      label: 'Claude / GPT 系列',
      h5: buildQuotaWindowStats(agyClaudeTurns, FIVE_H, quotaAnchor?.claude5h, nowMs),
      d7: buildQuotaWindowStats(agyClaudeTurns, SEVEN_D, quotaAnchor?.claude7d, nowMs),
    },
  };
  const quotaActivity = buildQuotaActivityProfile(agyGeminiTurns, agyClaudeTurns, nowMs);

  // ==================== ACTIVE CLI & SUBAGENT MONITOR ====================
  // Show ONLY live/active/stalled agents by default (running, stalled > 20m, or touched within 3 min),
  // or recent 60 min if user explicitly toggles showRecentAgents.
  const LIVE_WINDOW_MS = 3 * 60 * 1000;
  const STALL_THRESHOLD_MS = 20 * 60 * 1000;
  const STALL_MAX_WINDOW_MS = 90 * 60 * 1000;
  const RECENT_WINDOW_MS = 60 * 60 * 1000;
  const liveAgents = [];
  let recentHiddenCount = 0;

  // A. Codex CLI agents (~/.codex/sessions)
  for (const cs of codexSessions) {
    const age = nowMs - cs.lastActiveMs;
    const isUnfinished = !cs.isCompleted && age < STALL_MAX_WINDOW_MS;
    const isStalled = isUnfinished && age >= STALL_THRESHOLD_MS;
    const isRunning = isUnfinished && !isStalled;
    const isLive = isRunning || isStalled || age <= LIVE_WINDOW_MS;
    const isRecent = age <= RECENT_WINDOW_MS;
    if (!isLive && !isRecent) continue;
    if (!isLive && !showRecentAgents) {
      recentHiddenCount += 1;
      continue;
    }

    const { baseModel, effort } = parseModelAndEffort(cs.model, cs.effort);
    const { taskTitle, rawTaskTitle } = buildChineseTaskTitle({ prompt: cs.firstUserPrompt });
    const promptTot = cs.uncachedInput + cs.cacheRead;
    const ctxSnap = buildContextSnapshotFromSource(cs, {
      isCodex: true,
      fallbackLimit: windowLimit,
      nowMs,
      resolveModelContextWindow,
    });
    liveAgents.push({
      id: cs.id,
      shortId: cs.shortId,
      targetKey: `codex-cli:${cs.id}`,
      kind: 'codex-cli',
      kindLabel: cs.isCliExec ? 'Codex CLI' : 'Codex',
      projectId: cs.projectId,
      projectName: cs.projectName,
      taskTitle,
      rawTaskTitle,
      isLive,
      isRunning,
      isStalled,
      stalledMinutes: isStalled ? Math.floor(age / 60000) : 0,
      statusLabel: isStalled ? '疑似卡住' : isRunning ? '运行中' : '刚完成',
      activity: isStalled ? `疑似卡住 · ${cs.activity}` : isRunning ? cs.activity : '本轮已完成',
      activityKind: isStalled ? 'stalled' : isRunning ? cs.activityKind : 'idle',
      actionDetail: isRunning || isStalled ? cs.lastToolDetail || '' : '',
      model: baseModel,
      effort,
      totalTokens: cs.totalTokens,
      cacheHitRate: promptTot > 0 ? Math.round((cs.cacheRead / promptTot) * 100) : 0,
      contextUsed: ctxSnap.used,
      contextLimit: ctxSnap.limit,
      contextPercent: ctxSnap.percent,
      lastTurnCacheHitRate: ctxSnap.lastTurnCache.hitRate,
      isCacheDrop: ctxSnap.lastTurnCache.isDrop,
      compactionCount: ctxSnap.compaction.count,
      lastActiveMs: cs.lastActiveMs,
      clickableConvId: '',
    });
  }

  // B. AGY CLI agents (~/.gemini/antigravity-cli/brain)
  for (const [cid, parsed] of parsedAgyCli.entries()) {
    const s = summaryById.get(cid);
    const proj = resolveProjectForConv(cid);
    if (!proj) continue;
    const lastActiveMs = Math.max(s?.lastModifiedMs || 0, parsed.lastStepAt || 0, parsed.mtimeMs || 0);
    const age = nowMs - lastActiveMs;
    const isUnfinished =
      (Boolean(s?.isRunning) && !s?.killed) ||
      (!parsed.isTurnFinished && !s?.killed && age < STALL_MAX_WINDOW_MS);
    const isStalled = isUnfinished && age >= STALL_THRESHOLD_MS;
    const isRunning = isUnfinished && !isStalled;
    const isLive = isRunning || isStalled || age <= LIVE_WINDOW_MS;
    const isRecent = age <= RECENT_WINDOW_MS;
    if (!isLive && !isRecent) continue;
    if (!isLive && !showRecentAgents) {
      recentHiddenCount += 1;
      continue;
    }

    const totals = summarizeModelEntries(parsed.turns);
    const { baseModel, effort } = parseModelAndEffort(parsed.lastModel);
    const { taskTitle, rawTaskTitle } = buildChineseTaskTitle({
      dbTitle: s?.explicitTitle || '',
      prompt: parsed.firstUserPrompt,
    });
    const ctxSnap = buildContextSnapshotFromSource(parsed, {
      isCodex: false,
      fallbackLimit: windowLimit,
      nowMs,
      resolveModelContextWindow,
    });
    liveAgents.push({
      id: cid,
      shortId: cid.slice(0, 8),
      targetKey: `agy-cli:${cid}`,
      kind: 'agy-cli',
      kindLabel: 'AGY CLI',
      projectId: proj.id,
      projectName: proj.name,
      taskTitle,
      rawTaskTitle,
      isLive,
      isRunning,
      isStalled,
      stalledMinutes: isStalled ? Math.floor(age / 60000) : 0,
      statusLabel: isStalled ? '疑似卡住' : isRunning ? '运行中' : '刚完成',
      activity: isStalled ? `疑似卡住 · ${parsed.activity}` : isRunning ? parsed.activity : '本轮已完成',
      activityKind: isStalled ? 'stalled' : isRunning ? parsed.activityKind : 'idle',
      actionDetail: isRunning || isStalled ? parsed.lastToolDetail || '' : '',
      model: baseModel,
      effort,
      totalTokens: totals.totalTokens,
      cacheHitRate: Math.round(totals.cacheHitRate),
      contextUsed: ctxSnap.used,
      contextLimit: ctxSnap.limit,
      contextPercent: ctxSnap.percent,
      lastTurnCacheHitRate: ctxSnap.lastTurnCache.hitRate,
      isCacheDrop: ctxSnap.lastTurnCache.isDrop,
      compactionCount: ctxSnap.compaction.count,
      lastActiveMs,
      clickableConvId: '',
    });
  }

  // C. Active Native GUI Subagents (ONLY running, stalled > 20m, or touched recently)
  const nativeSubIds = new Set([...parentOfChild.keys(), ...subDescriptors.keys()]);
  for (const cid of nativeSubIds) {
    if (parsedAgyCli.has(cid)) continue; // Avoid duplicating AGY CLI sessions as empty GUI subagents
    const s = summaryById.get(cid);
    const desc = subDescriptors.get(cid);
    const parsed = parsedDesktop.get(cid);
    if (!parsed && !s) continue;
    const proj = resolveProjectForConv(cid, desc?.workspaceUris || []);
    if (!proj) continue;

    const lastActiveMs = Math.max(s?.lastModifiedMs || 0, parsed?.lastStepAt || 0, parsed?.mtimeMs || 0);
    const age = nowMs - lastActiveMs;
    const isUnfinished =
      (Boolean(s?.isRunning) && !s?.killed) ||
      (Boolean(parsed && !parsed.isTurnFinished) && !s?.killed && age < STALL_MAX_WINDOW_MS);
    const isStalled = isUnfinished && age >= STALL_THRESHOLD_MS;
    const isRunning = isUnfinished && !isStalled;
    const isLive = isRunning || isStalled || age <= LIVE_WINDOW_MS;
    const isRecent = age <= RECENT_WINDOW_MS;
    if (!isLive && !isRecent) continue;
    if (!isLive && !showRecentAgents) {
      recentHiddenCount += 1;
      continue;
    }

    const totals = summarizeModelEntries(parsed?.turns || []);
    const { baseModel, effort } = parseModelAndEffort(parsed?.lastModel || '');
    const kindLabel = desc?.typeName ? `GUI 子智能体 · ${desc.typeName}` : 'GUI 子智能体';
    const { taskTitle, rawTaskTitle } = buildChineseTaskTitle({
      dbTitle: s?.explicitTitle || '',
      role: desc?.role || '',
      prompt: parsed?.firstUserPrompt || '',
    });
    const ctxSnap = buildContextSnapshotFromSource(parsed, {
      isCodex: false,
      fallbackLimit: windowLimit,
      nowMs,
      resolveModelContextWindow,
    });
    liveAgents.push({
      id: cid,
      shortId: cid.slice(0, 8),
      targetKey: `gui-subagent:${cid}`,
      kind: 'gui-subagent',
      kindLabel,
      projectId: proj.id,
      projectName: proj.name,
      taskTitle,
      rawTaskTitle,
      isLive,
      isRunning,
      isStalled,
      stalledMinutes: isStalled ? Math.floor(age / 60000) : 0,
      statusLabel: isStalled ? '疑似卡住' : isRunning ? '运行中' : '刚完成',
      activity: isStalled
        ? `疑似卡住 · ${parsed?.activity || '执行中'}`
        : isRunning
        ? parsed?.activity || '执行中'
        : '已完成',
      activityKind: isStalled ? 'stalled' : isRunning ? parsed?.activityKind || 'thinking' : 'idle',
      actionDetail: isRunning || isStalled ? parsed?.lastToolDetail || '' : '',
      model: baseModel,
      effort,
      totalTokens: totals.totalTokens,
      cacheHitRate: Math.round(totals.cacheHitRate),
      contextUsed: ctxSnap.used,
      contextLimit: ctxSnap.limit,
      contextPercent: ctxSnap.percent,
      lastTurnCacheHitRate: ctxSnap.lastTurnCache.hitRate,
      isCacheDrop: ctxSnap.lastTurnCache.isDrop,
      compactionCount: ctxSnap.compaction.count,
      lastActiveMs,
      clickableConvId: cid,
    });
  }

  liveAgents.sort((a, b) => {
    const rank = (x) => (x.isRunning ? 0 : x.isStalled ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return b.lastActiveMs - a.lastActiveMs;
  });

  // Resolve REAL-TIME CONTEXT WINDOW target (main conversation OR any active CLI / subagent!)
  let contextSnapshot = null;
  const reqTarget = String(contextTarget || 'main').trim();
  if (reqTarget && reqTarget !== 'main') {
    const colonIdx = reqTarget.indexOf(':');
    const tKind = colonIdx > 0 ? reqTarget.slice(0, colonIdx) : '';
    const tId = colonIdx > 0 ? reqTarget.slice(colonIdx + 1) : reqTarget;
    const matchedAgent = liveAgents.find((a) => a.targetKey === reqTarget || a.id === tId);

    if (tKind === 'codex-cli') {
      const cs = codexSessions.find((c) => c.id === tId);
      if (cs) {
        const { taskTitle } = buildChineseTaskTitle({ prompt: cs.firstUserPrompt });
        contextSnapshot = buildContextSnapshotFromSource(cs, {
          isCodex: true,
          fallbackLimit: windowLimit,
          nowMs,
          resolveModelContextWindow,
          targetMeta: {
            key: `codex-cli:${cs.id}`,
            isMain: false,
            kind: 'codex-cli',
            kindLabel: cs.isCliExec ? 'Codex CLI' : 'Codex',
            title: taskTitle || `Codex ${cs.shortId}`,
            projectName: cs.projectName,
          },
        });
      }
    } else if (tKind === 'agy-cli') {
      const parsed = parsedAgyCli.get(tId);
      if (parsed) {
        const s = summaryById.get(tId);
        const proj = resolveProjectForConv(tId);
        const { taskTitle } = buildChineseTaskTitle({
          dbTitle: s?.explicitTitle || '',
          prompt: parsed.firstUserPrompt,
        });
        contextSnapshot = buildContextSnapshotFromSource(parsed, {
          isCodex: false,
          fallbackLimit: windowLimit,
          nowMs,
          resolveModelContextWindow,
          targetMeta: {
            key: `agy-cli:${tId}`,
            isMain: false,
            kind: 'agy-cli',
            kindLabel: 'AGY CLI',
            title: taskTitle || matchedAgent?.taskTitle || `AGY CLI ${tId.slice(0, 8)}`,
            projectName: proj?.name || matchedAgent?.projectName || '',
          },
        });
      }
    } else if (tKind === 'gui-conv') {
      const parsed = parsedDesktop.get(tId);
      if (parsed) {
        const s = summaryById.get(tId);
        const proj = resolveProjectForConv(tId);
        contextSnapshot = buildContextSnapshotFromSource(parsed, {
          isCodex: false,
          fallbackLimit: windowLimit,
          nowMs,
          resolveModelContextWindow,
          targetMeta: {
            key: `gui-conv:${tId}`,
            isMain: false,
            kind: 'gui-conv',
            kindLabel: '其他主会话',
            title: s?.title || `会话 ${tId.slice(0, 8)}`,
            projectName: proj?.name || '',
          },
        });
      }
    } else if (tKind === 'gui-subagent') {
      const parsed = parsedDesktop.get(tId);
      if (parsed) {
        const s = summaryById.get(tId);
        const desc = subDescriptors.get(tId);
        const proj = resolveProjectForConv(tId, desc?.workspaceUris || []);
        const { taskTitle } = buildChineseTaskTitle({
          dbTitle: s?.explicitTitle || '',
          role: desc?.role || '',
          prompt: parsed.firstUserPrompt,
        });
        contextSnapshot = buildContextSnapshotFromSource(parsed, {
          isCodex: false,
          fallbackLimit: windowLimit,
          nowMs,
          resolveModelContextWindow,
          targetMeta: {
            key: `gui-subagent:${tId}`,
            isMain: false,
            kind: 'gui-subagent',
            kindLabel: desc?.typeName ? `GUI 子智能体 · ${desc.typeName}` : 'GUI 子智能体',
            title: taskTitle || matchedAgent?.taskTitle || `子智能体 ${tId.slice(0, 8)}`,
            projectName: proj?.name || matchedAgent?.projectName || '',
          },
        });
      }
    }
  }

  if (!contextSnapshot) {
    contextSnapshot = buildContextSnapshotFromSource(activeData, {
      isCodex: false,
      fallbackLimit: windowLimit,
      nowMs,
      resolveModelContextWindow,
      targetMeta: {
        key: 'main',
        isMain: true,
        kind: 'gui',
        kindLabel: '主会话',
        title: activeConvObj.title,
        projectName: activeConvObj.projectName,
      },
    });
  }

  // Build rich 24h context switcher targets (all recent GUI main sessions + 24h CLI/subagents across projects)
  const CTX_LOOKBACK_MS = 24 * 60 * 60 * 1000;
  const recentAgentTargets = [];
  const seenTargetKeys = new Set();

  for (const a of liveAgents) {
    seenTargetKeys.add(a.targetKey);
    recentAgentTargets.push({
      targetKey: a.targetKey,
      kind: a.kind,
      kindLabel: a.kindLabel,
      title: a.taskTitle || a.shortId,
      projectId: a.projectId,
      projectName: a.projectName,
      isRunning: a.isRunning,
      isStalled: a.isStalled,
      contextUsed: a.contextUsed,
      contextLimit: a.contextLimit,
      contextPercent: a.contextPercent,
      lastActiveMs: a.lastActiveMs,
    });
  }

  for (const cs of codexSessions) {
    const key = `codex-cli:${cs.id}`;
    if (seenTargetKeys.has(key) || nowMs - cs.lastActiveMs > CTX_LOOKBACK_MS) continue;
    const ctxSnap = buildContextSnapshotFromSource(cs, { isCodex: true, fallbackLimit: windowLimit, nowMs, resolveModelContextWindow });
    if (ctxSnap.used <= 0) continue;
    seenTargetKeys.add(key);
    const { taskTitle } = buildChineseTaskTitle({ prompt: cs.firstUserPrompt });
    recentAgentTargets.push({
      targetKey: key,
      kind: 'codex-cli',
      kindLabel: cs.isCliExec ? 'Codex CLI' : 'Codex',
      title: taskTitle || `Codex ${cs.shortId}`,
      projectId: cs.projectId,
      projectName: cs.projectName,
      isRunning: false,
      isStalled: false,
      contextUsed: ctxSnap.used,
      contextLimit: ctxSnap.limit,
      contextPercent: ctxSnap.percent,
      lastActiveMs: cs.lastActiveMs,
    });
  }

  for (const [cid, parsed] of parsedAgyCli.entries()) {
    const key = `agy-cli:${cid}`;
    if (seenTargetKeys.has(key)) continue;
    const s = summaryById.get(cid);
    const proj = resolveProjectForConv(cid);
    if (!proj) continue;
    const lastActiveMs = Math.max(s?.lastModifiedMs || 0, parsed.lastStepAt || 0, parsed.mtimeMs || 0);
    if (nowMs - lastActiveMs > CTX_LOOKBACK_MS) continue;
    const ctxSnap = buildContextSnapshotFromSource(parsed, { isCodex: false, fallbackLimit: windowLimit, nowMs, resolveModelContextWindow });
    if (ctxSnap.used <= 0) continue;
    seenTargetKeys.add(key);
    const { taskTitle } = buildChineseTaskTitle({ dbTitle: s?.explicitTitle || '', prompt: parsed.firstUserPrompt });
    recentAgentTargets.push({
      targetKey: key,
      kind: 'agy-cli',
      kindLabel: 'AGY CLI',
      title: taskTitle || `AGY CLI ${cid.slice(0, 8)}`,
      projectId: proj.id,
      projectName: proj.name,
      isRunning: false,
      isStalled: false,
      contextUsed: ctxSnap.used,
      contextLimit: ctxSnap.limit,
      contextPercent: ctxSnap.percent,
      lastActiveMs,
    });
  }

  for (const cid of nativeSubIds) {
    if (parsedAgyCli.has(cid)) continue;
    const key = `gui-subagent:${cid}`;
    if (seenTargetKeys.has(key)) continue;
    const parsed = parsedDesktop.get(cid);
    if (!parsed) continue;
    const s = summaryById.get(cid);
    const desc = subDescriptors.get(cid);
    const proj = resolveProjectForConv(cid, desc?.workspaceUris || []);
    if (!proj) continue;
    const lastActiveMs = Math.max(s?.lastModifiedMs || 0, parsed.lastStepAt || 0, parsed.mtimeMs || 0);
    if (nowMs - lastActiveMs > CTX_LOOKBACK_MS) continue;
    const ctxSnap = buildContextSnapshotFromSource(parsed, { isCodex: false, fallbackLimit: windowLimit, nowMs, resolveModelContextWindow });
    if (ctxSnap.used <= 0) continue;
    seenTargetKeys.add(key);
    const { taskTitle } = buildChineseTaskTitle({
      dbTitle: s?.explicitTitle || '',
      role: desc?.role || '',
      prompt: parsed.firstUserPrompt,
    });
    recentAgentTargets.push({
      targetKey: key,
      kind: 'gui-subagent',
      kindLabel: desc?.typeName ? `GUI 子智能体 · ${desc.typeName}` : 'GUI 子智能体',
      title: taskTitle || `子智能体 ${cid.slice(0, 8)}`,
      projectId: proj.id,
      projectName: proj.name,
      isRunning: false,
      isStalled: false,
      contextUsed: ctxSnap.used,
      contextLimit: ctxSnap.limit,
      contextPercent: ctxSnap.percent,
      lastActiveMs,
    });
  }

  recentAgentTargets.sort((a, b) => {
    const rank = (x) => (x.isRunning ? 0 : x.isStalled ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return b.lastActiveMs - a.lastActiveMs;
  });

  const otherSessionTargets = [];
  for (const c of topConversations.slice(0, 20)) {
    if (c.id === activeConvId) continue;
    const parsed = parsedDesktop.get(c.id);
    if (!parsed) continue;
    const ctxSnap = buildContextSnapshotFromSource(parsed, {
      isCodex: false,
      fallbackLimit: windowLimit,
      nowMs,
      resolveModelContextWindow,
    });
    otherSessionTargets.push({
      targetKey: `gui-conv:${c.id}`,
      kind: 'gui-conv',
      kindLabel: '主会话',
      title: c.title,
      projectId: c.projectId,
      projectName: c.projectName,
      isRunning: c.isRunning,
      isStalled: false,
      contextUsed: ctxSnap.used,
      contextLimit: ctxSnap.limit,
      contextPercent: ctxSnap.percent,
      lastActiveMs: c.lastModifiedMs,
    });
  }

  // Conversations filtered to the active project (or all if no project selected)
  const visibleConversations = activeProject
    ? topConversations.filter((c) => c.projectId === activeProject.id)
    : topConversations;

  return {
    updatedAt: nowMs,
    projects: projectSummaries,
    activeProjectId: activeProject?.id || '',
    activeProjectName: activeProject?.name || '项目',
    activeConversation: activeConvObj,
    conversations: visibleConversations.slice(0, 30),
    stats: {
      scope: statsScope,
      sourceFilter,
      range,
      project: activeProjectStats,
      session: sessionStats,
      all: allProjectsStats,
    },
    quotas,
    quotaActivity,
    context: contextSnapshot,
    contextTargets: {
      agents: recentAgentTargets.slice(0, 20),
      sessions: otherSessionTargets.slice(0, 15),
    },
    activeAgents: {
      items: liveAgents.slice(0, 40),
      runningCount: liveAgents.filter((a) => a.isRunning).length,
      stalledCount: liveAgents.filter((a) => a.isStalled).length,
      recentHiddenCount,
      showRecent: Boolean(showRecentAgents),
    },
  };
}

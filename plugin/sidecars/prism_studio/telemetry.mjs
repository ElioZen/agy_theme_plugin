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

function matchProjectByPathOrId(projects, { projectId = '', paths = [] } = {}) {
  if (projectId) {
    const byId = projects.find((p) => p.id === projectId);
    if (byId) return byId;
  }
  for (const rawP of paths) {
    const p = normalizePathFromUri(rawP);
    if (!p) continue;
    for (const proj of projects) {
      for (const folder of proj.folders) {
        if (p === folder || p.startsWith(`${folder}/`)) {
          return proj;
        }
      }
    }
  }
  return null;
}

// ==================== TRANSCRIPT PARSER (AGY Desktop + AGY CLI) ====================
const transcriptCache = new Map();

function describeToolAction(toolName) {
  if (!toolName) return '执行工具';
  const base = String(toolName).replace(/^default_api:/, '');
  const label = TOOL_ACTION_LABELS[base];
  return label ? `${label} (${base})` : `执行 ${base}`;
}

function parseAgyTranscript(filePath) {
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
  let userChars = 0;
  let assistantChars = 0;
  let thinkingChars = 0;
  let toolChars = 0;
  let lastModel = '';
  let lastStepAt = 0;
  let prevStepMs = 0;
  let totalSteps = 0;
  let lastObj = null;

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
    if (ts > lastStepAt) lastStepAt = ts;

    if (obj.type === 'USER_INPUT') {
      userChars += String(obj.content || '').length;
    } else if (obj.type === 'PLANNER_RESPONSE') {
      const model = String(obj.model || '');
      if (model) lastModel = model;
      const inTok = Number(obj.input_tokens || 0);
      const cacheTok = Number(obj.cache_read_tokens || 0);
      const outTok = Number(obj.output_tokens || 0);
      thinkingChars += String(obj.thinking || '').length;
      assistantChars += String(obj.content || '').length;
      toolChars += Array.isArray(obj.tool_calls) ? JSON.stringify(obj.tool_calls).length : 0;

      let tokPerSec = null;
      if (prevStepMs > 0 && ts > prevStepMs && outTok >= 15) {
        const deltaSec = (ts - prevStepMs) / 1000;
        if (deltaSec >= 0.8 && deltaSec <= 240) {
          const rate = outTok / deltaSec;
          if (rate > 0.5 && rate < 450) tokPerSec = Math.round(rate * 10) / 10;
        }
      }

      if (inTok > 0 || cacheTok > 0 || outTok > 0) {
        turns.push({
          stepIndex: Number(obj.step_index || 0),
          ts,
          model: model || 'unknown',
          uncachedInput: inTok,
          cacheRead: cacheTok,
          output: outTok,
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
      userChars = 0;
      assistantChars = String(obj.content || '').length;
      thinkingChars = 0;
      toolChars = 0;
    } else {
      toolChars += String(obj.content || '').length;
    }

    if (ts > 0) prevStepMs = ts;
  }

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
    totalSteps,
    lastModel,
    lastStepAt,
    mtimeMs: stat.mtimeMs,
    activity,
    activityKind,
    isTurnFinished,
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

function listRecentCodexFiles(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const root = join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return [];
  const cutoff = Date.now() - maxAgeMs;
  const results = [];

  function walk(dir, depth) {
    if (depth > 4) return;
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
      } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        try {
          const st = statSync(full);
          if (st.mtimeMs >= cutoff) {
            results.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
          }
        } catch {
          // ignore
        }
      }
    }
  }

  walk(root, 0);
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.slice(0, 40);
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
  let lastEventTs = 0;
  let isCompleted = false;
  let activity = '运行中';
  let activityKind = 'thinking';
  let turnCount = 0;
  let prevUsage = null;
  const turns = [];

  const lines = text.split('\n');
  const tailStartIdx = Math.max(0, lines.length - 50);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const isTail = i >= tailStartIdx;
    // Fast-skip giant historical response_item lines outside the live tail
    if (
      !isTail &&
      !line.includes('"token_count"') &&
      !line.includes('"turn_context"') &&
      !line.includes('"session_meta"') &&
      !line.includes('"thread_settings_applied"') &&
      !line.includes('"task_started"') &&
      !line.includes('"task_complete"') &&
      !line.includes('"turn_aborted"')
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
    if (ts > lastEventTs) lastEventTs = ts;
    const p = obj.payload || {};

    if (obj.type === 'session_meta') {
      if (p.id || p.session_id) sessionId = String(p.id || p.session_id);
      if (p.cwd) cwd = String(p.cwd);
      if (p.originator) originator = String(p.originator);
      if (p.source) source = String(p.source);
    } else if (obj.type === 'turn_context') {
      if (p.model) model = String(p.model);
      if (p.effort || p.reasoning_effort) effort = String(p.effort || p.reasoning_effort);
      if (p.cwd && !cwd) cwd = String(p.cwd);
      turnCount += 1;
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
        if (!prevUsage) {
          dIn = curIn;
          dCached = curCached;
          dOut = curOut;
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
        } else if (p.info.last_token_usage) {
          const lu = p.info.last_token_usage;
          dIn = Number(lu.input_tokens || 0);
          dCached = Number(lu.cached_input_tokens || 0);
          dOut = Number(lu.output_tokens || 0);
        }
        prevUsage = { input_tokens: curIn, cached_input_tokens: curCached, output_tokens: curOut };

        if (dIn > 0 || dCached > 0 || dOut > 0) {
          const clampedCached = Math.min(dIn, dCached);
          turns.push({
            ts,
            model: model || 'codex',
            effort,
            uncachedInput: Math.max(0, dIn - clampedCached),
            cacheRead: clampedCached,
            output: dOut,
          });
        }

        inputTokens = curIn;
        cachedTokens = curCached;
        outputTokens = curOut;
        reasoningTokens = curReason;
        totalTokens = curTot;
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
      isCompleted = false;
      if (p.type === 'reasoning') {
        activity = '正在思考 (Thinking)';
        activityKind = 'thinking';
      } else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
        activity = describeToolAction(p.name || 'tool');
        activityKind = 'tool';
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
  const data = {
    id: sessionId,
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
    turnCount,
    turns,
    lastActiveMs: Math.max(lastEventTs, statInfo.mtimeMs),
    mtimeMs: statInfo.mtimeMs,
    isCompleted,
    activity,
    activityKind,
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
        LIMIT 300
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
        totalTokens: 0,
        turns: 0,
        costUsd: 0,
      };
      map.set(key, entry);
    }
    const rowTok = t.uncachedInput + t.cacheRead + t.output;
    entry.uncachedInput += t.uncachedInput;
    entry.cacheRead += t.cacheRead;
    entry.output += t.output;
    entry.totalTokens += rowTok;
    entry.turns += t.turns || 1;
    const cost = estimateCostUsd(mId, t.uncachedInput, t.cacheRead, t.output);
    entry.costUsd += cost;

    if (src === 'agy-cli') bySource.agyCli += rowTok;
    else if (src === 'codex-cli') bySource.codexCli += rowTok;
    else bySource.gui += rowTok;

    totalUncached += t.uncachedInput;
    totalCacheRead += t.cacheRead;
    totalOutput += t.output;
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
        costUsd: Math.round(m.costUsd * 100) / 100,
      };
    });

  const promptAll = totalUncached + totalCacheRead;
  return {
    totalTokens: totalUncached + totalCacheRead + totalOutput,
    uncachedInput: totalUncached,
    cacheRead: totalCacheRead,
    output: totalOutput,
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

function getRangeCutoffMs(range) {
  const now = new Date();
  if (range === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  if (range === '7d') return Date.now() - 7 * 24 * 60 * 60 * 1000;
  if (range === '30d') return Date.now() - 30 * 24 * 60 * 60 * 1000;
  return 0;
}

export function buildTelemetrySnapshot({
  conversationId = '',
  hostConversationId = '',
  activeWorkspaceUri = '',
  selectedProjectId = '',
  followLatest = true,
  statsScope = 'project', // 'project' | 'session' | 'all'
  sourceFilter = 'all', // 'all' | 'gui' | 'agy-cli' | 'codex-cli'
  range = 'today',
  windowLimit = 512000,
  showRecentAgents = false,
  quotaAnchor = {},
} = {}) {
  const appDataDir = resolveAppDataDir();
  const desktopBrainDir = join(appDataDir, 'brain');
  const cliAppDataDir = join(homedir(), '.gemini', 'antigravity-cli');
  const cliBrainDir = join(cliAppDataDir, 'brain');
  const nowMs = Date.now();

  // 1. Real configured projects matching Antigravity's left sidebar 1-to-1!
  const configuredProjects = loadConfiguredProjects();

  // 2. Read desktop & CLI DB metadata
  const desktopDb = readSummariesDb(join(appDataDir, 'conversation_summaries.db'));
  const cliDb = readSummariesDb(join(cliAppDataDir, 'conversation_summaries.db'));
  const summaryById = new Map([...cliDb.summaryById, ...desktopDb.summaryById]);
  const parentOfChild = new Map([...cliDb.parentOfChild, ...desktopDb.parentOfChild]);

  // Helper: map any conversation or CLI session to one of the real configured Projects
  function resolveProjectForConv(cid, extraPaths = []) {
    const s = summaryById.get(cid);
    const paths = [...(s?.workspaceUris || []), ...extraPaths];
    const direct = matchProjectByPathOrId(configuredProjects, { projectId: s?.projectId || '', paths });
    if (direct) return direct;
    const pid = parentOfChild.get(cid);
    if (pid) {
      const ps = summaryById.get(pid);
      const fromParent = matchProjectByPathOrId(configuredProjects, {
        projectId: ps?.projectId || '',
        paths: ps?.workspaceUris || [],
      });
      if (fromParent) return fromParent;
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

  // Parse all desktop + agy-cli transcripts (cached by mtime:size)
  const parsedDesktop = new Map();
  if (existsSync(desktopBrainDir)) {
    for (const id of readdirSync(desktopBrainDir)) {
      if (!/^[0-9a-f-]{8,}$/i.test(id)) continue;
      const p = join(desktopBrainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
      const parsed = parseAgyTranscript(p);
      if (parsed) parsedDesktop.set(id, parsed);
    }
  }

  const parsedAgyCli = new Map();
  if (existsSync(cliBrainDir)) {
    for (const id of readdirSync(cliBrainDir)) {
      if (!/^[0-9a-f-]{8,}$/i.test(id)) continue;
      const p = join(cliBrainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
      const parsed = parseAgyTranscript(p);
      if (parsed) parsedAgyCli.set(id, parsed);
    }
  }

  // Parse recent Codex CLI sessions belonging to configured projects (fast-filter CWD from 32KB header first)
  const codexSessions = [];
  for (const f of listRecentCodexFiles(30 * 24 * 60 * 60 * 1000)) {
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

  // Active conversation metadata & REAL-TIME CONTEXT WINDOW (completely separate card!)
  const activeSummary = summaryById.get(activeConvId);
  const activeData = parsedDesktop.get(activeConvId) || parsedAgyCli.get(activeConvId) || null;
  const activeTurns = activeData?.turns || [];
  const latestTurn = activeTurns.length > 0 ? activeTurns[activeTurns.length - 1] : null;
  const activeConvObj = {
    id: activeConvId,
    title: activeSummary?.title || (activeConvId ? '当前会话' : '暂无会话'),
    projectId: activeProject?.id || '',
    projectName: activeProject?.name || '项目',
    isRunning: Boolean(activeSummary?.isRunning),
    statusLabel: activeSummary?.statusLabel || '就绪',
    stepCount: activeSummary?.stepCount || activeData?.totalSteps || 0,
  };

  const limit = Math.max(32000, Number(windowLimit) || 512000);
  const usedTokens = latestTurn ? latestTurn.contextTokens : 0;
  const usedPercent = Math.min(100, Math.round((usedTokens / limit) * 1000) / 10);

  const systemBase = usedTokens > 0 ? Math.min(usedTokens, Math.round(Math.min(14000, usedTokens * 0.22))) : 0;
  const variableTokens = Math.max(0, usedTokens - systemBase);
  const w = activeData?.charWeights || { user: 0, assistant: 0, thinking: 0, tool: 0 };
  const weightSum = Math.max(1, w.user + w.assistant + w.thinking + w.tool);
  const thinkingTokens = Math.round(variableTokens * (w.thinking / weightSum));
  const dialogTokens = Math.round(variableTokens * ((w.user + w.assistant) / weightSum));
  const toolTokens = Math.max(0, variableTokens - thinkingTokens - dialogTokens);
  const remainingTokens = Math.max(0, limit - usedTokens);

  const speedPoints = activeTurns
    .filter((t) => typeof t.tokPerSec === 'number')
    .slice(-14)
    .map((t) => ({ step: t.stepIndex, rate: t.tokPerSec, ts: t.ts }));
  const latestSpeed = speedPoints.length > 0 ? speedPoints[speedPoints.length - 1].rate : 0;
  const avgSpeed =
    speedPoints.length > 0
      ? Math.round((speedPoints.reduce((acc, p) => acc + p.rate, 0) / speedPoints.length) * 10) / 10
      : 0;
  const parsedLastModel = parseModelAndEffort(activeData?.lastModel || latestTurn?.model || '');

  // ==================== UNIFIED PROJECT & SESSION STATS ====================
  const cutoffRangeMs = getRangeCutoffMs(range);
  const filterByRange = (turns) => turns.filter((t) => !(cutoffRangeMs > 0 && t.ts > 0 && t.ts < cutoffRangeMs));

  // Subagent descriptors for parent->project linking
  const parentIds = new Set(topConversations.map((c) => c.id));
  for (const pid of parentOfChild.values()) parentIds.add(pid);
  const subDescriptors = readSubagentDescriptors(desktopBrainDir, [...parentIds]);
  for (const [cid, desc] of subDescriptors.entries()) {
    if (!parentOfChild.has(cid)) parentOfChild.set(cid, desc.parentId);
  }

  // Session stats (strictly current GUI conversation within chosen time range)
  const sessionStats = summarizeModelEntries(
    filterByRange(activeTurns).map((t) => ({ ...t, sourceKind: 'gui' })),
  );

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

  const filterBySource = (entries) => {
    if (!sourceFilter || sourceFilter === 'all') return entries;
    return entries.filter((e) => e.sourceKind === sourceFilter);
  };

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

  // ==================== ACTIVE CLI & SUBAGENT MONITOR ====================
  // Show ONLY live/active agents by default (running or touched within 3 min),
  // or recent 60 min if user explicitly toggles showRecentAgents.
  const LIVE_WINDOW_MS = 3 * 60 * 1000;
  const RECENT_WINDOW_MS = 60 * 60 * 1000;
  const liveAgents = [];
  let recentHiddenCount = 0;

  // A. Codex CLI agents (~/.codex/sessions)
  for (const cs of codexSessions) {
    const age = nowMs - cs.lastActiveMs;
    const isRunning = !cs.isCompleted && age < 10 * 60 * 1000;
    const isLive = isRunning || age <= LIVE_WINDOW_MS;
    const isRecent = age <= RECENT_WINDOW_MS;
    if (!isLive && !isRecent) continue;
    if (!isLive && !showRecentAgents) {
      recentHiddenCount += 1;
      continue;
    }

    const { baseModel, effort } = parseModelAndEffort(cs.model, cs.effort);
    const promptTot = cs.uncachedInput + cs.cacheRead;
    liveAgents.push({
      id: cs.id,
      shortId: cs.shortId,
      kind: 'codex-cli',
      kindLabel: cs.isCliExec ? 'Codex CLI' : 'Codex',
      projectId: cs.projectId,
      projectName: cs.projectName,
      isRunning,
      statusLabel: isRunning ? '运行中' : '刚完成',
      activity: isRunning ? cs.activity : '本轮已完成',
      activityKind: isRunning ? cs.activityKind : 'idle',
      model: baseModel,
      effort,
      totalTokens: cs.totalTokens,
      cacheHitRate: promptTot > 0 ? Math.round((cs.cacheRead / promptTot) * 100) : 0,
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
    const isRunning =
      Boolean(s?.isRunning) ||
      (!parsed.isTurnFinished && age < 15 * 60 * 1000);
    const isLive = isRunning || age <= LIVE_WINDOW_MS;
    const isRecent = age <= RECENT_WINDOW_MS;
    if (!isLive && !isRecent) continue;
    if (!isLive && !showRecentAgents) {
      recentHiddenCount += 1;
      continue;
    }

    const totals = summarizeModelEntries(parsed.turns);
    const { baseModel, effort } = parseModelAndEffort(parsed.lastModel);
    liveAgents.push({
      id: cid,
      shortId: cid.slice(0, 8),
      kind: 'agy-cli',
      kindLabel: 'AGY CLI',
      projectId: proj.id,
      projectName: proj.name,
      isRunning,
      statusLabel: isRunning ? '运行中' : '刚完成',
      activity: isRunning ? parsed.activity : '本轮已完成',
      activityKind: isRunning ? parsed.activityKind : 'idle',
      model: baseModel,
      effort,
      totalTokens: totals.totalTokens,
      cacheHitRate: Math.round(totals.cacheHitRate),
      lastActiveMs,
      clickableConvId: '',
    });
  }

  // C. Active Native GUI Subagents (ONLY running or touched recently — zero dead history!)
  const nativeSubIds = new Set([...parentOfChild.keys(), ...subDescriptors.keys()]);
  for (const cid of nativeSubIds) {
    const s = summaryById.get(cid);
    const desc = subDescriptors.get(cid);
    const parsed = parsedDesktop.get(cid);
    if (!parsed && !s) continue;
    const proj = resolveProjectForConv(cid, desc?.workspaceUris || []);
    if (!proj) continue;

    const lastActiveMs = Math.max(s?.lastModifiedMs || 0, parsed?.lastStepAt || 0, parsed?.mtimeMs || 0);
    const age = nowMs - lastActiveMs;
    const isRunning =
      (Boolean(s?.isRunning) && !s?.killed) ||
      (Boolean(parsed && !parsed.isTurnFinished) && !s?.killed && age < 15 * 60 * 1000);
    const isLive = isRunning || age <= LIVE_WINDOW_MS;
    const isRecent = age <= RECENT_WINDOW_MS;
    if (!isLive && !isRecent) continue;
    if (!isLive && !showRecentAgents) {
      recentHiddenCount += 1;
      continue;
    }

    const totals = summarizeModelEntries(parsed?.turns || []);
    const { baseModel, effort } = parseModelAndEffort(parsed?.lastModel || '');
    const kindLabel = desc?.typeName ? `GUI 子智能体 · ${desc.typeName}` : 'GUI 子智能体';
    liveAgents.push({
      id: cid,
      shortId: cid.slice(0, 8),
      kind: 'gui-subagent',
      kindLabel,
      projectId: proj.id,
      projectName: proj.name,
      isRunning,
      statusLabel: isRunning ? '运行中' : '刚完成',
      activity: isRunning ? parsed?.activity || '执行中' : '已完成',
      activityKind: isRunning ? parsed?.activityKind || 'thinking' : 'idle',
      model: baseModel,
      effort,
      totalTokens: totals.totalTokens,
      cacheHitRate: Math.round(totals.cacheHitRate),
      lastActiveMs,
      clickableConvId: cid,
    });
  }

  liveAgents.sort((a, b) => {
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
    return b.lastActiveMs - a.lastActiveMs;
  });

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
    context: {
      used: usedTokens,
      limit,
      percent: usedPercent,
      remaining: remainingTokens,
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
        rawModel: activeData?.lastModel || latestTurn?.model || '',
        turnCount: activeTurns.filter((t) => !t.isCheckpoint).length,
      },
    },
    activeAgents: {
      items: liveAgents.slice(0, 12),
      runningCount: liveAgents.filter((a) => a.isRunning).length,
      recentHiddenCount,
      showRecent: Boolean(showRecentAgents),
    },
  };
}

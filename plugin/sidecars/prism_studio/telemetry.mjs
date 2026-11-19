import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveAppDataDir } from './storage.mjs';

// Estimated reference pricing per 1M tokens (USD) for display reference only.
const MODEL_PRICING = [
  { match: /gemini-4-neon/i, input: 1.5, cacheRead: 0.15, output: 6.0, label: 'Gemini 4 Neon' },
  { match: /gemini-4-hydrogen/i, input: 1.25, cacheRead: 0.125, output: 5.0, label: 'Gemini 4 Hydrogen' },
  { match: /gemini-4-argon/i, input: 0.6, cacheRead: 0.06, output: 2.5, label: 'Gemini 4 Argon' },
  { match: /gemini-4-carbon/i, input: 0.35, cacheRead: 0.035, output: 1.5, label: 'Gemini 4 Carbon' },
  { match: /gemini-3.*flash/i, input: 0.3, cacheRead: 0.03, output: 1.2, label: 'Gemini 3.8 Flash' },
  { match: /claude.*opus/i, input: 15.0, cacheRead: 1.5, output: 75.0, label: 'Claude Opus' },
  { match: /claude.*sonnet/i, input: 3.0, cacheRead: 0.3, output: 15.0, label: 'Claude Sonnet' },
  { match: /gpt/i, input: 2.5, cacheRead: 0.25, output: 10.0, label: 'GPT' },
];

export function formatModelName(modelId) {
  if (!modelId) return '未知模型';
  if (/^MODEL_PLACEHOLDER_/i.test(modelId)) return `实验模型 (${modelId.replace(/^MODEL_PLACEHOLDER_/, '')})`;
  for (const p of MODEL_PRICING) {
    if (p.match.test(modelId)) return modelId;
  }
  return modelId;
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

export function localizeStatus(status, notFullyIdle) {
  if (notFullyIdle || status === 'CASCADE_RUN_STATUS_RUNNING') {
    return { code: 'running', label: '运行中' };
  }
  if (status === 'CASCADE_RUN_STATUS_IDLE') {
    return { code: 'idle', label: '空闲' };
  }
  if (status === 'CASCADE_RUN_STATUS_ERROR') {
    return { code: 'error', label: '异常' };
  }
  return { code: 'idle', label: '就绪' };
}

function parseWorkspaceName(workspaceUrisRaw) {
  try {
    const arr = JSON.parse(workspaceUrisRaw || '[]');
    if (Array.isArray(arr) && arr.length > 0) {
      const clean = String(arr[0]).replace(/^file:\/\//, '').replace(/\/+$/, '');
      return basename(decodeURIComponent(clean)) || '工作区';
    }
  } catch {
    // ignore
  }
  return '全局';
}

function parseTimestampMs(raw) {
  if (!raw) return 0;
  const str = String(raw).trim().replace(' ', 'T');
  const ms = Date.parse(str);
  return Number.isFinite(ms) ? ms : 0;
}

// Per-file parsed transcript summary cache keyed by "mtimeMs:size"
const transcriptCache = new Map();

function parseTranscriptFile(filePath) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }
  const cacheKey = `${stat.mtimeMs}:${stat.size}`;
  const cached = transcriptCache.get(filePath);
  if (cached && cached.cacheKey === cacheKey) {
    return cached.data;
  }

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

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

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
      const thinkLen = String(obj.thinking || '').length;
      const contentLen = String(obj.content || '').length;
      const toolLen = Array.isArray(obj.tool_calls) ? JSON.stringify(obj.tool_calls).length : 0;

      thinkingChars += thinkLen;
      assistantChars += contentLen;
      toolChars += toolLen;

      let tokPerSec = null;
      if (prevStepMs > 0 && ts > prevStepMs && outTok >= 15) {
        const deltaSec = (ts - prevStepMs) / 1000;
        if (deltaSec >= 0.8 && deltaSec <= 240) {
          const rate = outTok / deltaSec;
          if (rate > 0.5 && rate < 450) {
            tokPerSec = Math.round(rate * 10) / 10;
          }
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
        });
      }
    } else {
      // Tool outputs / generic steps
      toolChars += String(obj.content || '').length;
    }

    if (ts > 0) prevStepMs = ts;
  }

  const data = {
    turns,
    lastModel,
    lastStepAt,
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

export function listConversations(appDataDir = resolveAppDataDir(), limit = 40) {
  const dbPath = join(appDataDir, 'conversation_summaries.db');
  if (!existsSync(dbPath)) return [];

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
          workspace_uris
        FROM conversation_summaries
        WHERE (parent_conversation_id = '' OR parent_conversation_id IS NULL)
          AND (nesting_depth = 0 OR nesting_depth IS NULL)
        ORDER BY last_modified_time DESC
        LIMIT ?
      `)
      .all(limit);

    return rows.map((r) => {
      const st = localizeStatus(r.status, Boolean(r.not_fully_idle));
      return {
        id: r.conversation_id,
        title: (r.title || '').trim() || (r.preview || '').trim().slice(0, 42) || '未命名会话',
        workspace: parseWorkspaceName(r.workspace_uris),
        stepCount: Number(r.step_count || 0),
        status: st.code,
        statusLabel: st.label,
        isRunning: st.code === 'running',
        lastModifiedMs: parseTimestampMs(r.last_modified_time),
      };
    });
  } catch (err) {
    console.error('[prism_studio] Failed to read conversation_summaries.db:', err.message);
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

function getRangeCutoffMs(range) {
  const now = new Date();
  if (range === 'today') {
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return startOfToday;
  }
  if (range === '7d') return Date.now() - 7 * 24 * 60 * 60 * 1000;
  if (range === '30d') return Date.now() - 30 * 24 * 60 * 60 * 1000;
  return 0;
}

export function buildTelemetrySnapshot({
  conversationId = '',
  followLatest = true,
  scope = 'all',
  range = 'today',
  windowLimit = 512000,
} = {}) {
  const appDataDir = resolveAppDataDir();
  const brainDir = join(appDataDir, 'brain');
  const conversations = listConversations(appDataDir, 50);

  // Pick target conversation
  let activeConvId = conversationId;
  if (followLatest || !activeConvId) {
    const running = conversations.find((c) => c.isRunning);
    activeConvId = (running || conversations[0])?.id || conversationId || '';
  }

  const activeConv = conversations.find((c) => c.id === activeConvId) || {
    id: activeConvId,
    title: activeConvId ? '当前会话' : '暂无会话',
    workspace: '工作区',
    status: 'idle',
    statusLabel: '就绪',
    isRunning: false,
    stepCount: 0,
    lastModifiedMs: Date.now(),
  };

  // Current conversation context & speed
  const activePath = activeConvId
    ? join(brainDir, activeConvId, '.system_generated', 'logs', 'transcript.jsonl')
    : '';
  const activeData = activePath ? parseTranscriptFile(activePath) : null;
  const activeTurns = activeData?.turns || [];
  const latestTurn = activeTurns.length > 0 ? activeTurns[activeTurns.length - 1] : null;

  const limit = Math.max(32000, Number(windowLimit) || 512000);
  const usedTokens = latestTurn ? latestTurn.contextTokens : 0;
  const usedPercent = Math.min(100, Math.round((usedTokens / limit) * 1000) / 10);

  // Compute proportional breakdown of current context
  const systemBase = usedTokens > 0 ? Math.min(usedTokens, Math.round(Math.min(14000, usedTokens * 0.22))) : 0;
  const variableTokens = Math.max(0, usedTokens - systemBase);
  const w = activeData?.charWeights || { user: 0, assistant: 0, thinking: 0, tool: 0 };
  const weightSum = Math.max(1, w.user + w.assistant + w.thinking + w.tool);
  const thinkingTokens = Math.round(variableTokens * (w.thinking / weightSum));
  const dialogTokens = Math.round(variableTokens * ((w.user + w.assistant) / weightSum));
  const toolTokens = Math.max(0, variableTokens - thinkingTokens - dialogTokens);
  const remainingTokens = Math.max(0, limit - usedTokens);

  // Speed sparkline from recent valid turns
  const speedPoints = activeTurns
    .filter((t) => typeof t.tokPerSec === 'number')
    .slice(-14)
    .map((t) => ({ step: t.stepIndex, rate: t.tokPerSec, ts: t.ts }));
  const latestSpeed = speedPoints.length > 0 ? speedPoints[speedPoints.length - 1].rate : 0;
  const avgSpeed =
    speedPoints.length > 0
      ? Math.round((speedPoints.reduce((acc, p) => acc + p.rate, 0) / speedPoints.length) * 10) / 10
      : 0;

  // Aggregate model token usage
  const cutoffMs = getRangeCutoffMs(range);
  const modelMap = new Map();

  const convDirsToScan = (() => {
    if (scope === 'current') {
      return activeConvId ? [activeConvId] : [];
    }
    if (!existsSync(brainDir)) return [];
    try {
      return readdirSync(brainDir);
    } catch {
      return [];
    }
  })();

  let totalUncached = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let totalCostUsd = 0;

  for (const dir of convDirsToScan) {
    const p = join(brainDir, dir, '.system_generated', 'logs', 'transcript.jsonl');
    const parsed = parseTranscriptFile(p);
    if (!parsed) continue;
    for (const t of parsed.turns) {
      if (cutoffMs > 0 && t.ts > 0 && t.ts < cutoffMs) continue;
      const mId = t.model || 'unknown';
      let entry = modelMap.get(mId);
      if (!entry) {
        entry = {
          model: mId,
          displayName: formatModelName(mId),
          uncachedInput: 0,
          cacheRead: 0,
          output: 0,
          totalTokens: 0,
          turns: 0,
          costUsd: 0,
        };
        modelMap.set(mId, entry);
      }
      entry.uncachedInput += t.uncachedInput;
      entry.cacheRead += t.cacheRead;
      entry.output += t.output;
      entry.totalTokens += t.uncachedInput + t.cacheRead + t.output;
      entry.turns += 1;
      const turnCost = estimateCostUsd(mId, t.uncachedInput, t.cacheRead, t.output);
      entry.costUsd += turnCost;

      totalUncached += t.uncachedInput;
      totalCacheRead += t.cacheRead;
      totalOutput += t.output;
      totalCostUsd += turnCost;
    }
  }

  const models = [...modelMap.values()]
    .map((m) => {
      const promptTotal = m.uncachedInput + m.cacheRead;
      return {
        ...m,
        cacheHitRate: promptTotal > 0 ? Math.round((m.cacheRead / promptTotal) * 1000) / 10 : 0,
        costUsd: Math.round(m.costUsd * 100) / 100,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const totalPrompt = totalUncached + totalCacheRead;
  const overallCacheHitRate = totalPrompt > 0 ? Math.round((totalCacheRead / totalPrompt) * 1000) / 10 : 0;

  return {
    updatedAt: Date.now(),
    activeConversation: activeConv,
    conversations: conversations.slice(0, 24),
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
    },
    speed: {
      latest: latestSpeed,
      average: avgSpeed,
      sparkline: speedPoints,
      lastModel: activeData?.lastModel || latestTurn?.model || '',
      lastModelDisplay: formatModelName(activeData?.lastModel || latestTurn?.model || ''),
      lastStepAt: activeData?.lastStepAt || 0,
      turnCount: activeTurns.length,
    },
    usage: {
      scope,
      range,
      totalTokens: totalUncached + totalCacheRead + totalOutput,
      uncachedInput: totalUncached,
      cacheRead: totalCacheRead,
      output: totalOutput,
      cacheHitRate: overallCacheHitRate,
      costUsd: Math.round(totalCostUsd * 100) / 100,
      models,
    },
  };
}

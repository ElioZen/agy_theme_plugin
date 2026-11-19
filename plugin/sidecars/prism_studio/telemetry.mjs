import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveAppDataDir } from './storage.mjs';

const MODEL_PRICING = [
  { match: /gemini-4-neon/i, input: 1.5, cacheRead: 0.15, output: 6.0, family: 'gemini' },
  { match: /gemini-4-hydrogen/i, input: 1.25, cacheRead: 0.125, output: 5.0, family: 'gemini' },
  { match: /gemini-4-argon/i, input: 0.6, cacheRead: 0.06, output: 2.5, family: 'gemini' },
  { match: /gemini-4-carbon/i, input: 0.35, cacheRead: 0.035, output: 1.5, family: 'gemini' },
  { match: /gemini/i, input: 0.35, cacheRead: 0.035, output: 1.5, family: 'gemini' },
  { match: /claude.*opus/i, input: 15.0, cacheRead: 1.5, output: 75.0, family: 'claude' },
  { match: /claude.*sonnet/i, input: 3.0, cacheRead: 0.3, output: 15.0, family: 'claude' },
  { match: /claude/i, input: 3.0, cacheRead: 0.3, output: 15.0, family: 'claude' },
  { match: /gpt|o1|o3|o4/i, input: 2.5, cacheRead: 0.25, output: 10.0, family: 'claude' },
];

const MODEL_PALETTE = ['#6EA8FF', '#F4B860', '#38D9A9', '#C084FC', '#F472B6', '#38BDF8'];

export function classifyModelFamily(modelId) {
  const s = String(modelId || '').toLowerCase();
  if (s.includes('claude') || s.includes('gpt')) return 'claude';
  if (s.includes('gemini') || s.includes('model_placeholder')) return 'gemini';
  return 'gemini';
}

export function formatModelName(modelId) {
  if (!modelId) return '未知模型';
  if (/^MODEL_PLACEHOLDER_/i.test(modelId)) {
    return `Gemini 实验版 (${modelId.replace(/^MODEL_PLACEHOLDER_/, '')})`;
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

export function localizeStatus(status, notFullyIdle, killed = false) {
  if (killed) return { code: 'killed', label: '已结束' };
  if (notFullyIdle || status === 'CASCADE_RUN_STATUS_RUNNING') {
    return { code: 'running', label: '运行中' };
  }
  if (status === 'CASCADE_RUN_STATUS_ERROR') {
    return { code: 'error', label: '异常' };
  }
  return { code: 'idle', label: '空闲' };
}

function parseWorkspaceInfo(workspaceUrisRaw) {
  try {
    const arr = Array.isArray(workspaceUrisRaw) ? workspaceUrisRaw : JSON.parse(workspaceUrisRaw || '[]');
    if (Array.isArray(arr) && arr.length > 0) {
      const uri = String(arr[0]);
      const clean = uri.replace(/^file:\/\//, '').replace(/\/+$/, '');
      return {
        uri,
        name: basename(decodeURIComponent(clean)) || '工作区',
      };
    }
  } catch {
    // ignore
  }
  return { uri: '', name: '全局' };
}

function parseTimestampMs(raw) {
  if (!raw) return 0;
  const str = String(raw).trim().replace(' ', 'T');
  const ms = Date.parse(str);
  return Number.isFinite(ms) ? ms : 0;
}

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
  let totalSteps = 0;
  let lastStepType = '';
  let lastStepStatus = '';
  let firstPromptPreview = '';

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    totalSteps += 1;
    const ts = parseTimestampMs(obj.created_at);
    if (ts > lastStepAt) lastStepAt = ts;
    lastStepType = String(obj.type || '');
    lastStepStatus = String(obj.status || '');

    if (obj.type === 'USER_INPUT') {
      const c = String(obj.content || '');
      userChars += c.length;
      if (!firstPromptPreview && c.trim()) {
        firstPromptPreview = c
          .replace(/<\/?USER_REQUEST>/gi, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 56);
      }
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
      toolChars += String(obj.content || '').length;
    }

    if (ts > 0) prevStepMs = ts;
  }

  const data = {
    turns,
    totalSteps,
    lastModel,
    lastStepAt,
    mtimeMs: stat.mtimeMs,
    lastStepType,
    lastStepStatus,
    firstPromptPreview,
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

function readDbMetadata(appDataDir) {
  const dbPath = join(appDataDir, 'conversation_summaries.db');
  const summaryById = new Map();
  const parentOfChild = new Map();

  if (!existsSync(dbPath)) {
    return { summaryById, parentOfChild };
  }

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
      const ws = parseWorkspaceInfo(r.workspace_uris);
      const st = localizeStatus(r.status, Boolean(r.not_fully_idle), Boolean(r.killed));
      summaryById.set(r.conversation_id, {
        id: r.conversation_id,
        title: (r.title || '').trim() || (r.preview || '').trim().slice(0, 44) || '',
        workspace: ws.name,
        workspaceUri: ws.uri,
        stepCount: Number(r.step_count || 0),
        status: st.code,
        statusLabel: st.label,
        isRunning: st.code === 'running',
        killed: Boolean(r.killed),
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
      // conversation_parents might not exist in older builds
    }
  } catch (err) {
    console.error('[prism_studio] Failed to read conversation_summaries.db:', err.message);
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
  // Map<childConvId, { parentId, typeName, role, state, spawnStepIndex, workspace, workspaceUri }>
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
        const ws = parseWorkspaceInfo(raw.workspaceUris);
        map.set(cid, {
          parentId,
          typeName: raw.subagentDescriptor?.typeName || '',
          role: raw.subagentDescriptor?.role || '',
          state: raw.state || '',
          spawnStepIndex: Number(raw.spawnStepIndex || 0),
          workspace: ws.name,
          workspaceUri: ws.uri,
        });
      } catch {
        // ignore torn JSON
      }
    }
  }
  return map;
}

function readSwarmWorkers(brainDir, parentIds) {
  const workers = [];
  for (const parentId of parentIds) {
    const membersPath = join(brainDir, parentId, '.system_generated', 'swarm', 'members.json');
    if (!existsSync(membersPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(membersPath, 'utf-8'));
      const members = raw?.members && typeof raw.members === 'object' ? raw.members : {};
      for (const [name, m] of Object.entries(members)) {
        if (!m || m.role === 'coordinator') continue;
        const cid = m.conversationId || m.conversation_id || '';
        if (!cid) continue;
        workers.push({
          id: cid,
          parentId,
          role: m.role || name,
          typeName: 'swarm',
          name,
          state: m.killed ? 'killed' : m.status || 'active',
        });
      }
    } catch {
      // ignore
    }
  }
  return workers;
}

function summarizeModels(turns) {
  const map = new Map();
  let totalUncached = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let totalCostUsd = 0;

  for (const t of turns) {
    const mId = t.model || 'unknown';
    let entry = map.get(mId);
    if (!entry) {
      entry = {
        model: mId,
        displayName: formatModelName(mId),
        family: classifyModelFamily(mId),
        uncachedInput: 0,
        cacheRead: 0,
        output: 0,
        totalTokens: 0,
        turns: 0,
        costUsd: 0,
      };
      map.set(mId, entry);
    }
    entry.uncachedInput += t.uncachedInput;
    entry.cacheRead += t.cacheRead;
    entry.output += t.output;
    entry.totalTokens += t.uncachedInput + t.cacheRead + t.output;
    entry.turns += 1;
    const cost = estimateCostUsd(mId, t.uncachedInput, t.cacheRead, t.output);
    entry.costUsd += cost;

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
    models,
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

function buildQuotaWindow(turns, windowMs, budgetTokens, nowMs) {
  const cutoff = nowMs - windowMs;
  let tokens = 0;
  let weightedTokens = 0;
  let calls = 0;
  let earliestTs = 0;

  for (const t of turns) {
    if (!t.ts || t.ts < cutoff) continue;
    const total = t.uncachedInput + t.cacheRead + t.output;
    tokens += total;
    // Weighted quota pressure: cache reads count ~0.1x, uncached input 1x, output 4x
    weightedTokens += t.uncachedInput + t.cacheRead * 0.1 + t.output * 4;
    calls += 1;
    if (!earliestTs || t.ts < earliestTs) earliestTs = t.ts;
  }

  const resetAtMs = earliestTs ? earliestTs + windowMs : 0;
  const resetInMs = resetAtMs ? Math.max(0, resetAtMs - nowMs) : 0;
  const usedRatio = budgetTokens > 0 ? Math.min(100, Math.round((tokens / budgetTokens) * 1000) / 10) : 0;

  return {
    tokens,
    weightedTokens: Math.round(weightedTokens),
    calls,
    budgetTokens,
    usedPercent: usedRatio,
    remainingPercent: Math.max(0, Math.round((100 - usedRatio) * 10) / 10),
    resetAtMs,
    resetInMs,
  };
}

export function buildTelemetrySnapshot({
  conversationId = '',
  hostConversationId = '',
  activeWorkspaceUri = '',
  projectFilter = '',
  followLatest = true,
  includeSubagentsInSession = false,
  range = 'today',
  windowLimit = 512000,
  quotaBudgets = {},
} = {}) {
  const appDataDir = resolveAppDataDir();
  const brainDir = join(appDataDir, 'brain');
  const nowMs = Date.now();
  const { summaryById, parentOfChild } = readDbMetadata(appDataDir);

  const brainIds = existsSync(brainDir)
    ? readdirSync(brainDir).filter((d) => /^[0-9a-f-]{8,}$/i.test(d))
    : [];

  // Identify top-level conversations vs subagents
  const topConversations = [];
  for (const s of summaryById.values()) {
    const isChild = Boolean(s.parentId || s.nestingDepth > 0 || parentOfChild.has(s.id));
    const isCliEphemeral = s.source === 'CORTEX_TRAJECTORY_SOURCE_CLI' && !s.title;
    if (!isChild && !isCliEphemeral) {
      topConversations.push({
        ...s,
        title: s.title || '未命名会话',
      });
    }
  }
  topConversations.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);

  // Resolve active conversation accurately!
  // Priority when followLatest=true:
  //   1. If host switched to a workspace that doesn't match hostConversationId, pick newest conversation in that workspace
  //   2. Otherwise ALWAYS follow hostConversationId (the exact open conversation in Antigravity!)
  //   3. Fallback to most recently modified top-level conversation
  let activeConvId = conversationId;
  if (followLatest) {
    const hostSummary = hostConversationId ? summaryById.get(hostConversationId) : null;
    const normalizedActiveWs = String(activeWorkspaceUri || '').replace(/\/+$/, '');
    const hostWs = String(hostSummary?.workspaceUri || '').replace(/\/+$/, '');

    if (normalizedActiveWs && hostWs && normalizedActiveWs !== hostWs) {
      const wsMatch = topConversations.find(
        (c) => String(c.workspaceUri || '').replace(/\/+$/, '') === normalizedActiveWs,
      );
      activeConvId = wsMatch?.id || hostConversationId || topConversations[0]?.id || '';
    } else if (hostConversationId) {
      activeConvId = hostConversationId;
    } else if (normalizedActiveWs) {
      const wsMatch = topConversations.find(
        (c) => String(c.workspaceUri || '').replace(/\/+$/, '') === normalizedActiveWs,
      );
      activeConvId = wsMatch?.id || topConversations[0]?.id || '';
    } else {
      activeConvId = topConversations[0]?.id || '';
    }
  } else if (!activeConvId) {
    activeConvId = hostConversationId || topConversations[0]?.id || '';
  }

  // Build subagent descriptors from all known parent conversations
  const parentIdSet = new Set(topConversations.map((c) => c.id));
  for (const pid of parentOfChild.values()) parentIdSet.add(pid);
  const subDescriptors = readSubagentDescriptors(brainDir, [...parentIdSet]);
  const swarmWorkers = readSwarmWorkers(brainDir, [...parentIdSet]);
  const swarmMap = new Map(swarmWorkers.map((w) => [w.id, w]));

  // Merge all discovered parent->child relations
  for (const [cid, desc] of subDescriptors.entries()) {
    if (!parentOfChild.has(cid)) parentOfChild.set(cid, desc.parentId);
  }
  for (const w of swarmWorkers) {
    if (!parentOfChild.has(w.id)) parentOfChild.set(w.id, w.parentId);
  }

  // Parse all transcripts once (cached by mtime:size)
  const parsedById = new Map();
  for (const id of brainIds) {
    const p = join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
    const parsed = parseTranscriptFile(p);
    if (parsed) parsedById.set(id, parsed);
  }

  // Active conversation metadata & context
  const activeSummary = summaryById.get(activeConvId);
  const activeData = activeConvId ? parsedById.get(activeConvId) : null;
  const activeTurns = activeData?.turns || [];
  const latestTurn = activeTurns.length > 0 ? activeTurns[activeTurns.length - 1] : null;

  const activeConv = activeSummary
    ? { ...activeSummary, title: activeSummary.title || activeData?.firstPromptPreview || '当前会话' }
    : {
        id: activeConvId,
        title: activeData?.firstPromptPreview || (activeConvId ? '当前会话' : '暂无会话'),
        workspace: '全局',
        workspaceUri: '',
        status: 'idle',
        statusLabel: '就绪',
        isRunning: false,
        stepCount: activeData?.totalSteps || 0,
        lastModifiedMs: activeData?.lastStepAt || nowMs,
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

  // Current conversation model share (pure main conversation by default; optionally roll up its direct subagents)
  const childIdsOfActive = [];
  for (const [cid, pid] of parentOfChild.entries()) {
    if (pid === activeConvId) childIdsOfActive.push(cid);
  }
  const sessionTurnsForShare = [...activeTurns];
  if (includeSubagentsInSession) {
    for (const cid of childIdsOfActive) {
      const cp = parsedById.get(cid);
      if (cp?.turns?.length) sessionTurnsForShare.push(...cp.turns);
    }
  }
  const sessionModelUsage = {
    ...summarizeModels(sessionTurnsForShare),
    conversationId: activeConvId,
    subagentCount: childIdsOfActive.length,
    includeSubagents: Boolean(includeSubagentsInSession),
  };

  // Rolling 5h & 7d Quota Windows (Gemini vs Claude/GPT) across ALL transcripts
  const geminiTurns = [];
  const claudeTurns = [];
  const cutoffRangeMs = getRangeCutoffMs(range);

  // Project-level aggregation (rolls up subagents into their parent's workspace!)
  const projectMap = new Map();

  function resolveWorkspaceForConv(convId) {
    const s = summaryById.get(convId);
    if (s && s.workspace && s.workspace !== '全局') return { name: s.workspace, uri: s.workspaceUri };
    const desc = subDescriptors.get(convId);
    if (desc && desc.workspace && desc.workspace !== '全局') return { name: desc.workspace, uri: desc.workspaceUri };
    const pid = parentOfChild.get(convId);
    if (pid) {
      const ps = summaryById.get(pid);
      if (ps && ps.workspace) return { name: ps.workspace, uri: ps.workspaceUri };
    }
    return { name: s?.workspace || '全局', uri: s?.workspaceUri || '' };
  }

  for (const [cid, parsed] of parsedById.entries()) {
    const ws = resolveWorkspaceForConv(cid);
    const isSub = parentOfChild.has(cid) || Boolean(summaryById.get(cid)?.parentId);

    for (const t of parsed.turns) {
      const fam = classifyModelFamily(t.model);
      if (fam === 'claude') claudeTurns.push(t);
      else geminiTurns.push(t);
    }

    const filteredTurns = parsed.turns.filter((t) => !(cutoffRangeMs > 0 && t.ts > 0 && t.ts < cutoffRangeMs));
    if (filteredTurns.length === 0 && !summaryById.has(cid)) continue;

    let proj = projectMap.get(ws.name);
    if (!proj) {
      proj = {
        name: ws.name,
        workspaceUri: ws.uri,
        sessionIds: new Set(),
        subagentIds: new Set(),
        runningCount: 0,
        turns: [],
      };
      projectMap.set(ws.name, proj);
    }
    if (isSub) proj.subagentIds.add(cid);
    else proj.sessionIds.add(cid);
    if (summaryById.get(cid)?.isRunning) proj.runningCount += 1;
    proj.turns.push(...filteredTurns);
  }

  const projects = [...projectMap.values()]
    .map((p) => {
      const stats = summarizeModels(p.turns);
      return {
        name: p.name,
        workspaceUri: p.workspaceUri,
        sessionCount: p.sessionIds.size,
        subagentCount: p.subagentIds.size,
        runningCount: p.runningCount,
        isCurrentProject: p.name === activeConv.workspace,
        ...stats,
      };
    })
    .filter((p) => p.totalTokens > 0 || p.runningCount > 0)
    .sort((a, b) => {
      if (a.isCurrentProject !== b.isCurrentProject) return a.isCurrentProject ? -1 : 1;
      return b.totalTokens - a.totalTokens;
    });

  // Overall range totals
  const allRangeTurns = [];
  for (const parsed of parsedById.values()) {
    for (const t of parsed.turns) {
      if (cutoffRangeMs > 0 && t.ts > 0 && t.ts < cutoffRangeMs) continue;
      allRangeTurns.push(t);
    }
  }
  const overallUsage = summarizeModels(allRangeTurns);

  // Build Subagent Live Monitor list (combines conversation_parents + subagents/*.json + conversation_summaries + swarm + recent CLI agents)
  const subagentIds = new Set([...parentOfChild.keys(), ...subDescriptors.keys(), ...swarmMap.keys()]);
  const recentCliCutoff = nowMs - 24 * 60 * 60 * 1000;
  for (const s of summaryById.values()) {
    if (s.source === 'CORTEX_TRAJECTORY_SOURCE_CLI' && (s.isRunning || s.lastModifiedMs >= recentCliCutoff)) {
      subagentIds.add(s.id);
    }
  }
  const subagents = [];

  for (const cid of subagentIds) {
    const pid = parentOfChild.get(cid) || subDescriptors.get(cid)?.parentId || '';
    const parentSummary = summaryById.get(pid);
    const childSummary = summaryById.get(cid);
    const desc = subDescriptors.get(cid);
    const swarm = swarmMap.get(cid);
    const parsed = parsedById.get(cid);
    const isCliAgent = childSummary?.source === 'CORTEX_TRAJECTORY_SOURCE_CLI';

    const lastActiveMs = Math.max(
      childSummary?.lastModifiedMs || 0,
      parsed?.lastStepAt || 0,
      parsed?.mtimeMs || 0,
    );

    // Determine live state cleanly
    const recentlyTouched = lastActiveMs > 0 && nowMs - lastActiveMs < 90 * 1000;
    const isRunning =
      Boolean(childSummary?.isRunning) ||
      (recentlyTouched && parsed?.lastStepStatus !== 'DONE') ||
      swarm?.state === 'working';
    const isAliveRecent = !isRunning && lastActiveMs > 0 && nowMs - lastActiveMs < 30 * 60 * 1000;

    let statusCode = 'idle';
    let statusLabel = '空闲';
    if (childSummary?.killed || desc?.state === 'SUBAGENT_STATE_KILLED' || swarm?.state === 'killed') {
      statusCode = 'killed';
      statusLabel = '已结束';
    } else if (isRunning) {
      statusCode = 'running';
      statusLabel = '运行中';
    } else if (isAliveRecent || desc?.state === 'SUBAGENT_STATE_ALIVE') {
      statusCode = 'alive';
      statusLabel = '待命';
    }

    const ws = resolveWorkspaceForConv(cid);
    const turns = parsed?.turns || [];
    const totalTokens = turns.reduce((acc, t) => acc + t.uncachedInput + t.cacheRead + t.output, 0);
    const latestCtx = turns.length > 0 ? turns[turns.length - 1].contextTokens : 0;

    const typeLabel =
      desc?.typeName ||
      childSummary?.agentName ||
      swarm?.typeName ||
      (isCliAgent ? 'cli-agent' : 'subagent');
    const roleLabel =
      desc?.role ||
      swarm?.name ||
      childSummary?.title ||
      (parsed?.firstPromptPreview ? parsed.firstPromptPreview.slice(0, 34) : `${typeLabel} #${cid.slice(0, 8)}`);

    subagents.push({
      id: cid,
      shortId: cid.slice(0, 8),
      parentId: pid,
      parentTitle: parentSummary?.title || (isCliAgent ? 'CLI 托管任务' : pid ? pid.slice(0, 8) : '主会话'),
      workspace: ws.name,
      typeName: typeLabel,
      role: roleLabel,
      status: statusCode,
      statusLabel,
      isRunning,
      parentIsRunning: Boolean(parentSummary?.isRunning),
      stepCount: childSummary?.stepCount || parsed?.totalSteps || 0,
      model: parsed?.lastModel ? formatModelName(parsed.lastModel) : '—',
      totalTokens,
      contextTokens: latestCtx,
      lastActiveMs,
    });
  }

  subagents.sort((a, b) => {
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
    if (a.parentIsRunning !== b.parentIsRunning) return a.parentIsRunning ? -1 : 1;
    return b.lastActiveMs - a.lastActiveMs;
  });

  // Quota rolling windows (5h & 7d)
  const FIVE_H = 5 * 60 * 60 * 1000;
  const SEVEN_D = 7 * 24 * 60 * 60 * 1000;
  const quotas = {
    gemini: {
      label: 'Gemini 系列',
      h5: buildQuotaWindow(geminiTurns, FIVE_H, Number(quotaBudgets.gemini5h || 60_000_000), nowMs),
      d7: buildQuotaWindow(geminiTurns, SEVEN_D, Number(quotaBudgets.gemini7d || 500_000_000), nowMs),
    },
    claude: {
      label: 'Claude / GPT 系列',
      h5: buildQuotaWindow(claudeTurns, FIVE_H, Number(quotaBudgets.claude5h || 15_000_000), nowMs),
      d7: buildQuotaWindow(claudeTurns, SEVEN_D, Number(quotaBudgets.claude7d || 120_000_000), nowMs),
    },
  };

  const projectNames = [...new Set(topConversations.map((c) => c.workspace).filter(Boolean))];
  const filteredTopConversations = projectFilter
    ? topConversations.filter((c) => c.workspace === projectFilter)
    : topConversations;

  return {
    updatedAt: nowMs,
    activeConversation: activeConv,
    projectNames,
    projectFilter,
    conversations: filteredTopConversations.slice(0, 30),
    allConversationsCount: topConversations.length,
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
    sessionModels: sessionModelUsage,
    speed: {
      latest: latestSpeed,
      average: avgSpeed,
      sparkline: speedPoints,
      lastModel: activeData?.lastModel || latestTurn?.model || '',
      lastModelDisplay: formatModelName(activeData?.lastModel || latestTurn?.model || ''),
      lastStepAt: activeData?.lastStepAt || 0,
      turnCount: activeTurns.length,
    },
    quotas,
    subagents: subagents.slice(0, 20),
    projects,
    overallUsage: {
      range,
      ...overallUsage,
    },
  };
}

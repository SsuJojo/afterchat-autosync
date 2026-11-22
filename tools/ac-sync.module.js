  // =============================================================
  //  🔄 AC-SYNC — 自动增量同步模块（本地修改版，非上游功能）
  //  SPDX-License-Identifier: AGPL-3.0
  //  本块为 AfterChat 的 local modification（注入于 initialize() 之前）：
  //  复用闭包内 PLATFORM_ADAPTERS / getConversationSortTime / makeMarkdownZipFilename
  //  等内部件，把“上次同步之后”的新对话经 FSA 目录句柄直写本地 _sync 目录，
  //  不产生下载文件、不进 Downloads。
  //  排队续传：待办队列与已导出登记持久化在 <id>/_sync_index.json，崩溃后从
  //  索引续传；限流按错误文本识别 → 30min 静默 + 收窄批量；单条指数退避重试，
  //  反复失败写 _failed/ 毒丸并定时跳过。
  //  只读网站：仅调用既有 adapter 的读取方法，绝不创建/发送/点击任何会
  //  改动账号状态的东西；唯一写入目标是用户授权的本地目录。
  //  =============================================================

  // ---- 平台开关：一行改这里即可增减自动同步平台 ----
  const AC_SYNC_PLATFORMS = [
    'm365', 'copilot', 'ima', 'zai', 'chatglm', 'duck', 'pplx',
    'deepseek', 'qwen', 'qianwen', 'yuanbao', 'hunyuan', 'kimi',
    'doubao', 'minimax', 'aistudio', 'openai', 'grok', 'grokcom',
    'gemini', 'gaim', 'arena', 'mistral', 'sakana', 'claude',
    'poe', 'monica', 'stepfun', 'stepfunchat',
  ];

  const AC_SYNC_STATE_KEY = 'ac-sync-state';          // 状态（localStorage，不含对话内容）
  const AC_SYNC_ANCHOR_PREFIX = 'ac-sync-anchor-';    // 新锚点 key 前缀（不写 m365-export-anchor-*）
  const AC_SYNC_DB_NAME = 'acSyncDb';                 // IndexedDB：目录句柄持久化
  const AC_SYNC_DB_STORE = 'handles';
  const AC_SYNC_ROOT_KEY = 'root';                    // 根目录句柄（用户所选目录，建议独立空目录）
  const AC_SYNC_PICKER_ID = 'ac-sync-root';           // 目录选择器稳定 id：浏览器按站点记住上次所选目录
  const AC_SYNC_BOOT_DELAY = 15 * 1000;               // 启动后 15s 跑第一轮
  const AC_SYNC_BASE_INTERVAL = 10 * 60 * 1000;       // 常规间隔 10min
  const AC_SYNC_MAX_BACKOFF = 60 * 60 * 1000;         // 连续失败退避上限 60min
  const AC_SYNC_VISIBLE_DEBOUNCE = 60 * 1000;         // 回前台触发防抖 60s
  const AC_SYNC_INDEX_NAME = '_sync_index.json';      // 每平台持久化索引：待办队列/已导出登记（崩溃可续传）
  const AC_SYNC_INDEX_VERSION = 2;
  const AC_SYNC_429_BACKOFF = 30 * 60 * 1000;         // 命中限流后的平台静默期
  const AC_SYNC_IN_ROUND_RETRIES = 2;                 // 单条轮内限流重试次数
  const AC_SYNC_RETRY_BASE = 5 * 1000;                // 单条重试退避基数
  const AC_SYNC_RETRY_MAX = 40 * 1000;                // 单条重试退避上限
  const AC_SYNC_RETRY_JITTER = 2 * 1000;              // 单条重试退避抖动
  const AC_SYNC_ATTEMPT_CAP = 6;                      // 单条跨轮尝试上限（超过转毒丸）
  const AC_SYNC_SKIP_AFTER_POISON = 24 * 60 * 60 * 1000; // 毒丸后的定时跳过窗口
  const AC_SYNC_DRAIN_BATCH_STABLE = 60;              // 常规小批量排水条数
  const AC_SYNC_EXPORTED_CAP = 2000;                  // 已导出登记上限（防索引无限膨胀）

  // ---- 状态层：localStorage ac-sync-state = { dirName, enabled, platforms: {...} } ----
  function acSyncReadState() {
    const def = { dirName: '', enabled: false, platforms: {} };
    try {
      const raw = localStorage.getItem(AC_SYNC_STATE_KEY);
      if (!raw) return def;
      const obj = JSON.parse(raw);
      return {
        dirName: typeof obj.dirName === 'string' ? obj.dirName : '',
        enabled: !!obj.enabled,
        platforms: (obj.platforms && typeof obj.platforms === 'object') ? obj.platforms : {},
      };
    } catch (e) { return def; }
  }

  function acSyncWriteState(state) {
    try { localStorage.setItem(AC_SYNC_STATE_KEY, JSON.stringify(state)); } catch (e) { /* 静默 */ }
  }

  function acSyncPlatformStat(id) {
    const st = acSyncReadState();
    return st.platforms[id] || { lastRunAt: 0, lastExported: 0, lastError: null, failStreak: 0 };
  }

  function acSyncSetPlatformStat(id, patch) {
    const st = acSyncReadState();
    st.platforms[id] = Object.assign({ lastRunAt: 0, lastExported: 0, lastError: null, failStreak: 0 }, st.platforms[id], patch);
    acSyncWriteState(st);
  }

  // ---- 锚点层：ac-sync-anchor-<adapterId>（毫秒时间戳，语义与上游 m365-export-anchor 一致） ----
  function acSyncLoadAnchor(adapterId) {
    try {
      const n = Number(localStorage.getItem(AC_SYNC_ANCHOR_PREFIX + adapterId));
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch (e) { return null; }
  }

  function acSyncSaveAnchor(adapterId, ms) {
    try { localStorage.setItem(AC_SYNC_ANCHOR_PREFIX + adapterId, String(ms)); } catch (e) { /* 静默 */ }
  }

  // 首次启用时迁移旧锚点（只复制不删除，手动导出的 m365-export-anchor-* 不受影响）
  function acSyncMigrateAnchor(adapterId) {
    if (acSyncLoadAnchor(adapterId) !== null) return;
    try {
      const old = Number(localStorage.getItem('m365-export-anchor-' + adapterId));
      if (Number.isFinite(old) && old > 0) acSyncSaveAnchor(adapterId, old);
    } catch (e) { /* 静默 */ }
  }

  // ---- 句柄层：IndexedDB acSyncDb/handles，key='root' 存用户所选目录句柄 ----
  function acSyncOpenDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(AC_SYNC_DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(AC_SYNC_DB_STORE)) {
          req.result.createObjectStore(AC_SYNC_DB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function acSyncStoreHandle(handle) {
    const db = await acSyncOpenDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(AC_SYNC_DB_STORE, 'readwrite');
      tx.objectStore(AC_SYNC_DB_STORE).put(handle, AC_SYNC_ROOT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }

  async function acSyncGetHandle() {
    const db = await acSyncOpenDb();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction(AC_SYNC_DB_STORE, 'readonly');
      const req = tx.objectStore(AC_SYNC_DB_STORE).get(AC_SYNC_ROOT_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle;
  }

  // ---- 写盘：getFileHandle(create) → createWritable → write → close ----
  async function acSyncWriteFile(dirHandle, filename, content) {
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  function acSyncRunStamp(ms) {
    const d = new Date(ms);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  }

  // =============================================================
  //  持久化索引：<id>/_sync_index.json（崩溃可续传的队列/登记/毒丸）
  //  exportedConversations: id → 导出时的排序时间；exportOrder 维护插入序
  //  （数字样 id 在对象里按值序遍历，裁剪需按数组序）；pending* 为待办队列；
  //  poison 为毒丸（24h 定时跳过）；backoffUntil 为平台限流静默期
  //  =============================================================
  function acSyncNewIndex(platformId) {
    return {
      v: AC_SYNC_INDEX_VERSION,
      platform: platformId,
      exportedConversations: {},
      exportOrder: [],
      exportedFilenames: [],
      pendingConversationIds: [],
      pendingConversations: {},
      poison: {},
      backoffUntil: 0,
      recent429Count: 0,
      last429At: 0,
    };
  }

  function acSyncNormalizeIndex(raw, platformId) {
    const idx = acSyncNewIndex(platformId);
    if (!raw || typeof raw !== 'object') return idx;
    if (raw.exportedConversations && typeof raw.exportedConversations === 'object') {
      idx.exportedConversations = raw.exportedConversations;
    }
    if (Array.isArray(raw.exportOrder)) idx.exportOrder = raw.exportOrder.filter((s) => typeof s === 'string');
    if (Array.isArray(raw.exportedFilenames)) idx.exportedFilenames = raw.exportedFilenames.filter((s) => typeof s === 'string');
    if (Array.isArray(raw.pendingConversationIds)) idx.pendingConversationIds = raw.pendingConversationIds.filter((s) => typeof s === 'string' && s);
    if (raw.pendingConversations && typeof raw.pendingConversations === 'object') idx.pendingConversations = raw.pendingConversations;
    if (raw.poison && typeof raw.poison === 'object') idx.poison = raw.poison;
    const n = Number(raw.backoffUntil); if (Number.isFinite(n)) idx.backoffUntil = n;
    const r = Number(raw.recent429Count); if (Number.isFinite(r)) idx.recent429Count = Math.max(0, Math.floor(r));
    const l = Number(raw.last429At); if (Number.isFinite(l)) idx.last429At = l;
    return idx;
  }

  async function acSyncReadIndex(platformDir, platformId) {
    try {
      const fh = await platformDir.getFileHandle(AC_SYNC_INDEX_NAME, { create: false });
      const file = await fh.getFile();
      const obj = JSON.parse(await file.text());
      if (obj && obj.v === AC_SYNC_INDEX_VERSION) return acSyncNormalizeIndex(obj, platformId);
    } catch (e) { /* 不存在或损坏 → 重建（列表重拉自然补齐） */ }
    return acSyncNewIndex(platformId);
  }

  async function acSyncWriteIndex(platformDir, index) {
    await acSyncWriteFile(platformDir, AC_SYNC_INDEX_NAME, JSON.stringify(index, null, 2));
  }

  function acSyncRegisterExported(index, cid, t) {
    if (!(cid in index.exportedConversations)) index.exportOrder.push(cid);
    index.exportedConversations[cid] = t;
    if (index.exportOrder.length > AC_SYNC_EXPORTED_CAP) {
      const drop = index.exportOrder.splice(0, index.exportOrder.length - AC_SYNC_EXPORTED_CAP);
      for (const d of drop) delete index.exportedConversations[d];
    }
  }

  function acSyncPushFilename(index, filename) {
    index.exportedFilenames.push(filename);
    if (index.exportedFilenames.length > AC_SYNC_EXPORTED_CAP) {
      index.exportedFilenames.splice(0, index.exportedFilenames.length - AC_SYNC_EXPORTED_CAP);
    }
  }

  // 限流识别：适配器把 HTTP 状态码拼进错误文本（无独立 status/Retry-After 可读），
  // 只能按文本匹配；Retry-After 无法解析 → 退避走固定 30min
  function acSyncIsRateLimit(text) {
    if (!text) return false;
    const s = String(text);
    return /\b429\b/.test(s) || /too many requests/i.test(s);
  }

  function acSyncActivePoisonCount(index) {
    const now = Date.now();
    let n = 0;
    for (const p of Object.values(index.poison)) {
      if (p && Number(p.until) > now) n++;
    }
    return n;
  }

  // 毒丸失败标记：一条一文件落 _failed/（含 ID / 错误 / 尝试次数）
  async function acSyncWriteFailureMark(failedDir, usedFailNames, runAt, platformId, f) {
    const runTs = acSyncRunStamp(runAt);
    const lines = [
      `# 自动同步失败清单 ${runTs}`,
      '',
      `- 平台: ${platformId}`,
      `- 时间: ${formatLocalTime(new Date(runAt))}`,
      `- 已尝试: ${f.attempts} 次`,
      '',
      `## ${f.title}`,
      `- ID: \`${f.id}\``,
      `- 错误: ${f.error}`,
      `- 处理: 挂起 24h 后自动重试`,
      '',
    ];
    const base = `${runTs}-${sanitizeFilename(f.title, 80)}`;
    let failName = `${base}.md`;
    let n = 2;
    while (usedFailNames.has(failName)) { failName = `${base}-${n}.md`; n++; }
    usedFailNames.add(failName);
    try { await acSyncWriteFile(failedDir, failName, lines.join('\n')); }
    catch (e) { console.error('[AC-Sync] 写 _failed 失败:', e); }
  }

  // =============================================================
  //  导出器：对当前站点的一个 adapter 跑一轮增量同步（队列 + 续传）
  //  流程：锚点 → 列表（增量） → 入队索引 → 小批量逐条排水 → 详情
  //  → toMarkdown → 直写；每条处理后索引落盘，崩溃后从索引续传
  //  限流（错误文本含 429/Too Many Requests）→ 停轮 + 平台静默 30min；
  //  单条普通失败轮内指数退避重试，跨轮累计超限转毒丸（_failed/ + 24h 跳过）
  //  任何失败：锚点不前移；队列清空且无毒丸才推进
  //  =============================================================
  async function acSyncRunAdapter(adapter, rootHandle) {
    const id = adapter.id;
    const runAt = Date.now();
    const boundary = acSyncLoadAnchor(id);

    const platformDir = await rootHandle.getDirectoryHandle(id, { create: true });
    const index = await acSyncReadIndex(platformDir, id);

    // 平台限流静默期未到：本轮整轮跳过（队列保留，到期自动续）
    if (Number(index.backoffUntil) > Date.now()) {
      return { exported: 0, failed: 0, skipped: 'rate-limit-backoff' };
    }

    // ---- 列表阶段（只读）：增量拉取，差异并入待办队列 ----
    let conversations;
    try {
      conversations = await adapter.getAllConversations(null, { boundary });
    } catch (err) {
      const msg = String(err?.message || err);
      if (acSyncIsRateLimit(msg)) {
        index.recent429Count = (index.recent429Count || 0) + 1;
        index.last429At = Date.now();
        index.backoffUntil = Date.now() + AC_SYNC_429_BACKOFF;
        try { await acSyncWriteIndex(platformDir, index); } catch (e) { /* 静默 */ }
      }
      throw err;
    }
    if (!Array.isArray(conversations)) throw new Error('getAllConversations 返回异常');

    const now = Date.now();
    const pendingSet = new Set(index.pendingConversationIds);
    let maxSeenTime = 0;
    let queuedCount = 0;
    for (const c of conversations) {
      const t = getConversationSortTime(c);
      if (t !== null && t > maxSeenTime) maxSeenTime = t;
      const cid = String(c?.id ?? '');
      if (!cid) continue;
      const snap = index.pendingConversations[cid];
      if (pendingSet.has(cid)) {
        // 已在待办：只刷新标题/时间快照，重试计数保留（快照缺失则重建，不重复入队）
        index.pendingConversations[cid] = snap || { title: String(c.title || 'untitled'), t, attempts: 0, error: null };
        if (snap) {
          snap.title = String(c.title || snap.title || 'untitled');
          snap.t = t;
        }
        continue;
      }
      const poison = index.poison[cid];
      if (poison && Number(poison.until) > now) continue;            // 毒丸跳过期内
      const exportedT = index.exportedConversations[cid];
      if (typeof exportedT === 'number' && (t === null || t <= exportedT)) continue;
      if (poison) delete index.poison[cid];                          // 过期毒丸重新入队
      pendingSet.add(cid);
      index.pendingConversationIds.push(cid);
      index.pendingConversations[cid] = { title: String(c.title || 'untitled'), t, attempts: 0, error: null };
      queuedCount++;
    }
    if (queuedCount > 0) await acSyncWriteIndex(platformDir, index);

    // ---- 排水阶段：小批量逐条出队，每条处理后索引落盘（崩溃续传） ----
    const failedDir = await platformDir.getDirectoryHandle('_failed', { create: true });
    const usedNames = new Set(index.exportedFilenames);
    const usedFailNames = new Set();
    let exported = 0;
    let processed = 0;
    let poisonCount = 0;
    let stopFor429 = false;
    const batch = (index.pendingConversationIds.length <= 1 || (index.recent429Count || 0) > 0)
      ? 1
      : AC_SYNC_DRAIN_BATCH_STABLE;

    while (index.pendingConversationIds.length > 0 && processed < batch && !stopFor429) {
      const cid = index.pendingConversationIds[0];
      const snap = index.pendingConversations[cid] || { title: 'untitled', t: null, attempts: 0 };
      let ok = false;
      let newFilename = '';
      let lastMsg = '';
      let was429 = false;

      for (let attempt = 0; attempt <= AC_SYNC_IN_ROUND_RETRIES; attempt++) {
        try {
          const data = await adapter.getConversationDetails(cid);
          if (data?.empty === true) {
            ok = true;
            break;
          }
          if (data?.store) delete data.store.zeroQuery;
          const chatTitle = getChatTitle(data, snap.title || 'untitled');
          if (typeof adapter.toMarkdown !== 'function') throw new Error('适配器不支持 toMarkdown');
          const md = adapter.toMarkdown(data, chatTitle, cid);
          // 文件名沿用上游时间前缀规则；快照注入 t 保证跨批次前缀稳定，
          // exportedFilenames 登记 → 同秒同标题补 -2/-3 而非覆盖
          const conv = { id: cid, title: chatTitle, t: snap.t };
          const filename = makeMarkdownZipFilename(conv, 0, 1, usedNames);
          await acSyncWriteFile(platformDir, filename, md);
          ok = true;
          newFilename = filename;
          break;
        } catch (err) {
          lastMsg = String(err?.message || err);
          if (acSyncIsRateLimit(lastMsg)) { was429 = true; break; }  // 限流不轮内重试
          if (attempt < AC_SYNC_IN_ROUND_RETRIES) {
            await sleep(AC_SYNC_RETRY_BASE * Math.pow(2, attempt) + Math.floor(Math.random() * AC_SYNC_RETRY_JITTER));
          }
        }
      }

      if (ok) {
        index.pendingConversationIds.shift();
        delete index.pendingConversations[cid];
        acSyncRegisterExported(index, cid, snap.t === null ? runAt : snap.t);
        if (newFilename) acSyncPushFilename(index, newFilename);
        // 成功缓存一份限流压力（与 DC noteSuccess 同语义）
        index.recent429Count = Math.max(0, (index.recent429Count || 0) - 1);
        if (newFilename) exported++;
        processed++;
        await acSyncWriteIndex(platformDir, index);
      } else if (was429) {
        // 限流：条目留队头，本轮停止 + 平台静默 30min（不累计重试次数）
        index.recent429Count = (index.recent429Count || 0) + 1;
        index.last429At = Date.now();
        index.backoffUntil = Date.now() + AC_SYNC_429_BACKOFF;
        snap.error = lastMsg.substring(0, 300);
        index.pendingConversations[cid] = snap;
        stopFor429 = true;
        await acSyncWriteIndex(platformDir, index);
      } else {
        // 普通失败：累计尝试次数，移队尾继续下一条；超限转毒丸
        snap.attempts = (snap.attempts || 0) + 1;
        snap.error = lastMsg.substring(0, 300);
        index.pendingConversations[cid] = snap;
        index.pendingConversationIds.shift();
        processed++;
        if (snap.attempts >= AC_SYNC_ATTEMPT_CAP) {
          delete index.pendingConversations[cid];
          index.poison[cid] = { until: Date.now() + AC_SYNC_SKIP_AFTER_POISON, attempts: snap.attempts, error: snap.error };
          poisonCount++;
          await acSyncWriteFailureMark(failedDir, usedFailNames, runAt, id, {
            id: cid, title: snap.title || 'untitled', error: snap.error, attempts: snap.attempts,
          });
        } else {
          index.pendingConversationIds.push(cid);   // 队尾重排，下轮再试
        }
        await acSyncWriteIndex(platformDir, index);
      }
      if (!stopFor429 && index.pendingConversationIds.length > 0) await sleep(CONFIG.API_DELAY);
    }

    // ---- 收尾：欠账统计 + 锚点推进 ----
    const activePoison = acSyncActivePoisonCount(index);
    const hasDebt = index.pendingConversationIds.length > 0 || stopFor429 || activePoison > 0;
    if (hasDebt) {
      const errParts = [];
      if (stopFor429) errParts.push('站点限流(429):30min 后自动重试');
      if (activePoison > 0) errParts.push(`${activePoison} 条多次失败已挂起(24h 后重试)`);
      const pendingN = index.pendingConversationIds.length;
      if (pendingN > 0 && !stopFor429) errParts.push(`${pendingN} 条待重试`);
      acSyncSetPlatformStat(id, {
        lastRunAt: runAt,
        lastExported: exported,
        lastError: errParts.join(' | ').substring(0, 300),
        failStreak: acSyncPlatformStat(id).failStreak + 1,
      });
      return { exported, failed: poisonCount + (stopFor429 ? 1 : 0), pending: pendingN };
    }

    // 全部落定：锚点前移到 max(本次运行时刻, 本轮见到的最大排序时间)
    acSyncSaveAnchor(id, Math.max(runAt, maxSeenTime));
    acSyncSetPlatformStat(id, { lastRunAt: runAt, lastExported: exported, lastError: null, failStreak: 0 });
    return { exported, failed: 0 };
  }

  // =============================================================
  //  调度器：启动 15s / 每 10min / 回前台(60s 防抖)；hidden 跳过；单飞锁；
  //  failStreak≥2 → 间隔翻倍（上限 60min），成功清零
  //  =============================================================
  let acSyncRunning = false;
  let acSyncNeedsAuth = false;      // 根目录句柄存在但 readwrite 权限未授予
  let acSyncTimer = null;
  let acSyncLastVisibleRun = 0;

  function acSyncCurrentAdapter() {
    // 只同步“当前页面可识别且在开关名单内”的平台；其余平台到各自站点自然生效
    return PLATFORM_ADAPTERS.find((p) => AC_SYNC_PLATFORMS.includes(p.id) && typeof p.detect === 'function' && p.detect()) || null;
  }

  function acSyncNextDelay() {
    // 取各平台最大 failStreak 计算退避：10min × 2^(streak-1)，上限 60min
    const st = acSyncReadState();
    let streak = 0;
    for (const id of AC_SYNC_PLATFORMS) {
      streak = Math.max(streak, Number(st.platforms[id]?.failStreak) || 0);
    }
    if (streak >= 2) {
      return Math.min(AC_SYNC_BASE_INTERVAL * Math.pow(2, streak - 1), AC_SYNC_MAX_BACKOFF);
    }
    return AC_SYNC_BASE_INTERVAL;
  }

  async function acSyncRun(source) {
    const state = acSyncReadState();
    if (!state.enabled) return { skipped: 'disabled' };
    if (acSyncRunning) return { skipped: 'busy' };
    if (document.hidden && source !== 'manual') return { skipped: 'hidden' };

    acSyncRunning = true;
    try {
      const rootHandle = await acSyncGetHandle();
      if (!rootHandle) { acSyncNeedsAuth = true; acSyncRefreshPanel(); return { skipped: 'no-handle' }; }

      // 权限检查：未授予则静默标记待授权，不自动弹窗（浏览器要求手势）
      let perm = 'granted';
      try { perm = await rootHandle.queryPermission({ mode: 'readwrite' }); } catch (e) { perm = 'denied'; }
      if (perm !== 'granted') {
        acSyncNeedsAuth = true;
        acSyncRefreshPanel();
        return { skipped: 'needs-auth' };
      }
      acSyncNeedsAuth = false;

      const adapter = acSyncCurrentAdapter();
      if (!adapter) return { skipped: 'no-adapter' };

      const result = await acSyncRunAdapter(adapter, rootHandle);
      acSyncRefreshPanel();
      return result;
    } catch (err) {
      console.error('[AC-Sync] 本轮同步失败:', err);
      const adapter = acSyncCurrentAdapter();
      if (adapter) {
        acSyncSetPlatformStat(adapter.id, {
          lastRunAt: Date.now(),
          lastError: String(err?.message || err).substring(0, 300),
          failStreak: acSyncPlatformStat(adapter.id).failStreak + 1,
        });
      }
      acSyncRefreshPanel();
      return { error: String(err?.message || err) };
    } finally {
      acSyncRunning = false;
    }
  }

  function acSyncScheduleNext(delayMs) {
    clearTimeout(acSyncTimer);
    acSyncTimer = setTimeout(() => {
      Promise.resolve(acSyncRun('timer')).catch(() => {}).finally(() => acSyncScheduleNext(acSyncNextDelay()));
    }, delayMs);
  }

  function acSyncStartScheduler() {
    clearTimeout(acSyncTimer);
    acSyncTimer = setTimeout(() => {
      Promise.resolve(acSyncRun('boot')).catch(() => {}).finally(() => acSyncScheduleNext(acSyncNextDelay()));
    }, AC_SYNC_BOOT_DELAY);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - acSyncLastVisibleRun < AC_SYNC_VISIBLE_DEBOUNCE) return;   // 60s 防抖
    acSyncLastVisibleRun = now;
    Promise.resolve(acSyncRun('visible')).catch(() => {});
  });

  // =============================================================
  //  启用 / 关闭 / 选择 / 更换目录（showDirectoryPicker 只在用户点击回调里调用）
  //  目录句柄按站点隔离（IndexedDB acSyncDb）：同站点启用可复用免重选；
  //  跨站点浏览器不允许传递句柄，各站点需各选一次（选择器 id 记住上次位置）
  //  =============================================================
  async function acSyncPickDirectory() {
    if (typeof window.showDirectoryPicker !== 'function') {
      throw new Error('当前浏览器不支持文件系统目录访问（需 Chrome/Edge 122+）');
    }
    // 用户手势内弹出目录选择器；稳定 id 让浏览器记住上次所选目录，下次默认停在原目录
    const handle = await window.showDirectoryPicker({ id: AC_SYNC_PICKER_ID, mode: 'readwrite', startIn: 'documents' });
    const granted = await handle.requestPermission({ mode: 'readwrite' });
    if (granted !== 'granted') throw new Error('未获得目录读写权限');
    return handle;
  }

  async function acSyncEnableSync(handle) {
    const root = handle || await acSyncPickDirectory();

    // 为每个启用平台建 <id>\ 与 <id>\_failed\ 子目录
    for (const id of AC_SYNC_PLATFORMS) {
      const platformDir = await root.getDirectoryHandle(id, { create: true });
      await platformDir.getDirectoryHandle('_failed', { create: true });
      acSyncMigrateAnchor(id);   // 首次启用：迁移旧 m365-export-anchor（新 key 已存在则跳过）
    }

    await acSyncStoreHandle(root);
    const st = acSyncReadState();
    st.dirName = root.name || '';
    st.enabled = true;
    acSyncWriteState(st);
    acSyncNeedsAuth = false;
    acSyncStartScheduler();    // 重新计时（立即按 15s 后首跑）
    acSyncRefreshPanel();
    return st;
  }

  function acSyncDisableSync() {
    const st = acSyncReadState();
    st.enabled = false;
    acSyncWriteState(st);
    clearTimeout(acSyncTimer);   // 停调度，句柄与锚点保留（重开不重导）
    acSyncRefreshPanel();
  }

  // “选择目录”：优先复用本站点已存句柄（不再弹选择器）；无存档/授权或复用失败才弹出选择器
  async function acSyncSelectDirectory() {
    const saved = await acSyncGetHandle().catch(() => null);
    if (saved) {
      try {
        let perm = 'prompt';
        try { perm = await saved.queryPermission({ mode: 'readwrite' }); } catch (e) { perm = 'denied'; }
        if (perm !== 'granted') perm = await saved.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          try { return await acSyncEnableSync(saved); } catch (e) { /* 句柄失效（目录被删/移动）→ 重新选择 */ }
        }
      } catch (e) { /* 授权失败 → 重新选择 */ }
    }
    return acSyncEnableSync();
  }

  // “更换目录”：总是弹出选择器重选；锚点保留，同名覆盖幂等
  async function acSyncChangeDirectory() {
    const handle = await acSyncPickDirectory();
    return acSyncEnableSync(handle);
  }

  // “重置起点(重导)”：删新锚点 + 清持久化索引 + 清 _failed（repair 语义），下一轮按新起点重拉
  async function acSyncResetAnchor(adapterId) {
    try { localStorage.removeItem(AC_SYNC_ANCHOR_PREFIX + adapterId); } catch (e) { /* 静默 */ }
    acSyncSetPlatformStat(adapterId, { lastError: null, failStreak: 0 });
    try {
      const rootHandle = await acSyncGetHandle();
      if (!rootHandle) return;
      if ((await rootHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') return;
      const platformDir = await rootHandle.getDirectoryHandle(adapterId, { create: false }).catch(() => null);
      if (!platformDir) return;
      // 索引一并删除：待办队列/已导出登记/毒丸全部作废，避免旧登记挡住重导
      try { await platformDir.removeEntry(AC_SYNC_INDEX_NAME); } catch (e) { /* 不存在即忽略 */ }
      const failedDir = await platformDir.getDirectoryHandle('_failed', { create: false }).catch(() => null);
      if (!failedDir) return;
      for await (const [name] of failedDir.entries()) {
        await failedDir.removeEntry(name).catch(() => {});
      }
    } catch (e) { /* 清理失败不影响重导 */ }
    acSyncRefreshPanel();
  }

  // =============================================================
  //  UI：挂在现有浮泡上（不新建常驻控件，不改 btn.onclick / oncontextmenu）
  //  在容器左侧加一枚同风格小按钮，点击弹出状态行 + 菜单面板
  //  =============================================================
  let acSyncPanelEl = null;
  let acSyncStatusEl = null;
  let acSyncMenuBtn = null;

  function acSyncFormatTime(ms) {
    if (!ms) return '从未';
    const d = new Date(ms);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  }

  function acSyncBuildPanel(adapter) {
    const st = acSyncReadState();
    const stat = st.platforms[adapter.id] || {};
    const anchor = acSyncLoadAnchor(adapter.id);

    acSyncStatusEl.textContent = '';
    const line1 = document.createElement('div');
    if (!st.enabled) {
      line1.textContent = st.dirName ? '自动同步: 关（开启时直接复用目录）' : '自动同步: 关';
      line1.style.color = '#888888';
    } else if (!st.dirName) {
      line1.textContent = '自动同步: 未选目录';
      line1.style.color = '#8a6d00';
    } else if (acSyncNeedsAuth) {
      line1.textContent = '自动同步: 待授权（点「立即同步」授权）';
      line1.style.color = '#8a6d00';
    } else if (stat.lastError) {
      line1.textContent = `自动同步: 出错 · ${acSyncFormatTime(stat.lastRunAt)} 导出 ${stat.lastExported || 0} 条`;
      line1.style.color = '#c0392b';
      line1.title = stat.lastError;
    } else {
      line1.textContent = `自动同步: 开 · 上次 ${acSyncFormatTime(stat.lastRunAt)} 导出 ${stat.lastExported || 0} 条`;
      line1.style.color = '#242424';
    }
    acSyncStatusEl.appendChild(line1);

    const line2 = document.createElement('div');
    line2.style.cssText = 'color:#888888;font-size:11px;margin-top:2px;';
    line2.textContent = anchor
      ? `起点: ${fmtStartStamp(anchor)} · 目录: ${st.dirName || '—'}`
      : `起点: 全部 · 目录: ${st.dirName || '—'}`;
    acSyncStatusEl.appendChild(line2);

    // 菜单项文案随开关状态切换
    const toggleItem = acSyncPanelEl.querySelector('[data-ac-sync-role="toggle"]');
    if (toggleItem) toggleItem.textContent = st.enabled ? '关闭自动同步' : '开启自动同步';
  }

  function acSyncRefreshPanel() {
    if (!acSyncPanelEl || acSyncPanelEl.style.display === 'none') return;
    const adapter = acSyncCurrentAdapter();
    if (!adapter) return;
    acSyncBuildPanel(adapter);
  }

  function installSyncUI(adapter) {
    const container = document.getElementById('m365-export-container');
    if (!container || container.dataset.acSyncInstalled) return;
    container.dataset.acSyncInstalled = '1';

    // ---- 面板：样式复用 tooltip 的白底圆角阴影语言，挂在容器左上方 ----
    acSyncPanelEl = document.createElement('div');
    acSyncPanelEl.style.cssText = `
      position: absolute; bottom: calc(100% + 10px); right: 44px;
      background: #ffffff; color: #242424;
      border: 1px solid #e8e8e8;
      padding: 10px 12px; border-radius: 7px;
      font-size: 12px; white-space: nowrap;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      display: none;
    `;

    acSyncStatusEl = document.createElement('div');
    acSyncStatusEl.style.cssText = 'margin-bottom: 6px;';
    acSyncPanelEl.appendChild(acSyncStatusEl);

    const mkItem = (label, role) => {
      const item = document.createElement('div');
      item.textContent = label;
      item.dataset.acSyncRole = role;
      item.style.cssText = `
        padding: 4px 6px; margin: 0 -6px; border-radius: 5px;
        cursor: pointer; color: #242424;
      `;
      item.addEventListener('mouseenter', () => { item.style.background = '#f2f2f2'; });
      item.addEventListener('mouseleave', () => { item.style.background = ''; });
      return item;
    };

    // 开启/关闭：开启时优先复用已选目录（不弹选择器）；无存档才在用户手势内弹 showDirectoryPicker
    const toggleItem = mkItem('开启自动同步', 'toggle');
    toggleItem.addEventListener('click', async () => {
      const st = acSyncReadState();
      try {
        if (st.enabled) { acSyncDisableSync(); }
        else { await acSyncSelectDirectory(); }
      } catch (err) {
        if (err?.name !== 'AbortError') console.error('[AC-Sync] 切换自动同步失败:', err);
      }
      acSyncBuildPanel(adapter);
    });
    acSyncPanelEl.appendChild(toggleItem);

    // 立即同步：待授权时在此点击回调里 requestPermission（浏览器手势要求）
    const runItem = mkItem('立即同步', 'run');
    runItem.addEventListener('click', async () => {
      try {
        const st = acSyncReadState();
        if (st.enabled) {
          const rootHandle = await acSyncGetHandle();
          if (rootHandle && (await rootHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
            const granted = await rootHandle.requestPermission({ mode: 'readwrite' });
            acSyncNeedsAuth = granted !== 'granted';
            if (granted !== 'granted') { acSyncBuildPanel(adapter); return; }
          }
          await acSyncRun('manual');
        }
      } catch (err) {
        if (err?.name !== 'AbortError') console.error('[AC-Sync] 手动同步失败:', err);
      }
      acSyncBuildPanel(adapter);
    });
    acSyncPanelEl.appendChild(runItem);

    // 重置起点(重导)：删锚点 + 清索引 + 清 _failed，下轮自动重拉
    const resetItem = mkItem('重置起点(重导)', 'reset');
    resetItem.addEventListener('click', async () => {
      try { await acSyncResetAnchor(adapter.id); } catch (err) { console.error('[AC-Sync] 重置起点失败:', err); }
      acSyncBuildPanel(adapter);
    });
    acSyncPanelEl.appendChild(resetItem);

    // 选择目录：复用已存句柄直接启用（不弹选择器）；无存档/复用失败才弹
    const selectItem = mkItem('选择目录', 'select');
    selectItem.addEventListener('click', async () => {
      try { await acSyncSelectDirectory(); }
      catch (err) {
        if (err?.name !== 'AbortError') console.error('[AC-Sync] 选择目录失败:', err);
      }
      acSyncBuildPanel(adapter);
    });
    acSyncPanelEl.appendChild(selectItem);

    // 更换目录：总是弹选择器重选后重绑句柄，锚点保留
    const rebindItem = mkItem('更换目录', 'rebind');
    rebindItem.addEventListener('click', async () => {
      try { await acSyncChangeDirectory(); }
      catch (err) {
        if (err?.name !== 'AbortError') console.error('[AC-Sync] 更换目录失败:', err);
      }
      acSyncBuildPanel(adapter);
    });
    acSyncPanelEl.appendChild(rebindItem);

    // 面板 hover 期间不消失
    let panelHover = false;
    acSyncPanelEl.addEventListener('mouseenter', () => { panelHover = true; });
    acSyncPanelEl.addEventListener('mouseleave', () => {
      panelHover = false;
      if (acSyncPanelEl) acSyncPanelEl.style.display = 'none';
    });

    // ---- 小按钮：与主按钮同风格，绝对定位在主按钮左侧，不影响既有布局/事件 ----
    acSyncMenuBtn = document.createElement('button');
    acSyncMenuBtn.id = 'm365-ac-sync-btn';
    acSyncMenuBtn.title = '自动同步：把当前站点对话增量写入所选目录（可自选）';
    acSyncMenuBtn.style.cssText = `
      position: absolute; right: 44px; bottom: 0;
      width: 28px; height: 28px; border-radius: 50%;
      background: #ffffff; border: 1px solid #e0e0e0;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
      color: #242424; font-size: 13px; line-height: 1;
      padding: 0;
    `;
    acSyncMenuBtn.textContent = '⇅';
    acSyncMenuBtn.addEventListener('mouseenter', () => { acSyncMenuBtn.style.background = '#f5f5f5'; });
    acSyncMenuBtn.addEventListener('mouseleave', () => {
      acSyncMenuBtn.style.background = '#ffffff';
      if (!panelHover && acSyncPanelEl.style.display === 'block') {
        setTimeout(() => { if (!panelHover) acSyncPanelEl.style.display = 'none'; }, 300);
      }
    });
    acSyncMenuBtn.addEventListener('click', () => {
      const show = acSyncPanelEl.style.display !== 'block';
      acSyncPanelEl.style.display = show ? 'block' : 'none';
      if (show) acSyncBuildPanel(adapter);
    });

    container.appendChild(acSyncPanelEl);
    container.appendChild(acSyncMenuBtn);
  }

  // ---- 包一层 createUI：原行为原样执行，UI 建好后追加同步控件（不改任何既有事件） ----
  const __acSyncOrigCreateUI = createUI;
  createUI = function (adapter) {
    __acSyncOrigCreateUI(adapter);
    try { installSyncUI(adapter); } catch (e) { console.error('[AC-Sync] 同步 UI 挂载失败:', e); }
  };

  // ---- 诊断入口：window.__AC_SYNC__ = { state(), runNow(id), resetAnchor(id) } ----
  window.__AC_SYNC__ = {
    /** 当前状态快照（含各平台统计与待授权标记） */
    state() {
      const st = acSyncReadState();
      return {
        ...st,
        needsAuth: acSyncNeedsAuth,
        running: acSyncRunning,
        enabledPlatforms: [...AC_SYNC_PLATFORMS],
        currentAdapter: acSyncCurrentAdapter()?.id || null,
        anchors: Object.fromEntries(AC_SYNC_PLATFORMS.map((id) => [id, acSyncLoadAnchor(id)])),
      };
    },
    /** 手动跑一轮（id 仅作诊断提示，实际同步当前站点 adapter）；权限不足时静默标记待授权 */
    async runNow(id) {
      if (id) console.log(`[AC-Sync] runNow(${id})：实际同步当前站点 adapter`);
      const r = await acSyncRun('manual');
      console.log('[AC-Sync] runNow 结果:', r);
      return r;
    },
    /** 重置某平台锚点并清索引/_failed（repair 语义） */
    async resetAnchor(id) {
      const target = id || acSyncCurrentAdapter()?.id;
      if (!target) return { error: '未指定 adapterId' };
      await acSyncResetAnchor(target);
      return { ok: true, adapterId: target };
    },
    /** 选择目录：优先复用已存句柄直接启用；无存档/复用失败才弹选择器（需用户手势） */
    async selectDirectory() {
      const r = await acSyncSelectDirectory();
      console.log('[AC-Sync] selectDirectory 结果:', r);
      return r;
    },
  };

  // ---- 启动调度（enabled 才会真正跑；未启用时 acSyncRun 直接跳过） ----
  acSyncStartScheduler();

  // =============================================================
  //  AC-SYNC 模块结束
  //  =============================================================

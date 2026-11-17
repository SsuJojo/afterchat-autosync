  // =============================================================
  //  🔄 AC-SYNC — 自动增量同步模块（本地修改版，非上游功能）
  //  SPDX-License-Identifier: AGPL-3.0
  //  本块为 AfterChat 的 local modification（注入于 initialize() 之前）：
  //  复用闭包内 PLATFORM_ADAPTERS / getConversationSortTime / makeMarkdownZipFilename
  //  等内部件，把“上次同步之后”的新对话经 FSA 目录句柄直写本地 _sync 目录，
  //  不产生下载文件、不进 Downloads。
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
  const AC_SYNC_ROOT_KEY = 'root';                    // 根目录句柄（用户所选目录，如 C:\Users\SsuJo_\Chats\_sync）
  const AC_SYNC_BOOT_DELAY = 15 * 1000;               // 启动后 15s 跑第一轮
  const AC_SYNC_BASE_INTERVAL = 10 * 60 * 1000;       // 常规间隔 10min
  const AC_SYNC_MAX_BACKOFF = 60 * 60 * 1000;         // 连续失败退避上限 60min
  const AC_SYNC_VISIBLE_DEBOUNCE = 60 * 1000;         // 回前台触发防抖 60s

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
  //  导出器：对当前站点的一个 adapter 跑一轮增量同步
  //  流程：锚点 → getAllConversations({boundary}) → 过滤 → 详情 → toMarkdown → 直写
  //  任何失败：写 _failed/ + 记 lastError + 锚点不前移；零失败才推进锚点
  //  =============================================================
  async function acSyncRunAdapter(adapter, rootHandle) {
    const id = adapter.id;
    const runAt = Date.now();
    const boundary = acSyncLoadAnchor(id);

    // 只读拉取：沿用上游增量语义（boundary 早停翻页），onProgress 不需要
    const conversations = await adapter.getAllConversations(null, { boundary });
    if (!Array.isArray(conversations)) throw new Error('getAllConversations 返回异常');

    let freshList = conversations;
    if (boundary !== null) {
      // 拿不到时间的会话保守处理：宁重复不漏，始终导出（与上游一致）
      freshList = conversations.filter((c) => {
        const t = getConversationSortTime(c);
        return t === null || t > boundary;
      });
    }

    if (freshList.length === 0) {
      // 无新内容：锚点可安全推进到本次运行时刻（上游同款逻辑）
      acSyncSaveAnchor(id, Math.max(runAt, boundary || 0));
      acSyncSetPlatformStat(id, { lastRunAt: runAt, lastExported: 0, lastError: null, failStreak: 0 });
      return { exported: 0, failed: 0 };
    }

    const limitedList = (CONFIG.DEBUG_LIMIT > 0 && freshList.length > CONFIG.DEBUG_LIMIT)
      ? freshList.slice(0, CONFIG.DEBUG_LIMIT)
      : freshList;
    const total = limitedList.length;
    const usedNames = new Set();
    const failures = [];
    let exported = 0;
    let maxConvTime = 0;

    const platformDir = await rootHandle.getDirectoryHandle(id, { create: true });
    const failedDir = await platformDir.getDirectoryHandle('_failed', { create: true });
    const usedFailNames = new Set();

    for (let i = 0; i < total; i++) {
      const conv = limitedList[i];
      try {
        const data = await adapter.getConversationDetails(conv.id);
        if (data?.store) delete data.store.zeroQuery;
        const chatTitle = getChatTitle(data, conv.title || conv.id || 'untitled');
        if (typeof adapter.toMarkdown !== 'function') throw new Error('适配器不支持 toMarkdown');
        const md = adapter.toMarkdown(data, chatTitle, conv.id);
        // 文件名沿用上游时间前缀规则：会话更新重导仍同名 → 覆盖即更新，天然幂等
        const filename = makeMarkdownZipFilename({ ...conv, title: chatTitle }, i, total, usedNames);
        await acSyncWriteFile(platformDir, filename, md);
        exported++;
        const t = getConversationSortTime(conv);
        if (t !== null && t > maxConvTime) maxConvTime = t;
      } catch (err) {
        console.error(`[AC-Sync] 导出对话 ${conv.id} 失败:`, err);
        failures.push({
          title: conv.title || 'untitled',
          id: conv.id,
          error: err?.message || String(err),
        });
      }
      // 限速：沿用上游 CONFIG.API_DELAY，不给站点加压
      if (i < total - 1) await sleep(CONFIG.API_DELAY);
    }

    if (failures.length > 0) {
      // 失败清单落 _failed/（含 ID 与错误），主流程继续；锚点绝不前移 → 下轮自动补齐
      const runTs = acSyncRunStamp(runAt);
      const failLines = [`# 自动同步失败清单 ${runTs}`, '', `- 平台: ${id}`, `- 时间: ${formatLocalTime(new Date(runAt))}`, ''];
      for (const f of failures) {
        failLines.push(`## ${f.title}`);
        failLines.push(`- ID: \`${f.id}\``);
        failLines.push(`- 错误: ${f.error}`);
        failLines.push(`- 时间: ${formatLocalTime(new Date(runAt))}`);
        failLines.push('');
        let failName = `${runTs}-${sanitizeFilename(f.title, 80)}.md`;
        let n = 2;
        while (usedFailNames.has(failName)) { failName = `${runTs}-${sanitizeFilename(f.title, 80)}-${n}.md`; n++; }
        usedFailNames.add(failName);
        try { await acSyncWriteFile(failedDir, failName, failLines.join('\n')); }
        catch (e) { console.error('[AC-Sync] 写 _failed 失败:', e); }
      }
      acSyncSetPlatformStat(id, {
        lastRunAt: runAt,
        lastExported: exported,
        lastError: failures.map((f) => `${f.title}: ${f.error}`).join(' | ').substring(0, 300),
        failStreak: acSyncPlatformStat(id).failStreak + 1,
      });
      return { exported, failed: failures.length };
    }

    // 全部成功：锚点前移到 max(本次运行时刻, 新会话最大排序时间)
    acSyncSaveAnchor(id, Math.max(runAt, maxConvTime));
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
  //  启用 / 关闭 / 更换目录（showDirectoryPicker 只在用户点击回调里调用）
  //  =============================================================
  async function acSyncEnableSync() {
    if (typeof window.showDirectoryPicker !== 'function') {
      throw new Error('当前浏览器不支持文件系统目录访问（需 Chrome/Edge 122+）');
    }
    // 用户手势内弹出目录选择器；提示文案只建议 _sync 目录，不硬编码为写入路径
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'documents' });
    const granted = await handle.requestPermission({ mode: 'readwrite' });
    if (granted !== 'granted') throw new Error('未获得目录读写权限');

    // 为每个启用平台建 <id>\ 与 <id>\_failed\ 子目录
    for (const id of AC_SYNC_PLATFORMS) {
      const platformDir = await handle.getDirectoryHandle(id, { create: true });
      await platformDir.getDirectoryHandle('_failed', { create: true });
      acSyncMigrateAnchor(id);   // 首次启用：迁移旧 m365-export-anchor（新 key 已存在则跳过）
    }

    await acSyncStoreHandle(handle);
    const st = acSyncReadState();
    st.dirName = handle.name || '';
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

  async function acSyncChangeDirectory() {
    const st = await acSyncEnableSync();   // 重选目录后重绑句柄；锚点保留，同名覆盖幂等
    return st;
  }

  // “重置起点(重导)”：删新锚点 + 清 _failed（repair 语义），下一轮按新起点重拉
  async function acSyncResetAnchor(adapterId) {
    try { localStorage.removeItem(AC_SYNC_ANCHOR_PREFIX + adapterId); } catch (e) { /* 静默 */ }
    acSyncSetPlatformStat(adapterId, { lastError: null, failStreak: 0 });
    try {
      const rootHandle = await acSyncGetHandle();
      if (!rootHandle) return;
      if ((await rootHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') return;
      const platformDir = await rootHandle.getDirectoryHandle(adapterId, { create: false }).catch(() => null);
      if (!platformDir) return;
      const failedDir = await platformDir.getDirectoryHandle('_failed', { create: false }).catch(() => null);
      if (!failedDir) return;
      for await (const [name] of failedDir.entries()) {
        await failedDir.removeEntry(name).catch(() => {});
      }
    } catch (e) { /* _failed 清理失败不影响重导 */ }
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
      line1.textContent = '自动同步: 关';
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

    // 开启/关闭：开启流程内含 showDirectoryPicker + requestPermission（均为用户手势内）
    const toggleItem = mkItem('开启自动同步', 'toggle');
    toggleItem.addEventListener('click', async () => {
      const st = acSyncReadState();
      try {
        if (st.enabled) { acSyncDisableSync(); }
        else { await acSyncEnableSync(); }
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

    // 重置起点(重导)：删锚点 + 清 _failed，下轮自动重拉
    const resetItem = mkItem('重置起点(重导)', 'reset');
    resetItem.addEventListener('click', async () => {
      try { await acSyncResetAnchor(adapter.id); } catch (err) { console.error('[AC-Sync] 重置起点失败:', err); }
      acSyncBuildPanel(adapter);
    });
    acSyncPanelEl.appendChild(resetItem);

    // 更换目录：重选后重绑句柄，锚点保留
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
    /** 重置某平台锚点并清 _failed（repair 语义） */
    async resetAnchor(id) {
      const target = id || acSyncCurrentAdapter()?.id;
      if (!target) return { error: '未指定 adapterId' };
      await acSyncResetAnchor(target);
      return { ok: true, adapterId: target };
    },
  };

  // ---- 启动调度（enabled 才会真正跑；未启用时 acSyncRun 直接跳过） ----
  acSyncStartScheduler();

  // =============================================================
  //  AC-SYNC 模块结束
  //  =============================================================

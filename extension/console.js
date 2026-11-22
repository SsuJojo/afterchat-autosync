/*
 * console.js — extension popup
 * Picks the sync root once (written directly to the same IndexedDB store the
 * service worker uses) and displays a read-only console of synced chats.
 */
'use strict';

var DB_NAME = 'acSyncExtDb';
var STORE = 'handles';
var ROOT_KEY = 'root';
var DB_VERSION = 1;

var $rootName = document.getElementById('rootName');
var $pickBtn = document.getElementById('pickBtn');
var $chatsBody = document.getElementById('chatsBody');
var $chatsEmpty = document.getElementById('chatsEmpty');
var $platforms = document.getElementById('platforms');
var $status = document.getElementById('status');
var $detail = document.getElementById('detail');
var $detailTitle = document.getElementById('detailTitle');
var $detailBody = document.getElementById('detailBody');
var $detailClose = document.getElementById('detailClose');

/* ------------------------------------------------------------------ */
/* IndexedDB — same database/store as background.js                    */
/* ------------------------------------------------------------------ */

function openDb() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error || new Error('无法打开 IndexedDB')); };
    req.onblocked = function () { reject(new Error('IndexedDB 被其他标签页阻塞')); };
  });
}

async function saveRootDirect(handle) {
  var db = await openDb();
  try {
    return await new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, ROOT_KEY);
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { reject(tx.error || new Error('保存目录失败')); };
      tx.onabort = function () { reject(tx.error || new Error('保存目录已中止')); };
    });
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ */
/* Background messaging                                                */
/* ------------------------------------------------------------------ */

function sendOp(op, args) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage({ __acSyncExt: true, op: op, args: args || {} }, function (res) {
      var lastError = chrome.runtime.lastError;
      if (lastError) return reject(new Error(lastError.message || String(lastError)));
      if (res && res.__error) return reject(new Error(String(res.__error)));
      resolve(res);
    });
  });
}

function broadcastRootChanged() {
  chrome.tabs.query({}, function (tabs) {
    (tabs || []).forEach(function (t) {
      if (!t.id) return;
      try {
        var p = chrome.tabs.sendMessage(t.id, { type: 'acSyncRootChanged' });
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) {
        /* tab may not have a content script — ignore */
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, className, text) {
  var n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function pendingCount(pending) {
  if (Array.isArray(pending)) return pending.length;
  if (typeof pending === 'number') return pending;
  if (pending && typeof pending === 'object') {
    if (Array.isArray(pending.items)) return pending.items.length;
    return Object.keys(pending).length;
  }
  return 0;
}

function renderChats(chats) {
  clear($chatsBody);
  $chatsEmpty.style.display = chats.length ? 'none' : 'block';
  chats.forEach(function (c) {
    var tr = document.createElement('tr');
    tr.appendChild(el('td', 'col-platform', c.platform));
    tr.appendChild(el('td', 'col-when', c.when || '—'));
    var titleTd = el('td', '', c.title || c.name);
    titleTd.title = c.name || '';
    tr.appendChild(titleTd);
    tr.style.cursor = 'pointer';
    tr.title = '点击查看对话内容';
    tr.addEventListener('click', function () { showDetail(c); });
    $chatsBody.appendChild(tr);
  });
}

function renderPlatforms(chats) {
  clear($platforms);
  var groups = new Map();
  chats.forEach(function (c) {
    var g = groups.get(c.platform);
    if (!g) {
      g = { count: 0, pending: 0 };
      groups.set(c.platform, g);
    }
    g.count += 1;
    g.pending = Math.max(g.pending, pendingCount(c.index && c.index.pending));
  });

  if (!groups.size) {
    $platforms.appendChild(el('div', 'empty', '暂无平台数据'));
    return;
  }

  Array.from(groups.entries()).forEach(function (pair) {
    var row = el('div', 'platform-row');
    row.appendChild(el('span', '', pair[0]));
    row.appendChild(el('span', 'counts',
      '文件 ' + pair[1].count + ' · 待处理 ' + pair[1].pending));
    $platforms.appendChild(row);
  });
}

function setStatus(text) {
  $status.textContent = text || '';
}

/* ------------------------------------------------------------------ */
/* Chat detail                                                        */
/* ------------------------------------------------------------------ */

async function showDetail(chat) {
  $detailTitle.textContent = (chat.platform || '') + ' · ' + (chat.title || chat.name || '聊天详情');
  $detailBody.textContent = '读取中…';
  $detail.classList.remove('hidden');
  try {
    var text = await sendOp('getFileText', { path: [chat.platform], name: chat.name });
    var lines = String(text || '').split(/\r?\n/);
    if (lines.length > 200) lines = lines.slice(0, 200);
    $detailBody.textContent = lines.join('\n') + (lines.length === 200 ? '\n\n…（仅显示前 200 行）' : '');
  } catch (e) {
    $detailBody.textContent = '读取失败：' + String((e && e.message) || e);
  }
}

function closeDetail() {
  $detail.classList.add('hidden');
  $detailBody.textContent = '';
}

$detailClose.addEventListener('click', closeDetail);
$detail.addEventListener('click', function (e) { if (e.target === $detail) closeDetail(); });

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

async function refresh() {
  try {
    var root = await sendOp('getRoot');
    $rootName.textContent = root && root.name ? root.name : '未选择目录';

    var chats = await sendOp('listChats');
    if (!Array.isArray(chats)) chats = [];
    renderChats(chats);
    renderPlatforms(chats);
  } catch (e) {
    setStatus('刷新失败：' + String((e && e.message) || e));
  }
}

async function pickDirectory() {
  $pickBtn.disabled = true;
  setStatus('');
  try {
    if (typeof window.showDirectoryPicker !== 'function') {
      throw new Error('当前浏览器不支持目录选择器，请使用 Edge / Chrome。');
    }
    var handle = await window.showDirectoryPicker({
      id: 'ac-sync-root',
      mode: 'readwrite',
      startIn: 'documents'
    });
    try {
      await handle.requestPermission({ mode: 'readwrite' });
    } catch (e) {
      setStatus('权限请求被跳过，写入时可能需要重新授权。');
    }

    // FileSystemDirectoryHandle is not reliably structured-cloneable through
    // extension messaging, so write to the shared IndexedDB store directly.
    await saveRootDirect(handle);

    // Acknowledge via background, then tell every content script to re-read.
    await sendOp('rootChanged');
    broadcastRootChanged();
    $rootName.textContent = handle.name;
    await refresh();
    setStatus('已选择目录：' + handle.name + '。请刷新已打开的聊天页面。');
  } catch (e) {
    if ((e && e.name) === 'AbortError') return;
    setStatus('选择目录失败：' + String((e && e.message) || e));
  } finally {
    $pickBtn.disabled = false;
  }
}

$pickBtn.addEventListener('click', pickDirectory);
refresh();
setInterval(refresh, 15000);

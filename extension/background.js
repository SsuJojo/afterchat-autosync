/*
 * background.js — MV3 service worker (module)
 * Owns the FileSystemDirectoryHandle and every File System Access operation.
 * Handles are never returned through messaging; callers always work by path.
 */
'use strict';

var DB_NAME = 'acSyncExtDb';
var STORE = 'handles';
var ROOT_KEY = 'root';
var DB_VERSION = 1;

// token -> FileSystemWritableFileStream
var writables = new Map();

/* ------------------------------------------------------------------ */
/* IndexedDB helpers                                                   */
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

async function getRoot() {
  var db = await openDb();
  try {
    return await new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readonly');
      var req = tx.objectStore(STORE).get(ROOT_KEY);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error || new Error('读取目录句柄失败')); };
    });
  } finally {
    db.close();
  }
}

async function setRoot(handle) {
  var db = await openDb();
  try {
    return await new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, ROOT_KEY);
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { reject(tx.error || new Error('保存目录句柄失败')); };
      tx.onabort = function () { reject(tx.error || new Error('保存目录句柄已中止')); };
    });
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ */
/* Path helpers                                                        */
/* ------------------------------------------------------------------ */

async function resolveDir(path) {
  var root = await getRoot();
  if (!root) throw new Error('尚未选择同步目录');
  var dir = root;
  var segments = Array.isArray(path) ? path : [];
  for (var i = 0; i < segments.length; i++) {
    dir = await dir.getDirectoryHandle(String(segments[i]), { create: false });
  }
  return dir;
}

function errText(e) {
  return String((e && e.message) || e);
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

var OPS = {
  getRoot: async function () {
    var root = await getRoot();
    return root ? { name: root.name } : null;
  },

  setRoot: async function (args) {
    if (!args || !args.handle) throw new Error('缺少目录句柄');
    await setRoot(args.handle);
    return { ok: true };
  },

  openConsole: async function () {
    await chrome.tabs.create({ url: chrome.runtime.getURL('console.html') });
    return { opened: true };
  },

  getDirectoryHandle: async function (args) {
    var parent = await resolveDir(args && args.path);
    await parent.getDirectoryHandle(String(args.name), { create: !!args.create });
    return { ok: true };
  },

  getFileHandle: async function (args) {
    var parent = await resolveDir(args && args.path);
    await parent.getFileHandle(String(args.name), { create: !!args.create });
    return { ok: true };
  },

  removeEntry: async function (args) {
    var parent = await resolveDir(args && args.path);
    await parent.removeEntry(String(args.name));
    return { ok: true };
  },

  entries: async function (args) {
    var dir = await resolveDir(args && args.path);
    var out = [];
    for await (var entry of dir.entries()) {
      out.push({ name: entry[0], kind: entry[1].kind });
    }
    return out;
  },

  getFileText: async function (args) {
    var dir = await resolveDir(args && args.path);
    var fh = await dir.getFileHandle(String(args.name));
    var file = await fh.getFile();
    return await file.text();
  },

  // Returns the raw token string so callers can pass it straight into
  // write/close: const t = await call('createWritable', ...).
  createWritable: async function (args) {
    var dir = await resolveDir(args && args.path);
    var fh = await dir.getFileHandle(String(args.name), { create: true });
    var stream = await fh.createWritable();
    var token = 'w-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    writables.set(token, stream);
    return token;
  },

  write: async function (args) {
    var stream = writables.get(args && args.token);
    if (!stream) throw new Error('无效的写入令牌');
    await stream.write(args.content);
    return { ok: true };
  },

  close: async function (args) {
    var stream = writables.get(args && args.token);
    if (!stream) throw new Error('无效的写入令牌');
    await stream.close();
    writables.delete(args.token);
    return { ok: true };
  },

  queryPermission: async function () {
    return (await getRoot()) ? 'granted' : 'prompt';
  },

  requestPermission: async function () {
    return (await getRoot()) ? 'granted' : 'prompt';
  },

  listChats: async function () {
    var root = await getRoot();
    if (!root) return [];

    var platforms = [];
    for await (var entry of root.entries()) {
      if (entry[1].kind === 'directory' && !entry[0].startsWith('_')) {
        platforms.push(entry[0]);
      }
    }

    var chats = [];
    for (var p = 0; p < platforms.length; p++) {
      var platform = platforms[p];
      try {
        var dir = await root.getDirectoryHandle(platform);
        var index = {};
        try {
          var idxHandle = await dir.getFileHandle('_sync_index.json');
          var idxFile = await idxHandle.getFile();
          var parsed = JSON.parse(await idxFile.text());
          if (parsed && typeof parsed === 'object') index = parsed;
        } catch (e) {
          index = {}; // missing or malformed index is not fatal
        }

        for await (var f of dir.entries()) {
          var name = f[0];
          if (f[1].kind !== 'file') continue;
          if (!name.endsWith('.md')) continue;
          if (name.startsWith('_failed')) continue;

          var base = name.slice(0, -3);
          var m = /^(\d{8})-(\d{6})-(.*)$/.exec(base);
          var when = '';
          var title = base;
          if (m) {
            var d = m[1];
            var t = m[2];
            when = d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) +
              ' ' + t.slice(0, 2) + ':' + t.slice(2, 4) + ':' + t.slice(4, 6);
            title = m[3];
          }

          chats.push({
            platform: platform,
            name: name,
            title: title,
            when: when,
            index: {
              lastExportAt: index.lastExportAt,
              pending: index.pending
            }
          });
        }
      } catch (e) {
        // unreadable platform — skip it rather than failing the whole list
      }
    }

    chats.sort(function (a, b) { return String(b.when).localeCompare(String(a.when)); });
    return chats.slice(0, 200);
  },

  // Console broadcasts the change to tabs itself; this is an explicit no-op
  // acknowledgement so the console can await a completed round trip.
  rootChanged: async function () {
    return { ok: true };
  }
};

/* ------------------------------------------------------------------ */
/* Message router                                                      */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.__acSyncExt !== true) return false;

  var fn = OPS[msg.op];
  if (!fn) {
    sendResponse({ __error: '未知操作: ' + String(msg.op) });
    return false;
  }

  Promise.resolve()
    .then(function () { return fn(msg.args || {}); })
    .then(function (value) {
      sendResponse(value === undefined ? { ok: true } : value);
    })
    .catch(function (e) {
      sendResponse({ __error: errText(e) });
    });

  return true;
});

/*
 * page-bridge.js — MAIN world
 * Exposes a Promise-based bridge so the in-page AfterChat module can call
 * extension capabilities through ordinary page messaging only.
 */
(function () {
  'use strict';

  window.__AC_SYNC_EXTENSION__ = true;

  window.__AC_SYNC_EXT_CALL__ = function __acSyncExtCall(op, args = {}) {
    return new Promise(function (resolve, reject) {
      var id = 'ac-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      var settled = false;

      function cleanup() {
        window.removeEventListener('message', onMessage);
      }

      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('AfterChat 扩展调用超时: ' + String(op)));
      }, 10000);

      function onMessage(event) {
        if (event.source !== window) return;
        var data = event.data;
        if (!data || data.__acSyncExtId !== id) return;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        if (data.ok) {
          resolve(data.value);
        } else {
          reject(new Error(String(data.error || 'AfterChat 扩展调用失败')));
        }
      }

      window.addEventListener('message', onMessage);
      window.postMessage({ __acSyncExtReq: true, id: id, op: op, args: args }, '*');
    });
  };
})();

/*
 * content-bridge.js — ISOLATED world
 * Relays window.postMessage requests from the MAIN world to the service
 * worker, and relays root-change broadcasts back into the page.
 */
(function () {
  'use strict';

  function postToPage(payload) {
    try {
      window.postMessage(payload, '*');
    } catch (e) {
      /* page navigation or detached window — ignore */
    }
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.__acSyncExtReq !== true) return;

    var id = data.id;
    var op = data.op;
    var args = data.args || {};

    function reply(payload) {
      var out = { __acSyncExtId: id };
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'ok')) {
        out.ok = payload.ok;
        if (payload.ok) out.value = payload.value;
        else out.error = String(payload.error);
      } else {
        out.ok = true;
        out.value = payload;
      }
      postToPage(out);
    }

    function fail(e) {
      reply({ ok: false, error: String((e && e.message) || e) });
    }

    try {
      chrome.runtime.sendMessage({ __acSyncExt: true, op: op, args: args }, function (response) {
        try {
          var lastError = chrome.runtime.lastError;
          if (lastError) {
            fail(lastError);
            return;
          }
          if (response && response.__error) {
            fail(new Error(String(response.__error)));
            return;
          }
          reply(response === undefined ? { ok: true, value: undefined } : response);
        } catch (e) {
          fail(e);
        }
      });
    } catch (e) {
      fail(e);
    }
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'acSyncRootChanged') {
      postToPage({ __acSyncExtRootChanged: true });
    }
  });
})();

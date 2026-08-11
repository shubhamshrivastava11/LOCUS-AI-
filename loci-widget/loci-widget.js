/**
 * Loci (pronounced "Loki") chat widget for locusaiapp.com.
 *
 * Standalone, framework-free, single file, served from frontend/public/ so
 * Vite exposes it at /loci-widget.js. Mounted site-wide via a plain
 * <script> tag in frontend/index.html - no React dependency, so it works
 * the same whether the visitor is on the marketing page or logged into
 * the app shell.
 *
 * No API key or config needed - it talks to a fixed, public Supabase Edge
 * Function endpoint that has its own rate limiting server-side, so nothing
 * secret is embedded here.
 */
(function () {
  "use strict";

  var ENDPOINT = "https://imazdfzxinltbgktrgmv.supabase.co/functions/v1/loci-chat";
  var SESSION_KEY = "loci_session_id";

  function getSessionId() {
    try {
      var existing = window.localStorage.getItem(SESSION_KEY);
      if (existing) return existing;
      var fresh = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
      window.localStorage.setItem(SESSION_KEY, fresh);
      return fresh;
    } catch (e) {
      // localStorage unavailable (private mode, etc.) - fall back to an
      // in-memory id that resets on reload rather than breaking entirely.
      return "session-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    }
  }

  var sessionId = getSessionId();

  var css = "\n" +
    "#loci-widget-root { position: fixed; bottom: 20px; right: 20px; z-index: 999999; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }\n" +
    "#loci-bubble { width: 56px; height: 56px; border-radius: 50%; background: #111827; color: #fff; border: none; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,0.2); display: flex; align-items: center; justify-content: center; font-size: 24px; }\n" +
    "#loci-bubble:hover { background: #1f2937; }\n" +
    "#loci-panel { display: none; position: fixed; bottom: 88px; right: 20px; width: 360px; max-width: calc(100vw - 40px); height: 480px; max-height: calc(100vh - 140px); background: #fff; border-radius: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.24); flex-direction: column; overflow: hidden; }\n" +
    "#loci-panel.open { display: flex; }\n" +
    "#loci-header { background: #111827; color: #fff; padding: 14px 16px; font-weight: 600; font-size: 14px; display: flex; justify-content: space-between; align-items: center; }\n" +
    "#loci-header small { font-weight: 400; opacity: 0.7; display: block; font-size: 11px; margin-top: 2px; }\n" +
    "#loci-close { background: none; border: none; color: #fff; cursor: pointer; font-size: 18px; line-height: 1; opacity: 0.8; }\n" +
    "#loci-close:hover { opacity: 1; }\n" +
    "#loci-messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; background: #f9fafb; }\n" +
    ".loci-msg { max-width: 82%; padding: 9px 12px; border-radius: 12px; font-size: 13.5px; line-height: 1.45; white-space: pre-wrap; }\n" +
    ".loci-msg.user { align-self: flex-end; background: #111827; color: #fff; border-bottom-right-radius: 3px; }\n" +
    ".loci-msg.assistant { align-self: flex-start; background: #fff; color: #111827; border: 1px solid #e5e7eb; border-bottom-left-radius: 3px; }\n" +
    ".loci-msg.error { align-self: center; background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; font-size: 12.5px; }\n" +
    ".loci-msg.thinking { align-self: flex-start; background: #fff; color: #9ca3af; border: 1px solid #e5e7eb; font-style: italic; }\n" +
    "#loci-input-row { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #e5e7eb; background: #fff; }\n" +
    "#loci-input { flex: 1; border: 1px solid #d1d5db; border-radius: 10px; padding: 9px 12px; font-size: 13.5px; outline: none; resize: none; font-family: inherit; }\n" +
    "#loci-input:focus { border-color: #111827; }\n" +
    "#loci-send { background: #111827; color: #fff; border: none; border-radius: 10px; padding: 0 16px; cursor: pointer; font-size: 13px; font-weight: 600; }\n" +
    "#loci-send:disabled { opacity: 0.5; cursor: not-allowed; }\n";

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var root = document.createElement("div");
  root.id = "loci-widget-root";
  root.innerHTML =
    '<button id="loci-bubble" aria-label="Open chat">💬</button>' +
    '<div id="loci-panel">' +
      '<div id="loci-header"><div>Loci<small>Ask about Locus AI</small></div>' +
      '<button id="loci-close" aria-label="Close chat">✕</button></div>' +
      '<div id="loci-messages"></div>' +
      '<div id="loci-input-row">' +
        '<textarea id="loci-input" rows="1" placeholder="Ask about pricing, how it works..."></textarea>' +
        '<button id="loci-send">Send</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(root);

  var bubble = document.getElementById("loci-bubble");
  var panel = document.getElementById("loci-panel");
  var closeBtn = document.getElementById("loci-close");
  var messagesEl = document.getElementById("loci-messages");
  var input = document.getElementById("loci-input");
  var sendBtn = document.getElementById("loci-send");
  var opened = false;

  function addMessage(text, cls) {
    var el = document.createElement("div");
    el.className = "loci-msg " + cls;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function toggle() {
    opened = !opened;
    panel.classList.toggle("open", opened);
    if (opened && messagesEl.children.length === 0) {
      addMessage("Hi, I'm Loci. Ask me anything about how Locus AI works, pricing, or getting started.", "assistant");
    }
    if (opened) input.focus();
  }

  bubble.addEventListener("click", toggle);
  closeBtn.addEventListener("click", toggle);

  var sending = false;

  function send() {
    var text = input.value.trim();
    if (!text || sending) return;

    addMessage(text, "user");
    input.value = "";
    sending = true;
    sendBtn.disabled = true;
    var thinkingEl = addMessage("...", "thinking");

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, message: text }),
    })
      .then(function (resp) {
        return resp.json().then(function (data) {
          return { status: resp.status, data: data };
        });
      })
      .then(function (result) {
        thinkingEl.remove();
        if (result.status === 429) {
          addMessage(result.data.error || "Too many messages - try again shortly.", "error");
        } else if (result.status >= 400) {
          addMessage(result.data.error || "Something went wrong. Try again shortly.", "error");
        } else {
          addMessage(result.data.reply, "assistant");
        }
      })
      .catch(function () {
        thinkingEl.remove();
        addMessage("Couldn't reach the server - check your connection and try again.", "error");
      })
      .finally(function () {
        sending = false;
        sendBtn.disabled = false;
      });
  }

  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
})();

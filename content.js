// Discord Image Cooldown Guard v2
// Rolling-window limiter: at most `maxImages` images per `windowMinutes` per channel.
// Settings live in chrome.storage.sync, send history in chrome.storage.local.
(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    windowMinutes: 5,
    maxImages: 1,
    bufferSeconds: 5,
    scope: "all", // "all" = every channel, "listed" = only channels in `channels`
    channels: {}, // { "<channelId>": { windowMinutes, maxImages } } (per-channel overrides)
    countMode: "images", // "images" = only images count, "attachments" = any file counts
    showBadge: true,
    allowOverride: false, // press Enter twice within 4s to bypass the block
    // Discord uses hashed class names, so selectors match on prefixes.
    // First selector that matches anything wins. Editable in the popup.
    attachmentSelectors: [
      'ul[class*="attachedFiles"] > li',
      '[class*="channelAttachmentArea"] li',
      '[class*="uploadArea"] li[class*="attachment"]',
    ],
  };

  const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|tiff?|svg)\b/i;

  let settings = { ...DEFAULTS };
  let history = {}; // channelId -> number[] (one timestamp per image sent)

  // ---------- storage ----------
  function mergeSettings(s) {
    const m = { ...DEFAULTS, ...(s || {}) };
    if (!m.channels || typeof m.channels !== "object") m.channels = {};
    if (!Array.isArray(m.attachmentSelectors) || !m.attachmentSelectors.length)
      m.attachmentSelectors = DEFAULTS.attachmentSelectors;
    return m;
  }

  function safe(fn) {
    try {
      return fn();
    } catch (e) {
      // "Extension context invalidated" after the extension is reloaded; ignore.
    }
  }

  safe(() => {
    chrome.storage.sync.get(null, (s) => (settings = mergeSettings(s)));
    chrome.storage.local.get("history", (r) => (history = (r && r.history) || {}));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync") {
        chrome.storage.sync.get(null, (s) => (settings = mergeSettings(s)));
      } else if (area === "local" && changes.history) {
        history = changes.history.newValue || {};
      }
    });
  });

  function saveHistory() {
    safe(() => chrome.storage.local.set({ history }));
  }

  // ---------- rules ----------
  function getChannelId() {
    const m = location.pathname.match(/^\/channels\/[^/]+\/(\d+)/);
    return m ? m[1] : null;
  }

  function getRule(id) {
    if (!id || !settings.enabled) return null;
    const o = settings.channels[id];
    if (settings.scope === "listed" && !o) return null;
    const minutes = Number((o && o.windowMinutes) ?? settings.windowMinutes);
    const max = Number((o && o.maxImages) ?? settings.maxImages);
    return {
      windowMs: Math.max(0.1, minutes) * 60000,
      max: Math.max(1, Math.floor(max)),
      bufferMs: Math.max(0, Number(settings.bufferSeconds) || 0) * 1000,
    };
  }

  function activeStamps(id, rule) {
    const cutoff = Date.now() - rule.windowMs - rule.bufferMs;
    return (history[id] || []).filter((t) => t > cutoff).sort((a, b) => a - b);
  }

  // ---------- composer inspection ----------
  function listAttachmentItems() {
    for (const sel of settings.attachmentSelectors) {
      try {
        const nodes = [...document.querySelectorAll(sel)];
        if (nodes.length) return nodes;
      } catch (e) {
        /* invalid selector, skip */
      }
    }
    return [];
  }

  function isImageItem(el) {
    if (el.querySelector("img, canvas")) return true; // thumbnail preview
    const label = (el.getAttribute("aria-label") || "") + " " + el.textContent;
    return IMAGE_EXT.test(label);
  }

  // Number of images (or attachments, per countMode) currently queued in the composer.
  function countPending() {
    const items = listAttachmentItems();
    let total;
    let images;
    if (items.length) {
      total = items.length;
      images = items.filter(isImageItem).length;
    } else {
      // Fallback that survives class renames: local previews are blob: URLs.
      const box = document.querySelector('[role="textbox"]');
      const scope = (box && box.closest("form")) || document;
      total = images = scope.querySelectorAll('img[src^="blob:"]').length;
    }
    return settings.countMode === "attachments" ? total : images;
  }

  // ---------- decision ----------
  function evaluate(id, rule, n) {
    if (n > rule.max) {
      return { allow: false, tooMany: true, reason: `Max ${rule.max} image${rule.max > 1 ? "s" : ""} per message here` };
    }
    const stamps = activeStamps(id, rule);
    const over = stamps.length + n - rule.max;
    if (over <= 0) return { allow: true };
    const wait = stamps[over - 1] + rule.windowMs + rule.bufferMs - Date.now();
    return { allow: false, wait, reason: `Image limit reached (${stamps.length}/${rule.max}). Wait ${fmt(wait)}` };
  }

  function record(id, n) {
    const now = Date.now();
    const arr = (history[id] || []).filter((t) => t > now - HISTORY_MAX_AGE_MS);
    for (let i = 0; i < n; i++) arr.push(now);
    history[id] = arr;
    saveHistory();
  }

  let lastBlockedAt = 0;
  function onSend(e) {
    const id = getChannelId();
    const rule = getRule(id);
    if (!rule) return;
    const n = countPending();
    if (!n) return;

    const r = evaluate(id, rule, n);
    if (r.allow) {
      record(id, n);
      return;
    }
    if (settings.allowOverride && !r.tooMany && Date.now() - lastBlockedAt < 4000) {
      lastBlockedAt = 0;
      record(id, n);
      toast("Override: sending anyway", "#faa61a");
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    lastBlockedAt = Date.now();
    toast(`⛔ ${r.reason}` + (settings.allowOverride && !r.tooMany ? " (Enter again to override)" : ""));
  }

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      const t = e.target;
      if (!(t instanceof Element) || !t.closest('[role="textbox"]')) return;
      onSend(e);
    },
    true
  );

  window.addEventListener(
    "click",
    (e) => {
      if (!(e.target instanceof Element)) return;
      if (e.target.closest('button[aria-label="Send Message"], [aria-label="Send Message"]')) onSend(e);
    },
    true
  );

  // ---------- UI ----------
  function fmt(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h) return `${h}h ${m}m`;
    return m ? `${m}m ${String(sec).padStart(2, "0")}s` : `${sec}s`;
  }

  let toastEl = null;
  let toastTimer = null;
  function toast(text, color = "#ed4245") {
    if (!toastEl) {
      toastEl = document.createElement("div");
      Object.assign(toastEl.style, {
        position: "fixed",
        bottom: "90px",
        left: "50%",
        transform: "translateX(-50%)",
        color: "#fff",
        padding: "10px 16px",
        borderRadius: "8px",
        font: "600 14px system-ui, sans-serif",
        zIndex: 2147483647,
        boxShadow: "0 4px 12px rgba(0,0,0,.4)",
        pointerEvents: "none",
      });
      document.body.appendChild(toastEl);
    }
    toastEl.style.background = color;
    toastEl.textContent = text;
    toastEl.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.style.display = "none"), 3500);
  }

  let badgeEl = null;
  function status() {
    const id = getChannelId();
    const rule = getRule(id);
    if (!rule) return { channelId: id, guarded: false };
    const stamps = activeStamps(id, rule);
    const used = stamps.length;
    const nextMs = used >= rule.max ? stamps[used - rule.max] + rule.windowMs + rule.bufferMs - Date.now() : 0;
    return {
      channelId: id,
      guarded: true,
      used,
      max: rule.max,
      windowMinutes: rule.windowMs / 60000,
      nextMs,
    };
  }

  function updateBadge() {
    const st = status();
    if (!settings.showBadge || !st.guarded) {
      if (badgeEl) badgeEl.style.display = "none";
      return;
    }
    if (!badgeEl) {
      badgeEl = document.createElement("div");
      Object.assign(badgeEl.style, {
        position: "fixed",
        right: "14px",
        bottom: "14px",
        color: "#fff",
        padding: "5px 10px",
        borderRadius: "999px",
        font: "600 12px system-ui, sans-serif",
        zIndex: 2147483646,
        opacity: "0.9",
        pointerEvents: "none",
      });
      document.body.appendChild(badgeEl);
    }
    const blocked = st.nextMs > 0;
    badgeEl.style.display = "block";
    badgeEl.style.background = blocked ? "#ed4245" : "#3ba55d";
    badgeEl.textContent = `🖼 ${st.used}/${st.max} per ${st.windowMinutes}m · ${blocked ? "next in " + fmt(st.nextMs) : "ready"}`;
  }
  setInterval(() => safe(updateBadge), 1000);

  // ---------- popup messaging ----------
  safe(() =>
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg) return;
      if (msg.type === "getStatus") {
        sendResponse(status());
      } else if (msg.type === "resetChannel") {
        const id = getChannelId();
        if (id) delete history[id];
        saveHistory();
        sendResponse({ ok: true });
      } else if (msg.type === "resetAll") {
        history = {};
        saveHistory();
        sendResponse({ ok: true });
      }
    })
  );
})();

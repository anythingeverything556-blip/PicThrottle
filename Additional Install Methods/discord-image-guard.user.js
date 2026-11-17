// ==UserScript==
// @name         Discord Image Cooldown Guard
// @namespace    discord-image-guard
// @version      3.0.0
// @description  Limit how many images you send per time window on Discord (web). Per-channel rules, live badge, in-page settings.
// @match        https://discord.com/*
// @match        https://canary.discord.com/*
// @match        https://ptb.discord.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @license      MIT
// ==/UserScript==

// Discord Image Cooldown Guard v3 (single file)
// Works as: Tampermonkey/Violentmonkey/Greasemonkey userscript, DevTools console snippet, or bookmarklet.
// Open settings: click the badge, press Alt+Shift+G, or use the userscript manager menu.
(() => {
  "use strict";

  // Re-running (e.g. bookmarklet clicked twice) just opens the settings panel.
  if (window.__dicgLoaded) {
    if (window.__dicgOpen) window.__dicgOpen();
    return;
  }
  window.__dicgLoaded = true;

  const DEFAULTS = {
    enabled: true,
    windowMinutes: 5,
    maxImages: 1,
    bufferSeconds: 5,
    scope: "all", // "all" = every channel, "listed" = only channels in `channels`
    channels: {}, // { "<channelId>": { windowMinutes, maxImages } }
    countMode: "images", // "images" or "attachments"
    showBadge: true,
    allowOverride: false, // press Enter twice within 4s to bypass the block
    // Discord hashes its CSS class names, so selectors match on prefixes.
    // First selector that matches anything wins. Editable in the panel.
    attachmentSelectors: [
      'ul[class*="attachedFiles"] > li',
      '[class*="channelAttachmentArea"] li',
      '[class*="uploadArea"] li[class*="attachment"]',
    ],
  };

  const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|tiff?|svg)\b/i;

  // ---------- storage (GM_* when available, localStorage otherwise) ----------
  const store = {
    get(k, d) {
      try {
        if (typeof GM_getValue === "function") return GM_getValue(k, d);
      } catch (e) {}
      try {
        const v = localStorage.getItem("dicg:" + k);
        return v === null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        if (typeof GM_setValue === "function") return void GM_setValue(k, v);
      } catch (e) {}
      try {
        localStorage.setItem("dicg:" + k, JSON.stringify(v));
      } catch (e) {}
    },
  };

  function mergeSettings(s) {
    const m = { ...DEFAULTS, ...(s && typeof s === "object" ? s : {}) };
    if (!m.channels || typeof m.channels !== "object") m.channels = {};
    if (!Array.isArray(m.attachmentSelectors) || !m.attachmentSelectors.length)
      m.attachmentSelectors = [...DEFAULTS.attachmentSelectors];
    return m;
  }
  const getSettings = () => mergeSettings(store.get("settings", {}));
  const setSettings = (s) => store.set("settings", s);
  const getHistory = () => store.get("history", {}) || {};
  const setHistory = (h) => store.set("history", h);

  // ---------- rules ----------
  function getChannelId() {
    const m = location.pathname.match(/^\/channels\/[^/]+\/(\d+)/);
    return m ? m[1] : null;
  }

  function getRule(id, s = getSettings()) {
    if (!id || !s.enabled) return null;
    const o = s.channels[id];
    if (s.scope === "listed" && !o) return null;
    const minutes = Number((o && o.windowMinutes) ?? s.windowMinutes);
    const max = Number((o && o.maxImages) ?? s.maxImages);
    return {
      windowMs: Math.max(0.1, minutes || 5) * 60000,
      max: Math.max(1, Math.floor(max || 1)),
      bufferMs: Math.max(0, Number(s.bufferSeconds) || 0) * 1000,
    };
  }

  function activeStamps(id, rule) {
    const cutoff = Date.now() - rule.windowMs - rule.bufferMs;
    return (getHistory()[id] || []).filter((t) => t > cutoff).sort((a, b) => a - b);
  }

  // ---------- composer inspection ----------
  function listAttachmentItems(s) {
    for (const sel of s.attachmentSelectors) {
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
    if (el.querySelector("img, canvas")) return true;
    const label = (el.getAttribute("aria-label") || "") + " " + el.textContent;
    return IMAGE_EXT.test(label);
  }

  // Images (or attachments, per countMode) currently queued in the message box.
  function countPending(s) {
    const items = listAttachmentItems(s);
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
    return s.countMode === "attachments" ? total : images;
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
    const h = getHistory();
    const arr = (h[id] || []).filter((t) => t > now - HISTORY_MAX_AGE_MS);
    for (let i = 0; i < n; i++) arr.push(now);
    h[id] = arr;
    setHistory(h);
  }

  let lastBlockedAt = 0;
  function onSend(e) {
    const s = getSettings();
    const id = getChannelId();
    const rule = getRule(id, s);
    if (!rule) return;
    const n = countPending(s);
    if (!n) return;

    const r = evaluate(id, rule, n);
    if (r.allow) {
      record(id, n);
      return;
    }
    if (s.allowOverride && !r.tooMany && Date.now() - lastBlockedAt < 4000) {
      lastBlockedAt = 0;
      record(id, n);
      toast("Override: sending anyway", "#faa61a");
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    lastBlockedAt = Date.now();
    toast(`⛔ ${r.reason}` + (s.allowOverride && !r.tooMany ? " (Enter again to override)" : ""));
  }

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.altKey && e.shiftKey && e.code === "KeyG") {
        e.preventDefault();
        togglePanel();
        return;
      }
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

  // ---------- helpers ----------
  function fmt(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h) return `${h}h ${m}m`;
    return m ? `${m}m ${String(sec).padStart(2, "0")}s` : `${sec}s`;
  }

  function num(v, fallback, min) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.max(min, n) : fallback;
  }

  function status() {
    const id = getChannelId();
    const rule = getRule(id);
    if (!id) return { channelId: null, guarded: false };
    if (!rule) return { channelId: id, guarded: false };
    const stamps = activeStamps(id, rule);
    const used = stamps.length;
    const nextMs = used >= rule.max ? stamps[used - rule.max] + rule.windowMs + rule.bufferMs - Date.now() : 0;
    return { channelId: id, guarded: true, used, max: rule.max, windowMinutes: rule.windowMs / 60000, nextMs };
  }

  // ---------- UI (shadow DOM so Discord's CSS can't touch it) ----------
  const CSS = `
    *{box-sizing:border-box;font-family:system-ui,sans-serif}
    [hidden]{display:none!important}
    #badge{position:fixed;right:14px;bottom:14px;pointer-events:auto;cursor:pointer;color:#fff;padding:5px 10px;border-radius:999px;font:600 12px system-ui,sans-serif;opacity:.92}
    #toast{position:fixed;bottom:90px;left:50%;transform:translateX(-50%);color:#fff;padding:10px 16px;border-radius:8px;font:600 14px system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.4)}
    #panel{position:fixed;top:50%;right:20px;transform:translateY(-50%);width:360px;max-height:86vh;overflow:auto;pointer-events:auto;background:#1e1f22;color:#dbdee1;border-radius:10px;padding:14px;font:13px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.6)}
    h3{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#949ba4;margin:14px 0 6px}
    .head{display:flex;justify-content:space-between;align-items:center;font-size:15px}
    .card{background:#2b2d31;border-radius:8px;padding:8px 10px}
    .row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0}
    .row label{flex:1}
    input[type=number],select,input[type=text],textarea{background:#1e1f22;color:#dbdee1;border:1px solid #3f4147;border-radius:4px;padding:4px 6px;font:inherit}
    input[type=number]{width:70px}
    input[type=text]{width:150px}
    textarea{width:100%;font:11px monospace;height:70px}
    button{background:#5865f2;color:#fff;border:0;border-radius:4px;padding:5px 9px;cursor:pointer;font:inherit}
    button.gray{background:#4e5058}
    button.red{background:#da373c}
    .btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
    .st{font-weight:600}
    .ok{color:#3ba55d}.bad{color:#f23f42}.muted{color:#949ba4;font-weight:400}
    .hint{color:#949ba4;font-size:11px;margin-top:4px}
    .rule{display:grid;grid-template-columns:1fr 60px 60px auto;gap:4px;align-items:center;margin:4px 0;font-size:11px}
    .rule input{width:100%}
  `;

  const PANEL_HTML = `
    <div class="head"><b>🖼 Image Cooldown Guard</b><button id="close" class="gray">✕</button></div>
    <div class="card" style="margin-top:10px">
      <div id="status" class="st muted">…</div>
      <div class="btns"><button id="resetCh" class="gray">Reset this channel</button><button id="resetAll" class="gray">Reset all history</button></div>
    </div>
    <h3>Default rule</h3>
    <div class="card">
      <div class="row"><label>Enabled</label><input type="checkbox" id="enabled"></div>
      <div class="row"><label>Max images…</label><input type="number" id="maxImages" min="1" step="1"></div>
      <div class="row"><label>…per (minutes)</label><input type="number" id="windowMinutes" min="0.1" step="0.5"></div>
      <div class="row"><label>Safety buffer (seconds)</label><input type="number" id="bufferSeconds" min="0" step="1"></div>
      <div class="row"><label>Count</label><select id="countMode"><option value="images">Images only</option><option value="attachments">Any attachment</option></select></div>
      <div class="row"><label>Apply to</label><select id="scope"><option value="all">All channels</option><option value="listed">Only listed channels</option></select></div>
      <div class="row"><label>Show status badge</label><input type="checkbox" id="showBadge"></div>
      <div class="row"><label>Allow override (Enter twice)</label><input type="checkbox" id="allowOverride"></div>
    </div>
    <h3>Channel rules</h3>
    <div class="card">
      <div class="rule muted"><span>Channel ID</span><span>Max</span><span>Min</span><span></span></div>
      <div id="rules"></div>
      <div class="btns"><button id="addCur">+ Add current channel</button><input type="text" id="newId" placeholder="or paste channel ID"><button id="addId" class="gray">Add</button></div>
      <div class="hint">Listed channels use their own limits. In "All channels" mode they act as overrides.</div>
    </div>
    <h3>Advanced: attachment selectors</h3>
    <div class="card">
      <textarea id="selectors" spellcheck="false"></textarea>
      <div class="hint">One CSS selector per line. Edit if Discord changes its markup. Falls back to blob: previews if none match.</div>
      <div class="btns"><button id="resetSel" class="gray">Restore defaults</button></div>
    </div>
    <h3>Backup / share settings</h3>
    <div class="card">
      <textarea id="io" spellcheck="false" placeholder="Export fills this box. Paste JSON here and press Import."></textarea>
      <div class="btns"><button id="export" class="gray">Export</button><button id="import" class="gray">Import</button></div>
    </div>
  `;

  let host = null;
  let root = null;
  let cfg = null; // working copy of settings while the panel is open
  const $ = (id) => root.getElementById(id);

  function buildUI() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.id = "dicg-host";
    host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style><div id="badge" hidden></div><div id="toast" hidden></div><div id="panel" hidden>${PANEL_HTML}</div>`;
    document.documentElement.appendChild(host);

    $("badge").addEventListener("click", togglePanel);
    $("close").addEventListener("click", closePanel);
    // Keep Discord's global hotkeys away from our inputs.
    $("panel").addEventListener("keydown", (e) => e.stopPropagation());
    $("panel").addEventListener("keyup", (e) => e.stopPropagation());

    for (const id of ["enabled", "maxImages", "windowMinutes", "bufferSeconds", "countMode", "scope", "showBadge", "allowOverride", "selectors"]) {
      $(id).addEventListener("change", readForm);
    }
    $("addCur").addEventListener("click", () => {
      const st = status();
      if (st.channelId) addChannel(st.channelId);
    });
    $("addId").addEventListener("click", () => {
      addChannel($("newId").value);
      $("newId").value = "";
    });
    $("resetCh").addEventListener("click", () => {
      const id = getChannelId();
      if (!id) return;
      const h = getHistory();
      delete h[id];
      setHistory(h);
      refreshStatus();
    });
    $("resetAll").addEventListener("click", () => {
      setHistory({});
      refreshStatus();
    });
    $("resetSel").addEventListener("click", () => {
      cfg.attachmentSelectors = [...DEFAULTS.attachmentSelectors];
      $("selectors").value = cfg.attachmentSelectors.join("\n");
      setSettings(cfg);
    });
    $("export").addEventListener("click", () => {
      const json = JSON.stringify(getSettings(), null, 2);
      $("io").value = json;
      $("io").select();
      try {
        navigator.clipboard.writeText(json);
      } catch (e) {}
    });
    $("import").addEventListener("click", () => {
      try {
        const parsed = JSON.parse($("io").value);
        if (!parsed || typeof parsed !== "object") throw new Error("bad");
        cfg = mergeSettings(parsed);
        setSettings(cfg);
        renderForm();
        toast("Settings imported", "#3ba55d");
      } catch (e) {
        toast("Import failed: invalid JSON");
      }
    });
  }

  function readForm() {
    cfg.enabled = $("enabled").checked;
    cfg.maxImages = Math.floor(num($("maxImages").value, DEFAULTS.maxImages, 1));
    cfg.windowMinutes = num($("windowMinutes").value, DEFAULTS.windowMinutes, 0.1);
    cfg.bufferSeconds = num($("bufferSeconds").value, DEFAULTS.bufferSeconds, 0);
    cfg.countMode = $("countMode").value;
    cfg.scope = $("scope").value;
    cfg.showBadge = $("showBadge").checked;
    cfg.allowOverride = $("allowOverride").checked;
    const sels = $("selectors").value.split("\n").map((x) => x.trim()).filter(Boolean);
    cfg.attachmentSelectors = sels.length ? sels : [...DEFAULTS.attachmentSelectors];
    setSettings(cfg);
  }

  function renderForm() {
    $("enabled").checked = cfg.enabled;
    $("maxImages").value = cfg.maxImages;
    $("windowMinutes").value = cfg.windowMinutes;
    $("bufferSeconds").value = cfg.bufferSeconds;
    $("countMode").value = cfg.countMode;
    $("scope").value = cfg.scope;
    $("showBadge").checked = cfg.showBadge;
    $("allowOverride").checked = cfg.allowOverride;
    $("selectors").value = cfg.attachmentSelectors.join("\n");
    renderRules();
  }

  function renderRules() {
    const box = $("rules");
    box.textContent = "";
    const ids = Object.keys(cfg.channels);
    if (!ids.length) {
      const p = document.createElement("div");
      p.className = "hint";
      p.textContent = "No channel rules yet.";
      box.appendChild(p);
      return;
    }
    for (const id of ids) {
      const r = cfg.channels[id];
      const row = document.createElement("div");
      row.className = "rule";

      const label = document.createElement("span");
      label.textContent = id;
      label.title = id;
      label.style.overflow = "hidden";
      label.style.textOverflow = "ellipsis";

      const max = document.createElement("input");
      max.type = "number";
      max.min = 1;
      max.value = r.maxImages ?? cfg.maxImages;
      max.addEventListener("change", () => {
        r.maxImages = Math.floor(num(max.value, cfg.maxImages, 1));
        setSettings(cfg);
      });

      const mins = document.createElement("input");
      mins.type = "number";
      mins.min = 0.1;
      mins.step = 0.5;
      mins.value = r.windowMinutes ?? cfg.windowMinutes;
      mins.addEventListener("change", () => {
        r.windowMinutes = num(mins.value, cfg.windowMinutes, 0.1);
        setSettings(cfg);
      });

      const del = document.createElement("button");
      del.className = "red";
      del.textContent = "✕";
      del.addEventListener("click", () => {
        delete cfg.channels[id];
        setSettings(cfg);
        renderRules();
      });

      row.append(label, max, mins, del);
      box.appendChild(row);
    }
  }

  function addChannel(id) {
    id = (id || "").trim();
    if (!/^\d{5,25}$/.test(id)) {
      toast("Channel ID should be a number (last part of the URL)");
      return;
    }
    if (!cfg.channels[id]) {
      cfg.channels[id] = { maxImages: cfg.maxImages, windowMinutes: cfg.windowMinutes };
      setSettings(cfg);
      renderRules();
    }
  }

  function refreshStatus() {
    if (!root || $("panel").hidden) return;
    const el = $("status");
    const st = status();
    if (!st.channelId) {
      el.className = "st muted";
      el.textContent = "Open a channel to see its status.";
    } else if (!st.guarded) {
      el.className = "st muted";
      el.textContent = "This channel is not guarded.";
    } else if (st.nextMs > 0) {
      el.className = "st bad";
      el.textContent = `${st.used}/${st.max} used · next image in ${fmt(st.nextMs)}`;
    } else {
      el.className = "st ok";
      el.textContent = `${st.used}/${st.max} used · ready to send`;
    }
  }

  function openPanel() {
    buildUI();
    cfg = getSettings();
    renderForm();
    $("panel").hidden = false;
    refreshStatus();
  }
  function closePanel() {
    if (root) $("panel").hidden = true;
  }
  function togglePanel() {
    if (root && !$("panel").hidden) closePanel();
    else openPanel();
  }
  window.__dicgOpen = openPanel;

  let toastTimer = null;
  function toast(text, color = "#ed4245") {
    buildUI();
    const el = $("toast");
    el.style.background = color;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3500);
  }

  function updateBadge() {
    buildUI();
    const el = $("badge");
    const s = getSettings();
    const st = status();
    if (!s.showBadge || !st.guarded) {
      el.hidden = true;
      return;
    }
    const blocked = st.nextMs > 0;
    el.hidden = false;
    el.style.background = blocked ? "#ed4245" : "#3ba55d";
    el.textContent = `🖼 ${st.used}/${st.max} per ${st.windowMinutes}m · ${blocked ? "next in " + fmt(st.nextMs) : "ready"}`;
    el.title = "Click for Image Guard settings (Alt+Shift+G)";
  }

  buildUI();
  setInterval(() => {
    try {
      updateBadge();
      refreshStatus();
    } catch (e) {}
  }, 1000);

  try {
    if (typeof GM_registerMenuCommand === "function") {
      GM_registerMenuCommand("Image Guard: settings", openPanel);
      GM_registerMenuCommand("Image Guard: reset this channel", () => {
        const id = getChannelId();
        if (!id) return;
        const h = getHistory();
        delete h[id];
        setHistory(h);
        toast("Timer reset for this channel", "#3ba55d");
      });
    }
  } catch (e) {}
})();

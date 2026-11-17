const DEFAULTS = {
  enabled: true,
  windowMinutes: 5,
  maxImages: 1,
  bufferSeconds: 5,
  scope: "all",
  channels: {},
  countMode: "images",
  showBadge: true,
  allowOverride: false,
  attachmentSelectors: [
    'ul[class*="attachedFiles"] > li',
    '[class*="channelAttachmentArea"] li',
    '[class*="uploadArea"] li[class*="attachment"]',
  ],
};

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULTS };
let current = null; // live status from the active Discord tab
let saveTimer = null;

function num(v, fallback, min) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.sync.set(settings), 150);
}

function readForm() {
  settings.enabled = $("enabled").checked;
  settings.maxImages = Math.floor(num($("maxImages").value, DEFAULTS.maxImages, 1));
  settings.windowMinutes = num($("windowMinutes").value, DEFAULTS.windowMinutes, 0.1);
  settings.bufferSeconds = num($("bufferSeconds").value, DEFAULTS.bufferSeconds, 0);
  settings.countMode = $("countMode").value;
  settings.scope = $("scope").value;
  settings.showBadge = $("showBadge").checked;
  settings.allowOverride = $("allowOverride").checked;
  const sels = $("selectors").value.split("\n").map((s) => s.trim()).filter(Boolean);
  settings.attachmentSelectors = sels.length ? sels : DEFAULTS.attachmentSelectors;
  save();
}

function renderForm() {
  $("enabled").checked = settings.enabled;
  $("maxImages").value = settings.maxImages;
  $("windowMinutes").value = settings.windowMinutes;
  $("bufferSeconds").value = settings.bufferSeconds;
  $("countMode").value = settings.countMode;
  $("scope").value = settings.scope;
  $("showBadge").checked = settings.showBadge;
  $("allowOverride").checked = settings.allowOverride;
  $("selectors").value = settings.attachmentSelectors.join("\n");
  renderRules();
}

function renderRules() {
  const box = $("rules");
  box.textContent = "";
  const ids = Object.keys(settings.channels);
  if (!ids.length) {
    const p = document.createElement("div");
    p.className = "hint";
    p.textContent = "No channel rules yet.";
    box.appendChild(p);
    return;
  }
  for (const id of ids) {
    const r = settings.channels[id];
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
    max.value = r.maxImages ?? settings.maxImages;
    max.onchange = () => {
      r.maxImages = Math.floor(num(max.value, settings.maxImages, 1));
      save();
    };

    const mins = document.createElement("input");
    mins.type = "number";
    mins.min = 0.1;
    mins.step = 0.5;
    mins.value = r.windowMinutes ?? settings.windowMinutes;
    mins.onchange = () => {
      r.windowMinutes = num(mins.value, settings.windowMinutes, 0.1);
      save();
    };

    const del = document.createElement("button");
    del.className = "red";
    del.textContent = "✕";
    del.onclick = () => {
      delete settings.channels[id];
      save();
      renderRules();
    };

    row.append(label, max, mins, del);
    box.appendChild(row);
  }
}

function addChannel(id) {
  id = (id || "").trim();
  if (!/^\d{5,25}$/.test(id)) return;
  if (!settings.channels[id]) {
    settings.channels[id] = { maxImages: settings.maxImages, windowMinutes: settings.windowMinutes };
    save();
    renderRules();
  }
}

async function activeDiscordTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.url && tab.url.startsWith("https://discord.com/") ? tab : null;
}

function fmt(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

async function refreshStatus() {
  const el = $("status");
  const tab = await activeDiscordTab();
  if (!tab) {
    current = null;
    el.className = "status muted";
    el.textContent = "Open a Discord tab to see live status.";
    return;
  }
  try {
    current = await chrome.tabs.sendMessage(tab.id, { type: "getStatus" });
  } catch (e) {
    current = null;
    el.className = "status muted";
    el.textContent = "Reload the Discord tab to activate the guard.";
    return;
  }
  if (!current || !current.channelId) {
    el.className = "status muted";
    el.textContent = "Open a channel to see its status.";
  } else if (!current.guarded) {
    el.className = "status muted";
    el.textContent = "This channel is not guarded.";
  } else if (current.nextMs > 0) {
    el.className = "status bad";
    el.textContent = `${current.used}/${current.max} used · next image in ${fmt(current.nextMs)}`;
  } else {
    el.className = "status ok";
    el.textContent = `${current.used}/${current.max} used · ready to send`;
  }
}

async function sendToTab(type) {
  const tab = await activeDiscordTab();
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type });
  } catch (e) {}
  refreshStatus();
}

async function init() {
  const stored = await chrome.storage.sync.get(null);
  settings = { ...DEFAULTS, ...stored, channels: stored.channels || {} };
  renderForm();

  for (const id of ["enabled", "maxImages", "windowMinutes", "bufferSeconds", "countMode", "scope", "showBadge", "allowOverride", "selectors"]) {
    $(id).addEventListener("change", readForm);
  }
  $("addCurrent").onclick = () => current && current.channelId && addChannel(current.channelId);
  $("addId").onclick = () => {
    addChannel($("newId").value);
    $("newId").value = "";
  };
  $("resetChannel").onclick = () => sendToTab("resetChannel");
  $("resetAll").onclick = () => sendToTab("resetAll");
  $("resetSelectors").onclick = () => {
    settings.attachmentSelectors = [...DEFAULTS.attachmentSelectors];
    $("selectors").value = settings.attachmentSelectors.join("\n");
    save();
  };

  refreshStatus();
  setInterval(refreshStatus, 1000);
}

init();

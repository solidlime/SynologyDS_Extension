// src/api/quickconnect.ts
var QC_SERV_URL = "https://global.quickconnect.to/Serv.php";
function isQuickConnect(input) {
  const s = input.trim().toLowerCase();
  const noScheme = s.replace(/^https?:\/\//, "");
  if (noScheme.includes(".quickconnect.to")) return true;
  if (noScheme.startsWith("quickconnect.to/")) return true;
  if (s.startsWith("http://") || s.startsWith("https://")) return false;
  if (/^[\w.-]+:\d+/.test(s)) return false;
  if (s.includes(".")) return false;
  return true;
}
async function resolveQuickConnect(input) {
  const s = input.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  if (s.toLowerCase().includes(".quickconnect.to")) {
    return `https://${s}`;
  }
  const serverID = s.replace(/^(?:www\.)?quickconnect\.to\//i, "");
  return _resolveServerID(serverID);
}
async function _resolveServerID(serverID) {
  let resp;
  try {
    resp = await fetch(QC_SERV_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        command: "get_server_info",
        stop_when_error: false,
        stop_when_success: true,
        id: "mobilestation",
        serverID,
        is_gofile: false
      })
    });
  } catch (e) {
    throw new Error(`QuickConnect lookup failed: ${e.message}`);
  }
  if (!resp.ok) {
    throw new Error(`QuickConnect lookup failed: HTTP ${resp.status}`);
  }
  const data = await resp.json();
  if (data.errno !== 0) {
    throw new Error(`QuickConnect: server ID "${serverID}" not found (errno ${data.errno})`);
  }
  const port = data.service?.port ?? 5001;
  const ext = data.server?.external?.ip;
  if (ext) return `https://${ext}:${port}`;
  const ddns = data.server?.ddns;
  if (ddns && ddns !== "NULL") return `https://${ddns}:${port}`;
  const fqdn = data.server?.fqdn;
  if (fqdn && fqdn !== "NULL") return `https://${fqdn}:${port}`;
  const controlHost = data.env?.control_host;
  const sid = data.server?.serverID ?? serverID;
  if (controlHost) return `https://${sid}.${controlHost}`;
  throw new Error(`QuickConnect: could not resolve a URL for server ID "${serverID}"`);
}

// src/api/synology.ts
var AUTH_ERRORS = {
  400: "No such account or incorrect password",
  401: "Account disabled",
  402: "Permission denied",
  403: "Two-factor authentication required (not supported)",
  404: "Failed to authenticate 2FA code"
};
var TASK_ERRORS = {
  400: "File upload failed",
  401: "Max number of tasks reached",
  402: "Destination denied",
  403: "Destination does not exist",
  404: "Invalid task ID",
  405: "Invalid task action",
  406: "No default destination",
  408: "File does not exist"
};
var SynologyAPIError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "SynologyAPIError";
  }
};
var SynologyAPI = class {
  sid = null;
  baseUrl = "";
  apiInfo = {};
  get isLoggedIn() {
    return this.sid !== null;
  }
  /** The resolved URL used for the last login — useful for diagnostics. */
  get resolvedUrl() {
    return this.baseUrl;
  }
  // ── API Info discovery ──────────────────────────────────────────────────────
  /**
   * Query SYNO.API.Info to discover correct paths and versions for all needed
   * APIs. Falls back silently — callers then use entry.cgi as default.
   */
  async _discoverApis() {
    const queryUrl = `${this.baseUrl}/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=SYNO.API.Auth,SYNO.DownloadStation.Task,SYNO.FileStation.Download`;
    try {
      const res = await fetch(queryUrl);
      if (!res.ok) return;
      const body = await res.json();
      if (body.success && body.data) {
        this.apiInfo = body.data;
      }
    } catch {
    }
  }
  /** Return the webapi sub-path for an API, defaulting to entry.cgi. */
  _path(api) {
    return this.apiInfo[api]?.path ?? "entry.cgi";
  }
  /**
   * Return the best version to use for an API, capped at our own maximum.
   * Falls back to maxSupported if API info is unavailable.
   */
  _version(api, maxSupported) {
    const info = this.apiInfo[api];
    if (!info) return String(maxSupported);
    return String(Math.min(info.maxVersion, maxSupported));
  }
  // ── Auth ────────────────────────────────────────────────────────────────────
  async login(settings) {
    let url = settings.url.trim().replace(/\/$/, "");
    if (isQuickConnect(url)) {
      url = await resolveQuickConnect(url);
    } else if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = `https://${url}`;
    }
    this.baseUrl = url;
    await this._discoverApis();
    const params = new URLSearchParams({
      api: "SYNO.API.Auth",
      version: this._version("SYNO.API.Auth", 7),
      method: "login",
      account: settings.username,
      passwd: settings.password,
      session: "FileStation",
      format: "sid"
    });
    const data = await this._request("SYNO.API.Auth", params, false);
    this.sid = data.sid;
  }
  async logout() {
    if (!this.sid) return;
    try {
      await this._request(
        "SYNO.API.Auth",
        new URLSearchParams({
          api: "SYNO.API.Auth",
          version: this._version("SYNO.API.Auth", 7),
          method: "logout",
          session: "FileStation"
        }),
        true
      );
    } finally {
      this.sid = null;
    }
  }
  /**
   * Returns a URL to open/download a file from the NAS via File Station.
   * Returns null if not logged in.
   * @param destination - The folder path (e.g. "/downloads")
   * @param filename    - The file or folder name (task title)
   */
  fileOpenUrl(destination, filename) {
    if (!this.sid) return null;
    const dest = destination.startsWith("/") ? destination : `/${destination}`;
    const path = `${dest.replace(/\/$/, "")}/${filename}`;
    const fsApi = "SYNO.FileStation.Download";
    const params = new URLSearchParams({
      api: fsApi,
      version: this._version(fsApi, 2),
      method: "download",
      path,
      mode: "open",
      _sid: this.sid
    });
    return `${this.baseUrl}/webapi/${this._path(fsApi)}?${params.toString()}`;
  }
  // ── Download Station tasks ──────────────────────────────────────────────────
  async listTasks(offset = 0, limit = 200) {
    return this._task({ method: "list", offset: String(offset), limit: String(limit), additional: "detail,transfer" });
  }
  async createTask(uri, destination) {
    const p = { method: "create", uri };
    if (destination) p["destination"] = destination;
    await this._task(p);
  }
  async resumeTasks(ids) {
    await this._task({ method: "resume", id: ids.join(",") });
  }
  async pauseTasks(ids) {
    await this._task({ method: "pause", id: ids.join(",") });
  }
  async deleteTasks(ids, forceComplete = false) {
    await this._task({ method: "delete", id: ids.join(","), force_complete: String(forceComplete) });
  }
  async _task(params) {
    const api = "SYNO.DownloadStation.Task";
    return this._request(
      api,
      new URLSearchParams({ api, version: this._version(api, 3), ...params }),
      true
    );
  }
  // ── HTTP transport ──────────────────────────────────────────────────────────
  async _request(api, params, authenticated) {
    if (authenticated) {
      if (!this.sid) throw new SynologyAPIError(0, "Not authenticated \u2014 please check NAS settings.");
      params.set("_sid", this.sid);
    }
    const endpoint = `${this.baseUrl}/webapi/${this._path(api)}`;
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString()
      });
    } catch (e) {
      const raw = e.message;
      const isHttps = this.baseUrl.startsWith("https://");
      if (raw === "Failed to fetch" || raw.includes("ERR_")) {
        const hint = isHttps ? " If using HTTPS with a self-signed cert, open the NAS URL in Chrome and accept the certificate first." : " Check that the NAS is reachable and the port is correct.";
        throw new Error(`Cannot reach ${this.baseUrl}.${hint}`);
      }
      throw new Error(`Network error (${this.baseUrl}): ${raw}`);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${this.baseUrl}: ${response.statusText}`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Invalid response from ${this.baseUrl} \u2014 is this a Synology NAS?`);
    }
    if (!data.success) {
      const code = data.error?.code ?? -1;
      const apiName = params.get("api") ?? "";
      let message = `API error (code ${code})`;
      if (apiName.includes("Auth")) {
        message = AUTH_ERRORS[code] ?? message;
      } else {
        message = TASK_ERRORS[code] ?? message;
      }
      if (code === 105 || code === 106) this.sid = null;
      throw new SynologyAPIError(code, message);
    }
    return data.data ?? {};
  }
};
var synoAPI = new SynologyAPI();

// src/storage/settings.ts
var DEFAULTS = {
  nasUrl: "",
  username: "",
  password: "",
  defaultDestination: ""
};
function loadSettings() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(DEFAULTS, (items) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(items);
      }
    });
  });
}
async function isConfigured() {
  const s = await loadSettings();
  return Boolean(s.nasUrl && s.username && s.password);
}

// src/storage/queue.ts
var QUEUE_KEY = "downloadQueue";
function loadQueue() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get({ [QUEUE_KEY]: [] }, (items) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(items[QUEUE_KEY]);
      }
    });
  });
}

// src/popup/popup.ts
var ACTIVE = ["waiting", "downloading", "hash_checking", "extracting", "filehosting_waiting", "finishing", "paused"];
var FINISHED = ["finished", "seeding"];
var ERROR = ["error"];
var POLL_MS = 5e3;
var currentTab = "active";
var allTasks = [];
var pollTimer = null;
var views = {
  unconfigured: document.getElementById("view-unconfigured"),
  loading: document.getElementById("view-loading"),
  error: document.getElementById("view-error"),
  main: document.getElementById("view-main")
};
function show(name) {
  for (const v of Object.values(views)) v.classList.add("hidden");
  views[name].classList.remove("hidden");
}
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmtBytes(n) {
  if (n === 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${u[i]}`;
}
var STATUS_LABEL = {
  waiting: "Waiting",
  downloading: "Downloading",
  paused: "Paused",
  finishing: "Finishing",
  finished: "Finished",
  hash_checking: "Checking",
  seeding: "Seeding",
  filehosting_waiting: "Waiting",
  extracting: "Extracting",
  error: "Error"
};
function progress(task) {
  if (task.status === "finished" || task.status === "seeding") return 100;
  const t = task.additional?.transfer;
  if (!t || task.size === 0) return 0;
  return Math.min(100, Math.round(t.size_downloaded / task.size * 100));
}
function renderTask(task) {
  const pct = progress(task);
  const t = task.additional?.transfer;
  const done = task.status === "finished" || task.status === "seeding";
  const dest = task.additional?.detail?.destination;
  const openable = done && !!dest;
  const canResume = task.status === "paused";
  const canPause = task.status === "downloading" || task.status === "seeding";
  let meta = "";
  if (t) {
    meta = `${fmtBytes(t.size_downloaded)} / ${task.size ? fmtBytes(task.size) : "?"}`;
    if (task.status === "downloading" && t.speed_download > 0)
      meta += ` \xB7 \u2193 ${fmtBytes(t.speed_download)}/s`;
  }
  const el = document.createElement("div");
  el.className = "task-item";
  el.innerHTML = `
    <div class="task-header">
      <span class="task-name${openable ? " task-name--link" : ""}"
            title="${esc(task.title)}${openable ? "\n\u30C0\u30D6\u30EB\u30AF\u30EA\u30C3\u30AF\u3067\u958B\u304F" : ""}"
            ${openable ? `data-dest="${esc(dest)}" data-title="${esc(task.title)}"` : ""}
      >${esc(task.title)}</span>
      <span class="task-status s-${task.status}">${STATUS_LABEL[task.status] ?? task.status}</span>
    </div>
    <div class="progress-bar">
      <div class="progress-fill ${done ? "done" : ""}" style="width:${pct}%"></div>
    </div>
    <div class="task-footer">
      <span class="task-meta">${esc(meta)}</span>
      <div class="task-actions">
        ${canResume ? `<button class="action-btn act-resume" data-id="${esc(task.id)}" title="Resume">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>` : ""}
        ${canPause ? `<button class="action-btn act-pause" data-id="${esc(task.id)}" title="Pause">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
        </button>` : ""}
        <button class="action-btn danger act-delete" data-id="${esc(task.id)}" title="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14H6L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4h6v2"/>
          </svg>
        </button>
      </div>
    </div>
  `;
  return el;
}
function filterTasks(tab) {
  if (tab === "active") return allTasks.filter((t) => ACTIVE.includes(t.status));
  if (tab === "finished") return allTasks.filter((t) => FINISHED.includes(t.status));
  return allTasks.filter((t) => ERROR.includes(t.status));
}
function redraw() {
  const list = document.getElementById("task-list");
  const empty = document.getElementById("empty-msg");
  const tasks = filterTasks(currentTab);
  list.querySelectorAll(".task-item").forEach((e) => e.remove());
  empty.style.display = tasks.length ? "none" : "";
  tasks.forEach((t) => list.appendChild(renderTask(t)));
  setBadge("badge-active", allTasks.filter((t) => ACTIVE.includes(t.status)).length);
  setBadge("badge-finished", allTasks.filter((t) => FINISHED.includes(t.status)).length);
  setBadge("badge-error", allTasks.filter((t) => ERROR.includes(t.status)).length);
  const dl = allTasks.filter((t) => t.status === "downloading");
  const speed = dl.reduce((s, t) => s + (t.additional?.transfer?.speed_download ?? 0), 0);
  const stats = document.getElementById("stats-text");
  stats.textContent = dl.length ? `${dl.length} downloading \xB7 \u2193 ${fmtBytes(speed)}/s` : `${allTasks.length} task${allTasks.length !== 1 ? "s" : ""} total`;
}
function setBadge(id, n) {
  document.getElementById(id).textContent = n > 0 ? String(n) : "";
}
async function updateQueueBanner() {
  const queue = await loadQueue();
  const banner = document.getElementById("queue-banner");
  const text = document.getElementById("queue-banner-text");
  if (queue.length === 0) {
    banner.classList.add("hidden");
  } else {
    text.textContent = `${queue.length} task${queue.length !== 1 ? "s" : ""} queued (offline)`;
    banner.classList.remove("hidden");
  }
}
async function fetchTasks() {
  try {
    const result = await synoAPI.listTasks();
    allTasks = result.tasks ?? [];
    redraw();
  } catch (e) {
    stopPoll();
    document.getElementById("error-msg").textContent = e.message;
    show("error");
  }
}
function startPoll() {
  stopPoll();
  fetchTasks();
  pollTimer = setInterval(fetchTasks, POLL_MS);
}
function stopPoll() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
async function init() {
  if (!await isConfigured()) {
    show("unconfigured");
    return;
  }
  show("loading");
  try {
    const settings = await loadSettings();
    await synoAPI.login({ url: settings.nasUrl, username: settings.username, password: settings.password });
    show("main");
    await updateQueueBanner();
    startPoll();
  } catch (e) {
    document.getElementById("error-msg").textContent = e.message;
    show("error");
    await updateQueueBanner();
    const queue = await loadQueue();
    if (queue.length > 0) {
      show("error");
    }
  }
}
document.getElementById("open-settings-btn").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("settings-btn").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("retry-btn").addEventListener("click", () => init());
document.getElementById("queue-flush-btn").addEventListener("click", async () => {
  const btn = document.getElementById("queue-flush-btn");
  btn.disabled = true;
  btn.textContent = "Sending\u2026";
  try {
    const result = await chrome.runtime.sendMessage({ type: "FLUSH_QUEUE" });
    await updateQueueBanner();
    if (result?.sent > 0) await fetchTasks();
  } catch {
  } finally {
    btn.disabled = false;
    btn.textContent = "Send now";
  }
});
document.getElementById("refresh-btn").addEventListener("click", async () => {
  const btn = document.getElementById("refresh-btn");
  btn.classList.add("spinning");
  await fetchTasks();
  setTimeout(() => btn.classList.remove("spinning"), 600);
});
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    currentTab = tab.dataset["tab"];
    redraw();
  });
});
document.getElementById("task-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button.action-btn");
  if (!btn) return;
  const id = btn.dataset["id"];
  if (!id) return;
  btn.disabled = true;
  try {
    if (btn.classList.contains("act-resume")) {
      await synoAPI.resumeTasks([id]);
    } else if (btn.classList.contains("act-pause")) {
      await synoAPI.pauseTasks([id]);
    } else if (btn.classList.contains("act-delete")) {
      if (!confirm("Delete this download task?")) {
        btn.disabled = false;
        return;
      }
      await synoAPI.deleteTasks([id]);
    }
    await fetchTasks();
  } catch (err) {
    console.error(err.message);
    btn.disabled = false;
  }
});
window.addEventListener("pagehide", stopPoll);
document.getElementById("task-list").addEventListener("dblclick", (e) => {
  const span = e.target.closest("span.task-name--link");
  if (!span) return;
  const dest = span.dataset["dest"];
  const title = span.dataset["title"];
  if (!dest || !title) return;
  const url = synoAPI.fileOpenUrl(dest, title);
  if (url) chrome.downloads.download({ url, filename: title });
});
init();

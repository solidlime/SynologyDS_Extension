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
function saveSettings(settings) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(settings, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

// src/options/options.ts
var nasUrlInput = document.getElementById("nas-url");
var usernameInput = document.getElementById("username");
var passwordInput = document.getElementById("password");
var destInput = document.getElementById("destination");
var testBtn = document.getElementById("test-btn");
var saveBtn = document.getElementById("save-btn");
var statusEl = document.getElementById("status");
var form = document.getElementById("form");
var statusTimer = null;
function setStatus(msg, type) {
  if (statusTimer) clearTimeout(statusTimer);
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
  statusTimer = setTimeout(() => {
    statusEl.className = "status hidden";
  }, type === "error" ? 15e3 : 5e3);
}
async function init() {
  const s = await loadSettings();
  nasUrlInput.value = s.nasUrl;
  usernameInput.value = s.username;
  passwordInput.value = s.password;
  destInput.value = s.defaultDestination;
}
testBtn.addEventListener("click", async () => {
  testBtn.disabled = true;
  testBtn.textContent = "Testing\u2026";
  setStatus("Connecting\u2026", "info");
  const api = new SynologyAPI();
  try {
    await api.login({
      url: nasUrlInput.value.trim(),
      username: usernameInput.value.trim(),
      password: passwordInput.value
    });
    const resolved = api.resolvedUrl;
    const note = resolved !== nasUrlInput.value.trim() ? ` (resolved: ${resolved})` : "";
    await api.logout();
    setStatus(`\u2713 Connection successful!${note}`, "success");
  } catch (e) {
    setStatus(`\u2717 ${e.message}`, "error");
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = "Test Connection";
  }
});
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  saveBtn.disabled = true;
  try {
    await saveSettings({
      nasUrl: nasUrlInput.value.trim(),
      username: usernameInput.value.trim(),
      password: passwordInput.value,
      defaultDestination: destInput.value.trim()
    });
    setStatus("\u2713 Settings saved!", "success");
  } catch (err) {
    setStatus(`\u2717 ${err.message}`, "error");
  } finally {
    saveBtn.disabled = false;
  }
});
init();

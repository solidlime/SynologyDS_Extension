/**
 * Synology DownloadStation API client.
 * Queries SYNO.API.Info on login to discover each API's correct path and
 * maximum supported version — works with DSM 5 / 6 / 7.
 */

import { isQuickConnect, resolveQuickConnect } from './quickconnect.js';
import { pathFor, TASK_API, type ApiInfo } from './paths.js';

export interface DSSettings {
  url: string;
  username: string;
  password: string;
}

export type TaskStatus =
  | 'waiting'
  | 'downloading'
  | 'paused'
  | 'finishing'
  | 'finished'
  | 'hash_checking'
  | 'seeding'
  | 'filehosting_waiting'
  | 'extracting'
  | 'error';

export interface DSTask {
  id: string;
  title: string;
  status: TaskStatus;
  status_extra?: { error_detail?: string };
  size: number;
  additional?: {
    detail?: {
      destination: string;
      uri: string;
      create_time: number;
      priority: string;
    };
    transfer?: {
      size_downloaded: number;
      size_uploaded: number;
      speed_download: number;
      speed_upload: number;
    };
  };
}

export interface DSTaskListResult {
  offset: number;
  tasks: DSTask[];
  total: number;
}

const AUTH_ERRORS: Record<number, string> = {
  400: 'No such account or incorrect password',
  401: 'Account disabled',
  402: 'Permission denied',
  403: 'Two-factor authentication required (not supported)',
  404: 'Failed to authenticate 2FA code',
};

const TASK_ERRORS: Record<number, string> = {
  400: 'File upload failed',
  401: 'Max number of tasks reached',
  402: 'Destination denied',
  403: 'Destination does not exist',
  404: 'Invalid task ID',
  405: 'Invalid task action',
  406: 'No default destination',
  408: 'File does not exist',
};

export class SynologyAPIError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    /** API that produced the error — auth failures are not task rejections. */
    public readonly api: string = '',
  ) {
    super(message);
    this.name = 'SynologyAPIError';
  }

  /** True when DownloadStation itself refused this task (permanent). */
  get isTaskRejection(): boolean {
    return this.api === TASK_API && this.code >= 400 && this.code <= 408;
  }
}

export class SynologyAPI {
  private sid: string | null = null;
  private settings: DSSettings | null = null;
  private baseUrl = '';
  private apiInfo: Record<string, ApiInfo> = {};
  private loginInFlight: Promise<void> | null = null;

  /**
   * @param sessionName - DSM invalidates an existing sid when the same session
   * name logs in again, so each extension context needs its own. Do not share it
   * between the popup, the service worker and the options page.
   */
  constructor(private readonly sessionName = 'DSManager') {}

  get isLoggedIn(): boolean {
    return this.sid !== null;
  }

  /** The resolved URL used for the last login — useful for diagnostics. */
  get resolvedUrl(): string {
    return this.baseUrl;
  }

  // ── API Info discovery ──────────────────────────────────────────────────────

  /**
   * Query SYNO.API.Info to discover correct paths and versions for all needed
   * APIs. On failure the DEFAULT_PATHS / entry.cgi fallbacks in _path() apply.
   */
  private async _discoverApis(): Promise<void> {
    // A previous login's discovery may belong to a different NAS URL.
    this.apiInfo = {};

    const queryUrl =
      `${this.baseUrl}/webapi/query.cgi` +
      `?api=SYNO.API.Info&version=${this.limit()}&method=query` +
      `&query=SYNO.API.Auth,SYNO.DownloadStation.Task,SYNO.FileStation.Download`;
    try {
      const res = await fetch(queryUrl);
      if (!res.ok) {
        console.warn(`[synology] API discovery failed: HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { success: boolean; data?: Record<string, ApiInfo> };
      if (body.success && body.data) {
        this.apiInfo = body.data;
      } else {
        console.warn('[synology] API discovery returned success:false', body);
      }
    } catch (e) {
      console.warn('[synology] API discovery failed:', e);
    }
  }

  /** Cache-buster only; the value is irrelevant as long as it changes per build. */
  private limit(): number {
    return parseInt(chrome.runtime.getManifest().version, 10) || 1;
  }

  /** Return the webapi sub-path for an API, defaulting to entry.cgi. */
  private _path(api: string): string {
    return pathFor(this.apiInfo, api);
  }

  /**
   * Return the best version to use for an API, capped at our own maximum.
   * Falls back to maxSupported if API info is unavailable.
   */
  private _version(api: string, maxSupported: number): string {
    const info = this.apiInfo[api];
    if (!info) return String(maxSupported);
    return String(Math.min(info.maxVersion, maxSupported));
  }

  // ── Auth ────────────────────────────────────────────────────────────────────

  async login(settings: DSSettings): Promise<void> {
    // Concurrent 105 retries (popup poll + user action) would log in twice and
    // each new sid invalidates the other, so they share one login.
    // Known limitation: a caller holding different settings reuses the in-flight
    // session (and its baseUrl) instead of logging in again. No caller does that today.
    this.loginInFlight ??= this._login(settings).finally(() => { this.loginInFlight = null; });
    return this.loginInFlight;
  }

  private async _login(settings: DSSettings): Promise<void> {
    this.settings = settings;
    let url = settings.url.trim().replace(/\/$/, '');

    if (isQuickConnect(url)) {
      url = await resolveQuickConnect(url);
    } else if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`;
    }

    this.baseUrl = url;

    // Discover API paths/versions before any other call
    await this._discoverApis();

    const params = new URLSearchParams({
      api: 'SYNO.API.Auth',
      version: this._version('SYNO.API.Auth', 7),
      method: 'login',
      account: settings.username,
      passwd: settings.password,
      session: this.sessionName,
      format: 'sid',
    });
    const data = await this._request('SYNO.API.Auth', params, false);
    this.sid = data.sid as string;
  }

  async logout(): Promise<void> {
    if (!this.sid) return;
    try {
      await this._request(
        'SYNO.API.Auth',
        new URLSearchParams({
          api: 'SYNO.API.Auth',
          version: this._version('SYNO.API.Auth', 7),
          method: 'logout',
          session: this.sessionName,
        }),
        // retried=true: never re-login from logout — that would leave an orphan session
        true,
        true,
      );
    } catch (e) {
      // Best effort: the local sid is dropped either way, and a failed logout
      // must not be reported as a failed connection.
      console.warn('[synology] logout failed:', e);
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
  fileOpenUrl(destination: string, filename: string): string | null {
    if (!this.sid) return null;
    // Ensure destination has a leading slash (DSM task destinations may omit it)
    const dest = destination.startsWith('/') ? destination : `/${destination}`;
    const path = `${dest.replace(/\/$/, '')}/${filename}`;
    const fsApi = 'SYNO.FileStation.Download';
    const params = new URLSearchParams({
      api: fsApi,
      version: this._version(fsApi, 2),
      method: 'download',
      path,
      mode: 'open',
      _sid: this.sid,
    });
    return `${this.baseUrl}/webapi/${this._path(fsApi)}?${params.toString()}`;
  }

  // ── Download Station tasks ──────────────────────────────────────────────────

  async listTasks(offset = 0, limit = 200): Promise<DSTaskListResult> {
    return this._task({ method: 'list', offset: String(offset), limit: String(limit), additional: 'detail,transfer' }) as Promise<DSTaskListResult>;
  }

  async createTask(uri: string, destination?: string): Promise<void> {
    const p: Record<string, string> = { method: 'create', uri };
    if (destination) p['destination'] = destination;
    await this._task(p);
  }

  async resumeTasks(ids: string[]): Promise<void> {
    await this._task({ method: 'resume', id: ids.join(',') });
  }

  async pauseTasks(ids: string[]): Promise<void> {
    await this._task({ method: 'pause', id: ids.join(',') });
  }

  async deleteTasks(ids: string[], forceComplete = false): Promise<void> {
    await this._task({ method: 'delete', id: ids.join(','), force_complete: String(forceComplete) });
  }

  private async _task(params: Record<string, string>): Promise<unknown> {
    const api = TASK_API;
    return this._request(
      api,
      new URLSearchParams({ api, version: this._version(api, 3), ...params }),
      true,
    );
  }

  // ── HTTP transport ──────────────────────────────────────────────────────────

  private async _request(api: string, params: URLSearchParams, authenticated: boolean, retried = false): Promise<Record<string, unknown>> {
    const usedSid = this.sid;
    if (authenticated) {
      if (!usedSid) throw new SynologyAPIError(0, 'Not authenticated — please check NAS settings.', 'SYNO.API.Auth');
      params.set('_sid', usedSid);
    }

    const endpoint = `${this.baseUrl}/webapi/${this._path(api)}`;
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
    } catch (e) {
      const raw = (e as Error).message;
      const isHttps = this.baseUrl.startsWith('https://');
      if (raw === 'Failed to fetch' || raw.includes('ERR_')) {
        const hint = isHttps
          ? ' If using HTTPS with a self-signed cert, open the NAS URL in Chrome and accept the certificate first.'
          : ' Check that the NAS is reachable and the port is correct.';
        throw new Error(`Cannot reach ${this.baseUrl}.${hint}`);
      }
      throw new Error(`Network error (${this.baseUrl}): ${raw}`);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${this.baseUrl}: ${response.statusText}`);
    }

    let data: { success: boolean; data?: Record<string, unknown>; error?: { code: number } };
    try {
      data = await response.json() as typeof data;
    } catch {
      throw new Error(`Invalid response from ${this.baseUrl} — is this a Synology NAS?`);
    }

    if (!data.success) {
      const code = data.error?.code ?? -1;
      const apiName = params.get('api') ?? '';
      // Unknown codes: expose which API/path was called so 102-style path bugs are visible
      const known = apiName === 'SYNO.API.Auth' ? AUTH_ERRORS[code]
        : apiName === TASK_API ? TASK_ERRORS[code]
        : undefined;
      const message = known ?? `API error (code ${code}) — ${apiName} via ${this._path(apiName)}`;
      // Session expired — retry once with a fresh login
      if (code === 105 || code === 106 || code === 107 || code === 119) {
        // Only drop the sid this request was sent with. A late response for an old
        // sid must not invalidate the one a concurrent retry just obtained.
        if (this.sid === usedSid) this.sid = null;
        if (authenticated && !retried && this.settings) {
          // Someone else may have refreshed already — re-login only if we have none,
          // otherwise a second login would kill the sid they are using.
          if (!this.sid) await this.login(this.settings);
          const sid = this.sid;
          if (!sid) throw new SynologyAPIError(0, 'Not authenticated — please check NAS settings.', 'SYNO.API.Auth');
          params.set('_sid', sid);
          return this._request(api, params, authenticated, true);
        }
      }
      throw new SynologyAPIError(code, message, params.get('api') ?? '');
    }

    return (data.data ?? {}) as Record<string, unknown>;
  }
}

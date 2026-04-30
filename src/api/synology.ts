/**
 * Synology DownloadStation API client.
 * Queries SYNO.API.Info on login to discover each API's correct path and
 * maximum supported version — works with DSM 5 / 6 / 7.
 */

import { isQuickConnect, resolveQuickConnect } from './quickconnect.js';

interface ApiInfo {
  path: string;
  maxVersion: number;
  minVersion: number;
}

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
  ) {
    super(message);
    this.name = 'SynologyAPIError';
  }
}

export class SynologyAPI {
  private sid: string | null = null;
  private baseUrl = '';
  private apiInfo: Record<string, ApiInfo> = {};

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
   * APIs. Falls back silently — callers then use entry.cgi as default.
   */
  private async _discoverApis(): Promise<void> {
    const queryUrl =
      `${this.baseUrl}/webapi/query.cgi` +
      `?api=SYNO.API.Info&version=1&method=query` +
      `&query=SYNO.API.Auth,SYNO.DownloadStation.Task,SYNO.FileStation.Download`;
    try {
      const res = await fetch(queryUrl);
      if (!res.ok) return;
      const body = (await res.json()) as { success: boolean; data?: Record<string, ApiInfo> };
      if (body.success && body.data) {
        this.apiInfo = body.data;
      }
    } catch {
      // Non-fatal: fall back to entry.cgi defaults
    }
  }

  /** Return the webapi sub-path for an API, defaulting to entry.cgi. */
  private _path(api: string): string {
    return this.apiInfo[api]?.path ?? 'entry.cgi';
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
      session: 'DownloadStation',
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
          session: 'DownloadStation',
        }),
        true,
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
  fileOpenUrl(destination: string, filename: string): string | null {
    if (!this.sid) return null;
    const path = `${destination.replace(/\/$/, '')}/${filename}`;
    const fsApi = 'SYNO.FileStation.Download';
    const params = new URLSearchParams({
      api: fsApi,
      version: this._version(fsApi, 2),
      method: 'download',
      path: path,
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
    const api = 'SYNO.DownloadStation.Task';
    return this._request(
      api,
      new URLSearchParams({ api, version: this._version(api, 3), ...params }),
      true,
    );
  }

  // ── HTTP transport ──────────────────────────────────────────────────────────

  private async _request(api: string, params: URLSearchParams, authenticated: boolean): Promise<Record<string, unknown>> {
    if (authenticated) {
      if (!this.sid) throw new SynologyAPIError(0, 'Not authenticated — please check NAS settings.');
      params.set('_sid', this.sid);
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
      let message = `API error (code ${code})`;
      if (apiName.includes('Auth')) {
        message = AUTH_ERRORS[code] ?? message;
      } else {
        message = TASK_ERRORS[code] ?? message;
      }
      // Session expired — clear sid so next call triggers re-login
      if (code === 105 || code === 106) this.sid = null;
      throw new SynologyAPIError(code, message);
    }

    return (data.data ?? {}) as Record<string, unknown>;
  }
}

export const synoAPI = new SynologyAPI();

/**
 * Synology DownloadStation API client.
 * Targets DSM 7.x — SYNO.API.Auth v7, SYNO.DownloadStation.Task v3.
 */

import { isQuickConnect, resolveQuickConnect } from './quickconnect.js';

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

  get isLoggedIn(): boolean {
    return this.sid !== null;
  }

  async login(settings: DSSettings): Promise<void> {
    let url = settings.url.trim().replace(/\/$/, '');

    if (isQuickConnect(url)) {
      url = await resolveQuickConnect(url);
    } else if (!url.startsWith('http://') && !url.startsWith('https://')) {
      // No scheme provided — default to HTTPS
      url = `https://${url}`;
    }

    this.baseUrl = url;
    const params = new URLSearchParams({
      api: 'SYNO.API.Auth',
      version: '7',
      method: 'login',
      account: settings.username,
      passwd: settings.password,
      session: 'DownloadStation',
      format: 'sid',
    });
    const data = await this._request(params, false);
    this.sid = data.sid as string;
  }

  async logout(): Promise<void> {
    if (!this.sid) return;
    try {
      await this._request(
        new URLSearchParams({
          api: 'SYNO.API.Auth',
          version: '7',
          method: 'logout',
          session: 'DownloadStation',
        }),
        true,
      );
    } finally {
      this.sid = null;
    }
  }

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
    return this._request(
      new URLSearchParams({ api: 'SYNO.DownloadStation.Task', version: '3', ...params }),
      true,
    );
  }

  private async _request(params: URLSearchParams, authenticated: boolean): Promise<Record<string, unknown>> {
    if (authenticated) {
      if (!this.sid) throw new SynologyAPIError(0, 'Not authenticated — please check NAS settings.');
      params.set('_sid', this.sid);
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/webapi/entry.cgi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
    } catch (e) {
      throw new Error(`Network error: ${(e as Error).message}. Check NAS URL and network connection.`);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    let data: { success: boolean; data?: Record<string, unknown>; error?: { code: number } };
    try {
      data = await response.json() as typeof data;
    } catch {
      throw new Error('Invalid JSON response from NAS.');
    }

    if (!data.success) {
      const code = data.error?.code ?? -1;
      const api = params.get('api') ?? '';
      let message = `API error (code ${code})`;
      if (api.includes('Auth')) {
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

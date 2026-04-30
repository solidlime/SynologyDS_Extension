/**
 * Synology QuickConnect resolver.
 *
 * Supported input formats:
 *   - Bare server ID           : "solidlime"
 *   - quickconnect.to URL      : "quickconnect.to/solidlime"
 *   - Direct QC hostname       : "solidlime.direct.quickconnect.to"
 *   - Any *.quickconnect.to URL: "solidlime.cn2.quickconnect.to"
 */

const QC_SERV_URL = 'https://global.quickconnect.to/Serv.php';

interface QCResponse {
  errno: number;
  server?: {
    ddns?: string;
    fqdn?: string;
    external?: { ip?: string };
    serverID?: string;
  };
  env?: {
    control_host?: string;
  };
  service?: {
    port?: number;
  };
}

/**
 * Returns true if the input should be handled as QuickConnect
 * rather than as a plain HTTP/HTTPS URL.
 */
export function isQuickConnect(input: string): boolean {
  const s = input.trim().toLowerCase();
  const noScheme = s.replace(/^https?:\/\//, '');

  // Already a *.quickconnect.to domain (e.g. solidlime.direct.quickconnect.to)
  if (noScheme.includes('.quickconnect.to')) return true;

  // quickconnect.to/id format
  if (noScheme.startsWith('quickconnect.to/')) return true;

  // Has an explicit http/https scheme → treat as direct URL
  if (s.startsWith('http://') || s.startsWith('https://')) return false;

  // host:port pattern (e.g. "nas:5000", "192.168.1.100:5001") → direct URL
  if (/^[\w.-]+:\d+/.test(s)) return false;

  // Contains a dot but no scheme/port → hostname (e.g. "mynas.local") → direct URL
  if (s.includes('.')) return false;

  // No dots, no port, no scheme → bare QuickConnect ID (e.g. "solidlime")
  return true;
}

/**
 * Resolves a QuickConnect input to an https:// URL.
 * - *.quickconnect.to hostnames are returned with https:// prepended.
 * - Bare IDs / quickconnect.to/id are resolved via the Synology relay API.
 */
export async function resolveQuickConnect(input: string): Promise<string> {
  const s = input.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');

  // Already a direct QC hostname → no API call needed
  if (s.toLowerCase().includes('.quickconnect.to')) {
    return `https://${s}`;
  }

  // Extract bare server ID
  const serverID = s.replace(/^(?:www\.)?quickconnect\.to\//i, '');

  return _resolveServerID(serverID);
}

async function _resolveServerID(serverID: string): Promise<string> {
  let resp: Response;
  try {
    resp = await fetch(QC_SERV_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        command: 'get_server_info',
        stop_when_error: false,
        stop_when_success: true,
        id: 'mobilestation',
        serverID,
        is_gofile: false,
      }),
    });
  } catch (e) {
    throw new Error(`QuickConnect lookup failed: ${(e as Error).message}`);
  }

  if (!resp.ok) {
    throw new Error(`QuickConnect lookup failed: HTTP ${resp.status}`);
  }

  const data = await resp.json() as QCResponse;

  if (data.errno !== 0) {
    throw new Error(`QuickConnect: server ID "${serverID}" not found (errno ${data.errno})`);
  }

  const port = data.service?.port ?? 5001;

  // Priority: external IP → DDNS → FQDN → relay subdomain
  const ext = data.server?.external?.ip;
  if (ext) return `https://${ext}:${port}`;

  const ddns = data.server?.ddns;
  if (ddns && ddns !== 'NULL') return `https://${ddns}:${port}`;

  const fqdn = data.server?.fqdn;
  if (fqdn && fqdn !== 'NULL') return `https://${fqdn}:${port}`;

  const controlHost = data.env?.control_host;
  const sid = data.server?.serverID ?? serverID;
  if (controlHost) return `https://${sid}.${controlHost}`;

  throw new Error(`QuickConnect: could not resolve a URL for server ID "${serverID}"`);
}

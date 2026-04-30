import { synoAPI } from '../api/synology.js';
import { loadSettings } from '../storage/settings.js';
import { enqueueTask, loadQueue, dequeueTask } from '../storage/queue.js';

const MENU_LINK      = 'ds-send-link';
const MENU_PAGE      = 'ds-send-page';
const MENU_SELECTION = 'ds-send-selection';

chrome.runtime.onInstalled.addListener(() => {
  registerMenus();
});

chrome.runtime.onStartup.addListener(async () => {
  registerMenus();
  await flushQueue();
});

// Also handle ADD_TASK messages from popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'FLUSH_QUEUE') {
    flushQueue().then(result => sendResponse(result)).catch(err => sendResponse({ error: (err as Error).message }));
    return true;
  }
  if (msg?.type === 'ADD_TASK' && typeof msg.url === 'string') {
    handleAddTask(msg.url).then(result => sendResponse(result)).catch(err => sendResponse({ success: false, error: (err as Error).message }));
    return true;
  }
});

function registerMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_LINK,      title: 'Send to DownloadStation',              contexts: ['link'] });
    chrome.contextMenus.create({ id: MENU_PAGE,      title: 'Send page URL to DownloadStation',     contexts: ['page'] });
    chrome.contextMenus.create({ id: MENU_SELECTION, title: 'Send "%s" to DownloadStation',         contexts: ['selection'] });
  });
}

function isValidUri(text: string): boolean {
  return /^https?:\/\//i.test(text) || /^ftp:\/\//i.test(text) || /^magnet:/i.test(text);
}

/** Try to send a URL to DownloadStation. Returns true on success. */
async function trySend(url: string, destination?: string): Promise<boolean> {
  const settings = await loadSettings();
  if (!settings.nasUrl || !settings.username || !settings.password) return false;

  if (!synoAPI.isLoggedIn) {
    await synoAPI.login({ url: settings.nasUrl, username: settings.username, password: settings.password });
  }
  await synoAPI.createTask(url, destination || settings.defaultDestination || undefined);
  return true;
}

/**
 * Flush all queued tasks to DownloadStation.
 * Returns { sent, failed } counts.
 */
export async function flushQueue(): Promise<{ sent: number; failed: number }> {
  const queue = await loadQueue();
  if (queue.length === 0) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  for (const task of queue) {
    try {
      await trySend(task.uri, task.destination);
      await dequeueTask(task.id);
      sent++;
    } catch {
      failed++;
      // Stop processing on first failure — NAS likely still unreachable
      break;
    }
  }

  if (sent > 0) {
    const remaining = (await loadQueue()).length;
    const msg = remaining > 0
      ? `Sent ${sent} queued task${sent !== 1 ? 's' : ''}. ${remaining} remaining.`
      : `All ${sent} queued task${sent !== 1 ? 's' : ''} sent successfully.`;
    notify('Queue flushed', msg);
  }

  return { sent, failed };
}

/**
 * Add a task from popup. Returns { success, queued } or throws.
 */
async function handleAddTask(url: string): Promise<{ success: boolean; queued?: boolean }> {
  const settings = await loadSettings();
  if (!settings.nasUrl || !settings.username || !settings.password) {
    return { success: false };
  }
  try {
    await trySend(url, settings.defaultDestination || undefined);
    return { success: true, queued: false };
  } catch {
    await enqueueTask(url, settings.defaultDestination || undefined);
    return { success: true, queued: true };
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let url: string | undefined;

  if (info.menuItemId === MENU_SELECTION) {
    const text = info.selectionText?.trim() ?? '';
    if (!isValidUri(text)) {
      notify('Error', 'Selected text is not a valid URL or magnet link.');
      return;
    }
    url = text;
  } else {
    url = info.linkUrl ?? info.pageUrl ?? tab?.url;
  }
  if (!url) {
    notify('Error', 'Could not determine URL from context menu.');
    return;
  }

  const settings = await loadSettings();
  if (!settings.nasUrl || !settings.username || !settings.password) {
    notify('Not configured', 'Open the extension settings to configure your NAS.');
    chrome.runtime.openOptionsPage();
    return;
  }

  try {
    await trySend(url, settings.defaultDestination || undefined);
    notify('Task added', clip(url, 80));
  } catch (err) {
    // Re-authenticate once on session expiry, then retry
    if (!synoAPI.isLoggedIn) {
      try {
        const s = await loadSettings();
        await synoAPI.login({ url: s.nasUrl, username: s.username, password: s.password });
        await synoAPI.createTask(url, s.defaultDestination || undefined);
        notify('Task added', clip(url, 80));
        return;
      } catch {
        // fall through to queue
      }
    }

    // NAS unreachable — add to offline queue
    const queued = await enqueueTask(url, settings.defaultDestination || undefined);
    const queue = await loadQueue();
    notify(
      'Queued (offline)',
      `NAS unreachable. Task queued (#${queue.length}). It will be sent when you reconnect.\n${clip(queued.uri, 60)}`,
    );
  }
});

function notify(title: string, message: string): void {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon48.png'),
    title: `DS Manager — ${title}`,
    message,
  });
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

import { synoAPI } from '../api/synology.js';
import { loadSettings } from '../storage/settings.js';

const MENU_LINK = 'ds-send-link';
const MENU_PAGE = 'ds-send-page';

chrome.runtime.onInstalled.addListener(() => {
  registerMenus();
});

chrome.runtime.onStartup.addListener(() => {
  registerMenus();
});

function registerMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_LINK, title: 'Send to DownloadStation', contexts: ['link'] });
    chrome.contextMenus.create({ id: MENU_PAGE, title: 'Send page URL to DownloadStation', contexts: ['page'] });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.linkUrl ?? info.pageUrl ?? tab?.url;
  if (!url) {
    notify('Error', 'Could not determine URL from context menu.');
    return;
  }

  try {
    const settings = await loadSettings();
    if (!settings.nasUrl || !settings.username || !settings.password) {
      notify('Not configured', 'Open the extension settings to configure your NAS.');
      chrome.runtime.openOptionsPage();
      return;
    }

    if (!synoAPI.isLoggedIn) {
      await synoAPI.login({ url: settings.nasUrl, username: settings.username, password: settings.password });
    }

    await synoAPI.createTask(url, settings.defaultDestination || undefined);
    notify('Task added', clip(url, 80));
  } catch (err) {
    const e = err as Error;
    // Re-authenticate once if session expired
    if (!synoAPI.isLoggedIn) {
      try {
        const s = await loadSettings();
        await synoAPI.login({ url: s.nasUrl, username: s.username, password: s.password });
        await synoAPI.createTask(url);
        notify('Task added', clip(url, 80));
        return;
      } catch (e2) {
        notify('Error', (e2 as Error).message);
        return;
      }
    }
    notify('Error', e.message);
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

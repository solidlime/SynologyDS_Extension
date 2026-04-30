export interface Settings {
  nasUrl: string;
  username: string;
  password: string;
  defaultDestination: string;
}

const DEFAULTS: Settings = {
  nasUrl: '',
  username: '',
  password: '',
  defaultDestination: '',
};

export function loadSettings(): Promise<Settings> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(DEFAULTS, items => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(items as Settings);
      }
    });
  });
}

export function saveSettings(settings: Partial<Settings>): Promise<void> {
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

export async function isConfigured(): Promise<boolean> {
  const s = await loadSettings();
  return Boolean(s.nasUrl && s.username && s.password);
}

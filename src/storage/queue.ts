/**
 * Offline download queue — tasks queued when the NAS is unreachable.
 * Stored in chrome.storage.local under the key "downloadQueue".
 */

export interface QueuedTask {
  id: string;
  uri: string;
  destination?: string;
  addedAt: number;
}

const QUEUE_KEY = 'downloadQueue';

// Serialize read-modify-write cycles so concurrent callers can't drop updates.
let chain: Promise<unknown> = Promise.resolve();

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

export function loadQueue(): Promise<QueuedTask[]> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get({ [QUEUE_KEY]: [] }, items => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(items[QUEUE_KEY] as QueuedTask[]);
      }
    });
  });
}

export function enqueueTask(uri: string, destination?: string): Promise<QueuedTask> {
  return serial(async () => {
    const queue = await loadQueue();
    const task: QueuedTask = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      uri,
      destination,
      addedAt: Date.now(),
    };
    queue.push(task);
    await saveQueue(queue);
    return task;
  });
}

export function dequeueTask(id: string): Promise<void> {
  return serial(async () => {
    const queue = await loadQueue();
    await saveQueue(queue.filter(t => t.id !== id));
  });
}

export function clearQueue(): Promise<void> {
  return serial(async () => {
    await saveQueue([]);
  });
}

function saveQueue(queue: QueuedTask[]): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [QUEUE_KEY]: queue }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

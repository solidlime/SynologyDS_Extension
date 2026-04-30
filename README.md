# Synology DownloadStation Chrome Extension

A Chrome extension (Manifest V3) to manage your Synology DownloadStation from the browser.

## Features

- **Right-click → "Send to DownloadStation"** — Add any link or page URL as a download task
- **Toolbar popup** — View active/finished/error tasks with real-time progress bars; pause, resume, or delete tasks
- **File open** — Double-click a finished task's filename to download it directly to your browser
- **Offline queue** — Tasks sent while the NAS is unreachable are queued locally and flushed automatically on reconnect (or manually via the popup banner)
- **QuickConnect & HTTP support** — Connect using a QuickConnect ID, direct QuickConnect URL, plain HTTP, or standard HTTPS
- **Auto API discovery** — Queries `SYNO.API.Info` on login to find the correct endpoint path and version for each API (compatible with DSM 5 / 6 / 7)
- **Options page** — Configure NAS URL, credentials, and default download destination

## Prerequisites

- Synology NAS with **DSM 6.x or 7.x**
- DownloadStation package installed and enabled
- Node.js 18+ and npm
- Chrome (or any Chromium-based browser)

## Setup

### 1. Install & Build

```bash
npm install
npm run build
```

### 2. Load in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **"Load unpacked"**
4. Select the `dist/` folder

### 3. Configure

Click the extension icon → **⚙ Settings** and enter:

| Field | Example |
|---|---|
| NAS URL | `https://192.168.1.100:5001` |
| Username | `admin` |
| Password | your password |
| Default Destination | `/downloads` *(optional)* |

#### Supported URL formats

| Type | Example |
|---|---|
| HTTPS | `https://192.168.1.100:5001` |
| HTTP | `http://nas:5000` |
| QuickConnect direct | `solidlime.direct.quickconnect.to` |
| QuickConnect ID | `solidlime` or `quickconnect.to/solidlime` |

## Self-Signed Certificates

If your NAS uses a self-signed SSL certificate, you may see a network error. To fix:

1. Open your NAS URL in Chrome (e.g. `https://192.168.1.100:5001`)
2. Click **Advanced → Proceed anyway** to trust the certificate
3. The extension will now be able to connect

HTTP connections (`http://`) do not require any certificate setup.

## Offline Queue

When the NAS is unreachable (network down, NAS sleeping, etc.), any URL you right-click and send will be saved in an **offline queue** stored in `chrome.storage.local`.

The queue is flushed automatically on browser startup. If the popup is open and the NAS comes back online, a **yellow banner** appears with a **"Send now"** button to flush all queued tasks immediately.

Queued tasks are never lost — they persist until successfully sent to DownloadStation.

## Downloading Files

In the popup's **Finished** tab, filenames appear as clickable links.  
**Double-click** a filename to download it directly to your browser's default downloads folder.

## Development

```bash
npm run build         # Full build (icons + TypeScript)
npm run build:watch   # Auto-rebuild on file changes
npm run typecheck     # TypeScript type-check only (tsc --noEmit)
npm run clean         # Remove dist/
```

Chrome loads the extension from the **`dist/`** directory. Reload it after each build in `chrome://extensions/`.

## Tech Stack

- TypeScript + esbuild (Manifest V3)
- Synology WebAPI — auto-discovered via `SYNO.API.Info` at login
  - `SYNO.API.Auth v3–v7`
  - `SYNO.DownloadStation.Task v1–v3`
  - `SYNO.FileStation.Download v2`
- `chrome.storage.local` for settings and offline queue persistence
- `chrome.downloads` API for in-browser file downloads

## Notes

- 2FA (OTP) is not supported. Disable 2FA for the account used by this extension.
- Passwords are stored in `chrome.storage.local` (unencrypted, local to your Chrome profile).
- The `client/` directory is a local convenience copy of `dist/` and is not tracked by Git.

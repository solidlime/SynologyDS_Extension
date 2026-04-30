# Synology DownloadStation Chrome Extension

A Chrome extension (Manifest V3) to manage your Synology DownloadStation from the browser.

## Features

- **Right-click → "Send to DownloadStation"** — Add any link or page URL as a download task
- **Toolbar popup** — View active/finished tasks, start/pause/delete with real-time progress bars
- **Options page** — Configure NAS URL, credentials, and default download destination

## Prerequisites

- Synology NAS with **DSM 7.x**
- DownloadStation package installed and enabled
- Node.js 18+ and npm
- Chrome browser

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

Click the extension icon in the toolbar → **⚙ Settings** and enter:

| Field | Example |
|---|---|
| NAS URL | `https://192.168.1.100:5001` |
| Username | `admin` |
| Password | your password |
| Default Destination | `/downloads` *(optional)* |

## Self-Signed Certificates

If your NAS uses a self-signed SSL certificate, you may see a network error. To fix:

1. Open your NAS URL in Chrome (e.g. `https://192.168.1.100:5001`)
2. Click **Advanced → Proceed anyway** to trust the certificate
3. The extension will now be able to connect

## Development

```bash
npm run build         # Full build (icons + TypeScript)
npm run build:watch   # Auto-rebuild on file changes
npm run clean         # Remove dist/
```

Chrome loads the extension from the **`dist/`** directory. Reload it after each build in `chrome://extensions/`.

## Tech Stack

- TypeScript + esbuild (Manifest V3)
- Synology SYNO.API — DSM 7.x (`SYNO.API.Auth v7`, `SYNO.DownloadStation.Task v3`)

## Notes

- 2FA (OTP) is not supported. Disable 2FA for the account used by this extension.
- Passwords are stored in `chrome.storage.local` (unencrypted, local to your Chrome profile).

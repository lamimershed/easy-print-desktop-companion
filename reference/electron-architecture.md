# Production-Grade Electron Architecture

## Recommended Tech Stack

| Layer                | Technology                 | Why                                        |
| -------------------- | -------------------------- | ------------------------------------------ |
| **Build Tool**       | Vite                       | Fast HMR, native ESM, excellent DX         |
| **UI Framework**     | React (or Vue/Svelte)      | Component-based, large ecosystem           |
| **Styling**          | Tailwind CSS               | Utility-first, optimized production builds |
| **Electron Builder** | electron-builder           | Cross-platform packaging, auto-updates     |
| **IPC Type Safety**  | electron-trpc or typed-ipc | Type-safe main↔renderer communication      |
| **State Management** | Zustand or Jotai           | Lightweight, works well with Electron      |
| **Testing**          | Vitest + Playwright        | Fast unit tests + E2E for Electron         |

---

## Production Architecture

```
cafe-app/
├── electron/
│   ├── main.ts              # Main process entry
│   ├── preload.ts           # Preload scripts
│   └── services/
│       ├── printer.ts       # Printer service
│       └── ipc-handlers.ts  # IPC handlers
├── src/
│   ├── main.tsx             # React entry
│   ├── App.tsx
│   ├── components/
│   │   └── ui/              # Reusable UI components
│   ├── features/
│   │   └── print/           # Feature modules
│   ├── hooks/               # Custom hooks
│   ├── stores/              # Zustand stores
│   └── lib/
│       └── electron-api.ts  # Typed IPC calls
├── electron-builder.yml     # Build config
├── vite.config.ts
├── tailwind.config.js
└── tsconfig.json
```

---

## Electron Shell Architecture (Hybrid)

### Concept

```
┌─────────────────────────────────────────────┐
│  Electron Shell (Native Features)           │
│  ┌───────────────────────────────────────┐  │
│  │  WebView / BrowserView                │  │
│  │  ┌─────────────────────────────────┐  │  │
│  │  │  Your Hosted Web App            │  │  │
│  │  │  (Login, Dashboard, etc.)       │  │  │
│  │  └─────────────────────────────────┘  │  │
│  └───────────────────────────────────────┘  │
│  Native: Printing, File System, Tray, etc.  │
└─────────────────────────────────────────────┘
```

### Shell + Remote Architecture

```
cafe-app/
├── electron/
│   ├── main.ts           # Shell + native features
│   ├── preload.ts        # Bridge to web app
│   └── services/
│       ├── printer.ts    # Native printing
│       └── auth-bridge.ts # Pass auth to web app
├── src/                  # Minimal local UI (optional)
│   └── offline.html      # Offline fallback
└── config.ts             # Web app URL configuration
```

---

## Two Main Approaches

### 1. Remote URL Loading (Simplest)

Electron loads your hosted web app directly:

```js
// main.js
mainWindow.loadURL("https://your-app.com");
// For local dev: mainWindow.loadURL('http://localhost:3000');
```

**Pros:**

- Single codebase for web + desktop
- Updates are instant (no app update needed)
- Users can also access via browser

**Cons:**

- Requires internet connection
- Limited native API access from remote content (security restrictions)

### 2. Hybrid: Shell + Embedded Web (Recommended)

**Example Implementation:**

```js
// main.js
const { app, BrowserWindow, ipcMain } = require("electron");

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });

  // Load your hosted web app
  const WEB_APP_URL =
    process.env.NODE_ENV === "development"
      ? "http://localhost:3000"
      : "https://cafe.yourcompany.com";

  mainWindow.loadURL(WEB_APP_URL);

  // Expose native features to your web app via IPC
  ipcMain.handle("native:print", async (_, data) => {
    return printService.print(data);
  });

  ipcMain.handle("native:get-printers", async () => {
    return mainWindow.webContents.getPrintersAsync();
  });
}
```

**In your web app (React/Next.js/etc.):**

```js
// Check if running in Electron
const isElectron = () => window.electronAPI !== undefined;

// Use native printing when in Electron, fallback to browser print
async function printReceipt(data) {
  if (isElectron()) {
    await window.electronAPI.print(data);
  } else {
    window.print(); // Browser fallback
  }
}
```

---

## Communication Patterns

| Pattern                         | Use Case                                        |
| ------------------------------- | ----------------------------------------------- |
| `postMessage`                   | Web app → Electron (via preload)                |
| `ipcRenderer.invoke`            | Request/response to main process                |
| `webContents.executeJavaScript` | Electron → inject data into web app             |
| Deep links / Custom protocol    | External triggers (e.g., `cafe://print?id=123`) |

---

## Real-World Examples

| App                 | Architecture                                  | Users         |
| ------------------- | --------------------------------------------- | ------------- |
| **Slack**           | Electron + hosted web app                     | 30M+ daily    |
| **Discord**         | Electron shell + React web app                | 150M+ monthly |
| **Figma Desktop**   | Electron loading figma.com                    | 4M+ users     |
| **Notion**          | Electron + web app                            | 30M+ users    |
| **Microsoft Teams** | Electron (moving to Edge WebView2)            | 300M+ users   |
| **VS Code**         | Electron + local bundled app                  | 30M+ users    |
| **Spotify Desktop** | Chromium Embedded Framework (similar pattern) | 500M+ users   |

---

## Production Patterns

### Pattern A: Shell + Remote (Slack, Figma, Discord)

- Electron loads hosted URL
- Native features via IPC bridge
- **Pros**: Instant updates, one codebase
- **Cons**: Needs internet, slight latency

### Pattern B: Bundled (VS Code, Obsidian)

- Web app bundled inside Electron
- **Pros**: Works offline, faster startup
- **Cons**: Requires app updates for changes

---

## Production-Grade Features Checklist

| Feature                | Why                                     | Tool/Library                                |
| ---------------------- | --------------------------------------- | ------------------------------------------- |
| **Auto-updates**       | Push fixes without reinstall            | electron-updater                            |
| **Code signing**       | Required for macOS/Windows distribution | electron-builder                            |
| **Crash reporting**    | Debug production issues                 | Sentry, Crashlytics                         |
| **Offline handling**   | Graceful degradation                    | Service workers, local queue                |
| **Security hardening** | Prevent XSS, injection                  | CSP headers, context isolation              |
| **Logging**            | Debugging production issues             | electron-log                                |
| **CI/CD pipeline**     | Automated builds                        | GitHub Actions → build → notarize → release |

---

## Starter Templates

- **[electron-vite](https://electron-vite.org/)** — Official Vite plugin for Electron (recommended)
- **[electron-react-boilerplate](https://github.com/electron-react-boilerplate/electron-react-boilerplate)** — Mature, feature-rich

---

## Cafe App Recommendation

For a cafe printing app:

1. **Web App** (separate repo): Login, orders, dashboard — deploy to Vercel/Railway
2. **Electron Shell** (this repo):
   - Load web app URL
   - Handle native printing (silent, thermal printers)
   - Offline receipt queue
   - System tray for quick actions

### Assessment

- ✅ **Proven** — used by billion-dollar companies
- ✅ **Right fit** — you need native printing, web handles UI
- ✅ **Maintainable** — separate concerns cleanly
- ⚠️ **Overkill if** — you only need printing and nothing else

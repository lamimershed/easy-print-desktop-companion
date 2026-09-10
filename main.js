const { app, BrowserWindow, ipcMain, powerMonitor } = require("electron");

// A packaged build reads .env.production — the only env file electron-builder
// bundles. Dev reads .env, which stays untracked and points at whatever machine
// you are working on. Shipping .env instead was how installed copies ended up
// loading http://localhost:5175 on the customer's own machine.
require("dotenv").config({
  path: require("path").join(__dirname, app.isPackaged ? ".env.production" : ".env"),
});

const path = require("path");
const { existsSync } = require("fs");
const { writeFile, unlink } = require("fs/promises");
const { exec, execFile } = require("child_process");
const { promisify } = require("util");
const { tmpdir } = require("os");

const execFileAsync = promisify(execFile);

const execAsync = promisify(exec);

const IS_WINDOWS = process.platform === "win32";

const WEB_APP_URL = process.env.WEB_APP_URL || "https://client.printeasy.themangatech.com";

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  console.log("[Companion] Loading URL:", WEB_APP_URL);
  mainWindow.loadURL(WEB_APP_URL);

  // Mirror the dashboard's console into the main process log, so launching the
  // exe from a terminal is enough to see why a socket will not connect.
  mainWindow.webContents.on("console-message", (_event, level, message) => {
    if (message.startsWith("[socket]")) console.log("[Renderer]", message);
    else if (level >= 2) console.error("[Renderer]", message);
  });

  mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDesc, validatedURL) => {
    console.error("[Companion] Failed to load:", validatedURL, errorCode, errorDesc);
    mainWindow.loadURL(`data:text/html,<html><body style="font-family:sans-serif;padding:40px;background:#1a4d30;color:white;">
      <h2>Could not load app</h2>
      <p>URL: ${WEB_APP_URL}</p>
      <p>Error: ${errorDesc} (${errorCode})</p>
      <button onclick="location.reload()" style="margin-top:16px;padding:10px 20px;background:#3aad6a;color:white;border:none;border-radius:6px;font-size:16px;cursor:pointer;">Retry</button>
    </body></html>`);
  });

  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.executeJavaScript(`
      window.print = function() {
        if (window.electronAPI && window.electronAPI.print) {
          const html = document.documentElement.outerHTML;
          window.electronAPI.print({ html: html });
        }
      };
      console.log('Print interceptor installed');
    `);
  });

  if (!app.isPackaged || process.argv.includes("--devtools")) {
    mainWindow.webContents.openDevTools();
  }

  // A packaged build had no way to show its console, so a shop PC that could not
  // reach the server looked exactly like one that could — the only difference
  // being what customers saw. Ctrl+Shift+I (Cmd+Alt+I on macOS) opens it, and
  // `--devtools` opens it from launch.
  mainWindow.webContents.on("before-input-event", (event, input) => {
    const toggleCombo = IS_WINDOWS
      ? input.control && input.shift && input.key.toLowerCase() === "i"
      : input.meta && input.alt && input.key.toLowerCase() === "i";
    if (toggleCombo) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
}

// ── Printer status polling ────────────────────────────────────────────────────

// The numeric poll is cheap (an Electron call). Resolving realStatus is not —
// on Windows it shells out to PowerShell — so it runs only when the numeric
// status moved or REAL_STATUS_MAX_AGE_MS has passed since the last resolve.
const REAL_STATUS_MAX_AGE_MS = 30_000;

let _lastPrinterStatus = null;
let _lastRealStatus = null;
let _lastRealStatusAt = 0;
let _printerPollTimer = null;

/** Resolves realStatus for the default printer. Returns 'disconnected' when there is none. */
async function resolveDefaultPrinterRealStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return _lastRealStatus;
  const printers = await mainWindow.webContents.getPrintersAsync();
  const def = printers.find((p) => p.isDefault) || printers[0] || null;
  if (!def) return "disconnected";
  return getPrinterRealStatus(def);
}

/**
 * Pushes realStatus to the renderer whenever it changes, so the dashboard can
 * forward it to the backend without polling the expensive get-device-info path
 * on every page.
 */
async function refreshRealStatus({ force = false } = {}) {
  const real = await resolveDefaultPrinterRealStatus();
  _lastRealStatusAt = Date.now();
  if (real !== _lastRealStatus || force) {
    _lastRealStatus = real;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("printer-real-status", real);
    }
  }
  return real;
}

/**
 * Non-zero while a print is being watched.
 *
 * The spool watchdog polls PowerShell every 1.5s and every probe here is
 * serialised behind it, so a status poll running alongside a print only adds
 * latency to the poll that actually matters — and the watchdog reports printer
 * trouble in far more detail anyway. The status poll stands down until the job
 * is done.
 */
let _printsInFlight = 0;

function startPrinterStatusPolling() {
  const poll = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (_printsInFlight > 0) {
      _printerPollTimer = setTimeout(poll, 5000);
      return;
    }
    try {
      const printers = await mainWindow.webContents.getPrintersAsync();
      const def = printers.find((p) => p.isDefault) || printers[0] || null;
      const status = def ? def.status : -1;
      const numericChanged = status !== _lastPrinterStatus;
      if (numericChanged) {
        _lastPrinterStatus = status;
        mainWindow.webContents.send("printer-status-change", status);
      }
      if (numericChanged || Date.now() - _lastRealStatusAt >= REAL_STATUS_MAX_AGE_MS) {
        await refreshRealStatus();
      }
    } catch {
      // Window may be closing — ignore
    }
    _printerPollTimer = setTimeout(poll, 5000);
  };
  _printerPollTimer = setTimeout(poll, 5000);
}

function stopPrinterStatusPolling() {
  if (_printerPollTimer) {
    clearTimeout(_printerPollTimer);
    _printerPollTimer = null;
  }
}

// One companion per shop PC.
//
// Both copies answer `client:join` for the same client, and the backend hands
// jobs to whichever socket connected last — so the window the staff are looking
// at is not necessarily the one that prints, and two spool watchdogs poll the
// same queue and disagree about it. Staff double-click the desktop icon; this is
// the cheapest way to make that harmless.
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  console.log("[Companion] Another instance is already running — exiting.");
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    createWindow();
    startPrinterStatusPolling();
    watchPowerEvents();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

/**
 * A shop PC sleeps overnight, and the backend gates customer uploads on the
 * last printer status this app reported. Without this the woken machine keeps
 * advertising whatever it saw before it slept — most damagingly "ready" for a
 * printer that has since been switched off — until the 30s status poll happens
 * to come round and notice. Re-probe the moment we are back.
 */
function watchPowerEvents() {
  const reprobe = (why) => {
    console.log(`[Companion] ${why} — re-probing printer status`);
    // Nothing to be done if it fails: the regular poll is still running.
    void refreshRealStatus({ force: true }).catch(() => {});
  };

  powerMonitor.on("resume", () => reprobe("system resumed"));
  powerMonitor.on("unlock-screen", () => reprobe("screen unlocked"));
}

app.on("window-all-closed", () => {
  stopPrinterStatusPolling();
  if (process.platform !== "darwin") app.quit();
});

// ── IPC: get-printer-real-status ──────────────────────────────────────────────
// Cheap targeted probe — skips the supply-level and duplex work in
// get-device-info. Used by the dashboard to report printer state to the backend.

ipcMain.handle("get-printer-real-status", async () => {
  try {
    return await refreshRealStatus({ force: true });
  } catch {
    return "unknown";
  }
});

// ── IPC: get-printers ─────────────────────────────────────────────────────────

ipcMain.handle("get-printers", async () => {
  return mainWindow.webContents.getPrintersAsync();
});

// ── Windows shell helpers ─────────────────────────────────────────────────────
// Every Windows probe goes through PowerShell. execFile (not exec) so the script
// is a single argv entry — no cmd.exe quoting to get wrong.

function escapePs(value) {
  // Escape for a PowerShell single-quoted string literal
  return String(value).replace(/'/g, "''");
}

/**
 * A probe that has not answered by now is not going to.
 *
 * Nothing here had a timeout before, and `Get-Printer` against a printer that
 * has dropped off the network genuinely never returns on some driver/port
 * combinations. One of those inside the spool watchdog's poll loop hangs the
 * loop for the life of the app: the job reaches no outcome, the customer waits
 * on "Printing…" forever, and only the reconciler's refund ends it.
 */
const PS_TIMEOUT_MS = 8000;

/**
 * PowerShell probes run one at a time.
 *
 * Each one costs a powershell.exe launch — a few hundred milliseconds on a shop
 * PC — and the spool watchdog polls every 1.5s while the printer-status poll
 * runs every 5s. Unserialised those overlap, and on exactly the machine where it
 * matters (a printer that has gone offline, so every call is slow) they pile up
 * processes faster than they retire. The queue holds it to one; the timeout
 * stops a wedged call from holding the queue.
 */
let _psQueue = Promise.resolve();

function runPowerShell(script) {
  const run = async () => {
    try {
      const { stdout } = await execFileAsync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          windowsHide: true,
          timeout: PS_TIMEOUT_MS,
          killSignal: "SIGKILL",
          maxBuffer: 4 * 1024 * 1024,
        }
      );
      return stdout.trim();
    } catch (err) {
      if (err.killed) {
        throw new Error(`PowerShell probe timed out after ${PS_TIMEOUT_MS}ms`);
      }
      throw err;
    }
  };

  // `then(run, run)` so one failed probe does not stall every probe behind it.
  const result = _psQueue.then(run, run);
  _psQueue = result.catch(() => {});
  return result;
}

async function getWindowsPrinterPort(printerName) {
  if (!printerName) return null;
  try {
    const port = await runPowerShell(
      `Get-Printer -Name '${escapePs(printerName)}' | Select-Object -ExpandProperty PortName`
    );
    return port || null;
  } catch {
    return null;
  }
}

// Local ports carry no network address — SNMP is not reachable through them.
const LOCAL_PORT_RE = /^(USB|DOT4|LPT|COM|FILE|nul|PORTPROMPT|Microsoft)/i;

async function getWindowsPrinterHostAddress(printerName) {
  const port = await getWindowsPrinterPort(printerName);
  if (!port || LOCAL_PORT_RE.test(port)) return null;
  try {
    const addr = await runPowerShell(
      `Get-PrinterPort -Name '${escapePs(port)}' | Select-Object -ExpandProperty PrinterHostAddress`
    );
    return addr || null;
  } catch {
    return null;
  }
}

// ── Supply levels ─────────────────────────────────────────────────────────────

// macOS: Electron's getPrintersAsync() already includes marker-* attributes from
// the CUPS driver — no CUPS HTTP request needed.
function parseSupplyLevelsMac(printer) {
  const opts = printer.options || {};
  const namesStr = opts["marker-names"] || "";
  const levelsStr = opts["marker-levels"] || "";
  const typesStr = opts["marker-types"] || "";

  if (!namesStr && !levelsStr) return [];

  const names = namesStr.split(",").map((s) => s.trim()).filter(Boolean);
  const levels = levelsStr.split(",").map((s) => parseInt(s.trim(), 10));
  const types = typesStr.split(",").map((s) => s.trim().toLowerCase());

  return names.map((name, i) => {
    const level = levels[i];
    const typeRaw = types[i] || "";
    let supplyType = "ink";
    if (typeRaw.includes("paper") || typeRaw.includes("media")) supplyType = "paper";
    else if (typeRaw.includes("waste")) supplyType = "other";
    return {
      name,
      type: supplyType,
      levelPercent: !isNaN(level) && level >= 0 ? Math.min(100, level) : null,
    };
  });
}

// Windows has no universal ink-level API. For network printers the standard
// Printer-MIB (RFC 3805) over SNMP is the only portable source; USB printers
// expose nothing, so we report an empty list rather than invent numbers.
const SNMP_OID = {
  supplyType: "1.3.6.1.2.1.43.11.1.1.5",
  supplyDesc: "1.3.6.1.2.1.43.11.1.1.6",
  supplyMax: "1.3.6.1.2.1.43.11.1.1.8",
  supplyLevel: "1.3.6.1.2.1.43.11.1.1.9",
  inputMax: "1.3.6.1.2.1.43.8.2.1.9",
  inputLevel: "1.3.6.1.2.1.43.8.2.1.10",
};

// prtMarkerSuppliesType: 3=toner 5=ink 6=inkCartridge 7=inkRibbon
const SNMP_INK_TYPES = new Set([3, 5, 6, 7]);

// Ceiling for the whole SNMP probe, above net-snmp's own 2s per-request timeout.
const SNMP_TOTAL_TIMEOUT_MS = 4000;

let _snmp;
function loadSnmp() {
  if (_snmp === undefined) {
    try {
      _snmp = require("net-snmp");
    } catch {
      _snmp = null;
    }
  }
  return _snmp;
}

// prtMarkerSuppliesLevel sentinels: -1 unknown, -2 unrestricted, -3 some remaining.
// None of them is a percentage, so surface null instead of a fabricated number.
function toPercent(level, max) {
  if (typeof level !== "number" || typeof max !== "number") return null;
  if (level < 0 || max <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((level / max) * 100)));
}

// net-snmp's done-callback is not guaranteed to fire (a wedged socket leaves it
// pending). Without a hard ceiling a stuck walk would block get-device-info
// forever and pin the dashboard in its loading state.
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function snmpWalk(session, oid) {
  return new Promise((resolve) => {
    const byIndex = new Map();
    session.subtree(
      oid,
      20,
      (varbinds) => {
        for (const vb of varbinds) {
          if (!vb || vb.oid == null) continue;
          const index = vb.oid.slice(oid.length + 1);
          const value = Buffer.isBuffer(vb.value) ? vb.value.toString("utf8") : vb.value;
          byIndex.set(index, value);
        }
      },
      () => resolve(byIndex)
    );
  });
}

async function getSupplyLevelsWindows(printer) {
  const snmp = loadSnmp();
  if (!snmp) {
    return { levels: [], error: "SNMP module unavailable — supply levels cannot be read." };
  }

  const host = await getWindowsPrinterHostAddress(printer.name);
  if (!host) {
    // USB/local printer — Windows exposes no supply data. Not an error.
    return { levels: [], error: null };
  }

  let session;
  try {
    session = snmp.createSession(host, "public", { timeout: 2000, retries: 0, version: snmp.Version2c });

    const walks = Promise.all([
      snmpWalk(session, SNMP_OID.supplyDesc),
      snmpWalk(session, SNMP_OID.supplyType),
      snmpWalk(session, SNMP_OID.supplyMax),
      snmpWalk(session, SNMP_OID.supplyLevel),
      snmpWalk(session, SNMP_OID.inputMax),
      snmpWalk(session, SNMP_OID.inputLevel),
    ]);

    const walked = await withTimeout(walks, SNMP_TOTAL_TIMEOUT_MS, null);
    if (walked === null) {
      return { levels: [], error: `Printer at ${host} did not answer SNMP in time.` };
    }
    const [descs, types, maxes, levels, inMax, inLevel] = walked;

    const result = [];

    for (const [index, desc] of descs) {
      const typeCode = Number(types.get(index));
      result.push({
        name: String(desc || `Supply ${index}`),
        type: SNMP_INK_TYPES.has(typeCode) ? "ink" : "other",
        levelPercent: toPercent(Number(levels.get(index)), Number(maxes.get(index))),
      });
    }

    for (const [index, level] of inLevel) {
      result.push({
        // Index is hrDeviceIndex.prtInputIndex — only the tray number is useful
        name: `Paper tray ${index.split(".").pop()}`,
        type: "paper",
        levelPercent: toPercent(Number(level), Number(inMax.get(index))),
      });
    }

    if (result.length === 0) {
      return { levels: [], error: `Printer at ${host} did not report Printer-MIB supply data.` };
    }
    return { levels: result, error: null };
  } catch (err) {
    return { levels: [], error: `Could not read supply levels over SNMP: ${err.message}` };
  } finally {
    try {
      session?.close();
    } catch {
      // already closed
    }
  }
}

async function getSupplyLevels(printer) {
  if (IS_WINDOWS) return getSupplyLevelsWindows(printer);
  return { levels: parseSupplyLevelsMac(printer), error: null };
}

// ── Cross-platform printer status ─────────────────────────────────────────────

/**
 * `printer.status` is not one enum across platforms.
 *
 * On macOS it is the CUPS/IPP `printer-state` (RFC 8011): 3 idle, 4 processing,
 * 5 stopped. This table used to hold the *Windows* enum — 0 Idle, 1 Processing,
 * 2 Paused, 3 Stopped — and applied it to the CUPS value, so an idle Mac
 * printer, state 3, read as a stopped queue. The backend gates customer uploads
 * on this status, so a perfectly healthy shop advertised itself as paused and
 * turned away every job, with nothing anywhere to un-pause. Windows never used
 * this table: `getWindowsPrinterStatus` reads PowerShell strings instead.
 */
const IPP_PRINTER_STATE = { 3: "ready", 4: "printing", 5: "queue_stopped" };

/**
 * A CUPS queue can be disabled while its state still reads idle, and
 * `printer-state-reasons` is the only place that says so.
 *
 * Vendor reasons are namespaced with dots (`com.canon.ijprinter-…`) and carry no
 * standard meaning — a Canon reports nineteen of them, including strings like
 * `auto-power-off-off`. Only the un-namespaced IPP keywords are read.
 */
const STOPPED_STATE_REASON = /^(paused|moving-to-paused|shutdown|offline-report)/;

function standardStateReasons(printer) {
  return String(printer.options?.["printer-state-reasons"] ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r && !r.includes("."));
}

async function getMacPrinterStatus(printer) {
  const deviceUri = printer.options?.["device-uri"] ?? "";
  if (deviceUri.startsWith("usb://")) {
    try {
      const brand = printer.displayName.split(" ")[0];
      const { stdout } = await execAsync(`ioreg -p IOUSB -l 2>/dev/null | grep -i "${brand}"`);
      if (!stdout.trim()) return "disconnected";
    } catch {
      return "unknown";
    }
  }

  if (standardStateReasons(printer).some((r) => STOPPED_STATE_REASON.test(r))) {
    return "queue_stopped";
  }

  return IPP_PRINTER_STATE[printer.status] ?? "unknown";
}

/**
 * Is the printer physically there?
 *
 * Windows will happily report a switched-off USB printer as `Normal` and queue
 * into it forever, so the queue state alone cannot answer this. Gate on the
 * Windows port name — `device-uri` is a CUPS-only attribute Windows never
 * populates.
 *
 * Returns true/false only for a local port we could actually check, and null
 * when the question does not apply (network printer) or could not be answered.
 */
async function probeWindowsPrinterPresent(printerName, brandHint) {
  try {
    const port = (await getWindowsPrinterPort(printerName)) ?? "";
    if (!/^(USB|DOT4)/i.test(port)) return null;

    const brand = String(brandHint || printerName).split(" ")[0];
    const out = await runPowerShell(
      `Get-PnpDevice | Where-Object {$_.FriendlyName -like '*${escapePs(brand)}*'} | Select-Object -ExpandProperty Status`
    );
    return out
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase())
      .some((l) => l === "ok");
  } catch {
    return null;
  }
}

async function getWindowsPrinterStatus(printer) {
  let state = "unknown";
  try {
    const s = (
      await runPowerShell(
        `Get-Printer -Name '${escapePs(printer.name)}' | Select-Object -ExpandProperty PrinterStatus`
      )
    ).toLowerCase();
    if (s === "normal") state = "ready";
    else if (s === "printing") state = "printing";
    else if (s === "offline" || s === "error" || s === "degraded") state = "queue_stopped";
  } catch {
    /* PS unavailable */
  }

  const present = await probeWindowsPrinterPresent(printer.name, printer.displayName);
  if (present === false) return "disconnected";

  return state;
}

async function getPrinterRealStatus(printer) {
  if (IS_WINDOWS) return getWindowsPrinterStatus(printer);
  return getMacPrinterStatus(printer);
}

// ── IPC: get-device-info ──────────────────────────────────────────────────────

async function detectDuplexSupportMac(printerName) {
  try {
    const pFlag = printerName ? `-p "${printerName}"` : "";
    const { stdout } = await execAsync(`lpoptions ${pFlag} -l 2>/dev/null`);
    for (const line of stdout.split("\n")) {
      // Match the `sides` or `Duplex` PPD option line
      const m = line.match(/^(sides|Duplex)\/[^:]*:\s*(.+)$/i);
      if (!m) continue;
      const values = m[2];
      return values.includes("two-sided") || values.includes("DuplexNoTumble") || values.includes("DuplexTumble");
    }
  } catch { /* lpoptions unavailable */ }
  return false;
}

async function detectDuplexSupportWindows(printerName) {
  if (!printerName) return false;
  const name = escapePs(printerName);

  // Win32_Printer.Capabilities contains 3 when the driver advertises duplex.
  try {
    const out = await runPowerShell(
      `Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq '${name}' } | Select-Object -ExpandProperty Capabilities`
    );
    if (out.split(/\r?\n/).some((l) => l.trim() === "3")) return true;
  } catch { /* WMI unavailable */ }

  // Fallback: the driver's own duplex-unit config property
  try {
    const out = await runPowerShell(
      `Get-PrinterProperty -PrinterName '${name}' -PropertyName 'Config:DuplexUnit' | Select-Object -ExpandProperty Value`
    );
    return out.trim().toLowerCase() === "installed";
  } catch { /* property not exposed by this driver */ }

  return false;
}

async function detectDuplexSupport(printerName) {
  if (IS_WINDOWS) return detectDuplexSupportWindows(printerName);
  return detectDuplexSupportMac(printerName);
}

ipcMain.handle("get-device-info", async () => {
  if (!mainWindow) return { printer: null, supplyLevels: [], cupsError: null, supportsDuplex: false };

  const printers = await mainWindow.webContents.getPrintersAsync();
  const defaultPrinter = printers.find((p) => p.isDefault) || printers[0] || null;

  if (!defaultPrinter) return { printer: null, supplyLevels: [], cupsError: null, supportsDuplex: false };

  const [realStatus, supplies, supportsDuplex] = await Promise.all([
    getPrinterRealStatus(defaultPrinter),
    getSupplyLevels(defaultPrinter),
    detectDuplexSupport(defaultPrinter.name),
  ]);

  return {
    printer: { ...defaultPrinter, realStatus },
    supplyLevels: supplies.levels,
    cupsError: supplies.error,
    supportsDuplex,
  };
});

// ── IPC: print (HTML) ─────────────────────────────────────────────────────────

ipcMain.handle("print", async (event, options = {}) => {
  const { html, printerName } = options;

  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true },
  });

  const content = html || `<html><body style="font-size:24px;text-align:center;padding-top:50px;"><h1>Hello World</h1></body></html>`;

  await new Promise((resolve, reject) => {
    printWindow.webContents.once("did-finish-load", resolve);
    printWindow.webContents.once("did-fail-load", (_, errorCode, errorDesc) =>
      reject(new Error(`Page load failed: ${errorDesc} (${errorCode})`))
    );
    printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(content)}`);
  });

  await new Promise((r) => setTimeout(r, 150));

  return new Promise((resolve) => {
    const printOptions = { silent: true, printBackground: true };
    if (printerName) printOptions.deviceName = printerName;

    if (mainWindow) mainWindow.webContents.send("print-stage", "printing");

    printWindow.webContents.print(printOptions, (success, errorType) => {
      printWindow.close();
      if (mainWindow) mainWindow.webContents.send("print-stage", success ? "complete" : "error");
      resolve(success
        ? { success: true, stage: "complete" }
        : { success: false, stage: "error", error: errorType }
      );
    });
  });
});

// ── IPC: print-hello ──────────────────────────────────────────────────────────

ipcMain.handle("print-hello", async () => {
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true },
  });
  await printWindow.loadURL(`data:text/html,<html><body style="font-size:24px;text-align:center;padding-top:50px;"><h1>Hello World</h1></body></html>`);
  printWindow.webContents.print({ silent: true, printBackground: true }, (success) => {
    printWindow.close();
    if (!success) console.error("printHello failed");
  });
  return true;
});

// ── Spool watchdog ────────────────────────────────────────────────────────────
// Submitting is not printing. `lpr` returns once CUPS accepts the job and
// SumatraPDF exits once the Windows spooler accepts it — both succeed while the
// printer is offline, jammed, paused or out of paper. Everything below exists to
// turn "submitted" into an outcome we actually observed.

const POLL_MS = 1500;
/** Longest we wait for a submitted job to surface in the spooler. */
const SUBMIT_TIMEOUT_MS = 60_000;
/** No page progress for this long, job still queued → the printer gave up. */
const IDLE_TIMEOUT_MS = 3 * 60_000;
/** How long a recoverable block (paper out, offline) may last before we give up. */
const BLOCKED_GRACE_MS = 2 * 60_000;
/**
 * Consecutive unreadable spooler polls tolerated before we stop watching.
 *
 * A single unreadable poll is not evidence of anything — PowerShell probes carry
 * a timeout now, and a busy shop PC can miss one. Treating the first one as
 * "the job is gone, call it a success" would report a print nobody watched every
 * time the machine hiccuped.
 */
const MAX_SPOOLER_READ_FAILURES = 4;

// Terminal — the job is gone and is not coming back.
const FATAL_JOB_STATES = [
  { re: /Deleted/i, code: "CANCELLED", message: "The print job was cancelled at the printer." },
  { re: /Error/i, code: "PRINTER_ERROR", message: "The printer reported an error." },
];

// Recoverable — the shop can fix these and the job resumes on its own, so they
// are reported as a live reason rather than a failure until the grace runs out.
const BLOCKED_JOB_STATES = [
  { re: /PaperOut/i, code: "PAPER_OUT", message: "The printer is out of paper." },
  { re: /Offline/i, code: "OFFLINE", message: "The printer went offline." },
  { re: /UserIntervention/i, code: "NEEDS_ATTENTION", message: "The printer needs attention." },
  { re: /BlockedDeviceQuery/i, code: "BLOCKED", message: "The printer is not responding." },
  { re: /Paused/i, code: "PAUSED", message: "The print job is paused." },
];

// `Retained` is a finished job held back by "Keep printed documents" — a success.
const DONE_JOB_STATES = /Printed|Complete|Retained/i;

class PrintFailure extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PrintFailure";
    this.code = code;
  }
}

function classifyJobStatus(status) {
  const s = String(status || "");
  if (DONE_JOB_STATES.test(s)) return { done: true };
  const fatal = FATAL_JOB_STATES.find((f) => f.re.test(s));
  if (fatal) return { fatal: { code: fatal.code, message: fatal.message } };
  const blocked = BLOCKED_JOB_STATES.find((b) => b.re.test(s));
  if (blocked) return { blocked: { code: blocked.code, message: blocked.message } };
  return {};
}

function escapeShellArg(value) {
  return String(value).replace(/(["\\$`])/g, "\\$1");
}

async function resolveDefaultPrinterName() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const printers = await mainWindow.webContents.getPrintersAsync();
  const def = printers.find((p) => p.isDefault) || printers[0] || null;
  return def ? def.name : null;
}

// ── Windows spooler ───────────────────────────────────────────────────────────

// ConvertTo-Json renders the JobStatus flag enum as an integer under PowerShell
// 5.1 and serialises a lone job as an object rather than an array. [string] and
// @() force both into the shape this parser expects.
const PS_JOB_SELECT =
  "Select-Object Id, DocumentName, PagesPrinted, TotalPages, " +
  "@{n='Status';e={[string]$_.JobStatus}}";

async function listJobsWindows(printerName) {
  const out = await runPowerShell(
    `@(Get-PrintJob -PrinterName '${escapePs(printerName)}' -ErrorAction SilentlyContinue | ` +
      `${PS_JOB_SELECT}) | ConvertTo-Json -Compress -Depth 3`
  ).catch(() => null);

  // null means the spooler could not be read at all, which is not the same as an
  // empty queue. Conflating the two is how a PowerShell failure gets reported to
  // the customer as a successful print.
  if (out === null) return null;
  if (!out) return [];

  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return null;
  }

  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.filter(Boolean).map((j) => ({
    id: String(j.Id),
    name: j.DocumentName || "",
    pagesPrinted: Number(j.PagesPrinted) || 0,
    totalPages: Number(j.TotalPages) || 0,
    status: String(j.Status || ""),
  }));
}

// Windows queues into a black hole when the printer is paused, offline, or has
// "Use Printer Offline" ticked — and SumatraPDF exits 0 regardless. Refusing up
// front is the only honest answer.
async function preflightWindows(printerName) {
  const spooler = await runPowerShell("(Get-Service -Name Spooler).Status").catch(() => "");
  if (spooler && spooler.trim().toLowerCase() !== "running") {
    return {
      ok: false,
      code: "SPOOLER_DOWN",
      message: "The Windows Print Spooler service is not running.",
    };
  }

  const name = printerName || (await resolveDefaultPrinterName());
  if (!name) return { ok: false, code: "NO_PRINTER", message: "No printer is installed." };

  const raw = await runPowerShell(
    `Get-Printer -Name '${escapePs(name)}' | ` +
      "Select-Object @{n='Status';e={[string]$_.PrinterStatus}}, WorkOffline | ConvertTo-Json -Compress"
  ).catch(() => "");
  // No PowerShell access — proceed rather than block the shop entirely; the
  // watchdog still reports whatever the spooler is willing to tell us.
  if (!raw) return { ok: true, printerName: name };

  let info;
  try {
    info = JSON.parse(raw);
  } catch {
    return { ok: true, printerName: name };
  }

  // The single most common silent-queue cause on Windows.
  if (info.WorkOffline === true) {
    return {
      ok: false,
      code: "WORK_OFFLINE",
      message: `"${name}" is set to Use Printer Offline in Windows.`,
    };
  }

  const s = String(info.Status || "").toLowerCase();
  if (s.includes("paused")) return { ok: false, code: "PAUSED", message: `"${name}" is paused.` };
  if (s.includes("offline")) return { ok: false, code: "OFFLINE", message: `"${name}" is offline.` };
  if (s.includes("error")) {
    return { ok: false, code: "PRINTER_ERROR", message: `"${name}" is reporting an error.` };
  }

  // A switched-off or unplugged USB printer reports `Normal` right up until you
  // print into it, at which point the job sits in the queue showing nothing in
  // particular — so the watchdog could only end it by timing out three minutes
  // later. Asking the device layer costs one probe and answers now.
  if ((await probeWindowsPrinterPresent(name)) === false) {
    return {
      ok: false,
      code: "DISCONNECTED",
      message: `"${name}" is not connected. Check that it is switched on and plugged in.`,
    };
  }

  return { ok: true, printerName: name };
}

// ── macOS spooler ─────────────────────────────────────────────────────────────

/** True when CUPS has stopped the queue — jobs pile up instead of printing. */
async function probeQueueStoppedMac(printerName) {
  if (!printerName) return false;
  const out = await execAsync(`lpstat -p "${escapeShellArg(printerName)}"`)
    .then((r) => r.stdout)
    .catch(() => "");
  return /\bdisabled\b|\bstopped\b/i.test(out);
}

// CUPS job ids are the first field of each `lpstat -o` line ("Canon_TS3300-123").
// CUPS exposes no per-job error state, so a blocked job is inferred from the
// queue being stopped — the same condition Windows reports as Offline.
async function listJobsMac(printerName) {
  const target = printerName ? ` "${escapeShellArg(printerName)}"` : "";
  const stdout = await execAsync(`lpstat -o${target}`)
    .then((r) => r.stdout)
    .catch((err) => (typeof err.stdout === "string" ? err.stdout : null));
  if (stdout === null) return null;

  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const stopped = await probeQueueStoppedMac(printerName);
  return lines.map((line) => {
    const id = line.split(/\s+/)[0];
    return {
      id,
      name: id,
      pagesPrinted: 0,
      totalPages: 0,
      status: stopped ? "Offline" : "",
    };
  });
}

async function preflightMac(printerName) {
  const name = printerName || (await resolveDefaultPrinterName());
  if (!name) return { ok: false, code: "NO_PRINTER", message: "No printer is installed." };
  if (await probeQueueStoppedMac(name)) {
    return { ok: false, code: "QUEUE_STOPPED", message: `The "${name}" queue is stopped.` };
  }
  return { ok: true, printerName: name };
}

// ── The watchdog itself ───────────────────────────────────────────────────────

/**
 * Runs `submit`, then follows the job through the OS spooler until it reaches a
 * state worth reporting. Three outcomes, deliberately — collapsing the third
 * into "success" is what made the customer's status untrustworthy:
 *
 *   confirmed success   — the spooler showed us the job finish
 *   unconfirmed success — submitted cleanly, but we never got a view of the job
 *   PrintFailure        — a classified, human-readable reason
 */
async function watchSpoolJob({ printerName, listJobs, submit, onStage, expectName }) {
  const before = new Set(((await listJobs(printerName)) || []).map((j) => j.id));

  onStage({ stage: "spooling" });

  // Poll from the moment we submit: a short job can finish before the submitting
  // process even exits, and awaiting it first would miss the job entirely.
  let submitError = null;
  const submitted = submit();
  submitted.catch((err) => {
    submitError = err;
  });

  let jobId = null;
  let lastPages = -1;
  let lastProgressAt = Date.now();
  let blockedSince = null;
  let blockedCode = null;
  let readFailures = 0;
  const appearBy = Date.now() + SUBMIT_TIMEOUT_MS;

  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (submitError) throw submitError;

    const jobs = await listJobs(printerName).catch(() => null);

    if (jobs === null) {
      // Unreadable, which is not the same as empty. Ride out a few of these
      // before giving up on watching — and when we do give up, say so, rather
      // than claiming an outcome we never saw.
      if (++readFailures < MAX_SPOOLER_READ_FAILURES) continue;
      console.warn(
        `[Companion] spooler unreadable ${readFailures}x — reporting an unconfirmed result`
      );
      // Unguarded on purpose: we never got a view of this job, so if the submit
      // itself failed that is the only thing we know about it and it wins.
      await submitted;
      return { success: true, stage: "complete", confirmed: false };
    }
    readFailures = 0;

    if (!jobId) {
      // Both engines name the spooler job after the file. Prefer that match so a
      // second job arriving at the same printer cannot be mistaken for ours.
      const candidates = jobs.filter((j) => !before.has(j.id));
      const fresh =
        (expectName && candidates.find((j) => j.name.includes(expectName))) || candidates[0];
      if (fresh) {
        jobId = fresh.id;
        onStage({
          stage: "printing",
          pagesPrinted: fresh.pagesPrinted,
          totalPages: fresh.totalPages,
        });
        continue;
      }
      if (Date.now() > appearBy) {
        await submitted;
        // Submitted cleanly, never surfaced, never errored: it printed faster
        // than we could observe, or this driver bypasses the spooler.
        return { success: true, stage: "complete", confirmed: false };
      }
      continue;
    }

    const cur = jobs.find((j) => j.id === jobId);
    if (!cur) {
      // Left the queue without ever showing an error state — it printed.
      await submitted.catch(() => {});
      return { success: true, stage: "complete", confirmed: true };
    }

    const verdict = classifyJobStatus(cur.status);

    if (verdict.done) {
      await submitted.catch(() => {});
      return { success: true, stage: "complete", confirmed: true };
    }

    if (verdict.fatal) throw new PrintFailure(verdict.fatal.code, verdict.fatal.message);

    if (verdict.blocked) {
      if (blockedSince === null) blockedSince = Date.now();
      // Only on transition. Re-emitting every poll would put ~80 identical
      // events a minute through IPC and on to the customer's socket.
      if (blockedCode !== verdict.blocked.code) {
        blockedCode = verdict.blocked.code;
        onStage({
          stage: "blocked",
          code: verdict.blocked.code,
          message: verdict.blocked.message,
          pagesPrinted: cur.pagesPrinted,
          totalPages: cur.totalPages,
        });
      }
      if (Date.now() - blockedSince > BLOCKED_GRACE_MS) {
        throw new PrintFailure(verdict.blocked.code, verdict.blocked.message);
      }
      continue;
    }

    blockedSince = null;
    blockedCode = null;

    if (cur.pagesPrinted !== lastPages) {
      lastPages = cur.pagesPrinted;
      lastProgressAt = Date.now();
      onStage({
        stage: "printing",
        pagesPrinted: cur.pagesPrinted,
        totalPages: cur.totalPages,
      });
    } else if (Date.now() - lastProgressAt > IDLE_TIMEOUT_MS) {
      throw new PrintFailure("STALLED", "The printer stopped responding mid-job.");
    }
  }
}

// ── IPC: print-file (PDF) ─────────────────────────────────────────────────────
// Chromium's PDF viewer runs in an OOPIF sub-process, so webContents.print()
// captures a blank frame. Both platforms therefore hand the raw PDF to an
// external engine: CUPS `lpr` on macOS, bundled SumatraPDF on Windows.

function buildLprArgs({ tempPath, copies, paperSize, printerName, colorMode, duplex, pageRange }) {
  const isGrayscale = colorMode === "blackwhite";
  const lprArgs = [];
  if (printerName) lprArgs.push("-P", printerName);
  if (copies > 1) lprArgs.push("-#", String(copies));

  // Standard IPP color mode (honoured by non-Canon drivers)
  lprArgs.push("-o", isGrayscale ? "print-color-mode=monochrome" : "print-color-mode=color");

  // The customer was charged for this size, so print on it.
  if (paperSize) lprArgs.push("-o", `media=${paperSize}`);
  if (duplex === "longEdge") lprArgs.push("-o", "sides=two-sided-long-edge");
  else if (duplex === "shortEdge") lprArgs.push("-o", "sides=two-sided-short-edge");
  else lprArgs.push("-o", "sides=one-sided");

  // Page range — standard CUPS `page-ranges` (1-indexed, already in UI format)
  if (pageRange && pageRange !== "all") lprArgs.push("-o", `page-ranges=${pageRange}`);

  lprArgs.push(tempPath);
  return lprArgs;
}

async function printFileMac(job, onStage) {
  const pre = await preflightMac(job.printerName);
  if (!pre.ok) throw new PrintFailure(pre.code, pre.message);
  const printerName = pre.printerName;
  const isGrayscale = job.colorMode === "blackwhite";

  const submit = async () => {
    try {
      // Canon's CUPS filter reads CNIJGrayScale from the printer's stored
      // defaults, not from per-job -o options. Set before printing, restore after.
      if (isGrayscale) {
        await execAsync(
          `lpoptions -p "${escapeShellArg(printerName)}" -o CNIJGrayScale=1 2>/dev/null`
        ).catch(() => {});
      }
      const lprArgs = buildLprArgs({ ...job, printerName });
      console.log("[Companion] lpr args:", lprArgs);
      await execFileAsync("lpr", lprArgs);
      console.log("[Companion] print-file: lpr accepted the job");
    } finally {
      // Always restore the color default, even if lpr threw
      if (isGrayscale) {
        await execAsync(
          `lpoptions -p "${escapeShellArg(printerName)}" -o CNIJGrayScale=0 2>/dev/null`
        ).catch(() => {});
      }
    }
  };

  return watchSpoolJob({
    printerName,
    listJobs: listJobsMac,
    submit,
    onStage,
    expectName: path.basename(job.tempPath),
  });
}

// Windows — SumatraPDF. The dashboard's paperSize enum is uppercase
// ('LETTER'|'LEGAL'), but SumatraPDF expects those two lowercase.
const SUMATRA_PAPER = { A3: "A3", A4: "A4", A5: "A5", LETTER: "letter", LEGAL: "legal" };

function sumatraBinaryPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "vendor", "win", "SumatraPDF.exe")
    : path.join(__dirname, "vendor", "win", "SumatraPDF.exe");
}

function buildSumatraArgs(
  { tempPath, copies, paperSize, colorMode, duplex, pageRange },
  printerName
) {
  // -print-settings takes one comma-separated list
  const settings = [];
  if (copies > 1) settings.push(`${copies}x`);
  if (duplex === "longEdge") settings.push("duplexlong");
  else if (duplex === "shortEdge") settings.push("duplexshort");
  else settings.push("simplex");
  if (colorMode === "blackwhite") settings.push("monochrome");
  const paper = SUMATRA_PAPER[String(paperSize || "").toUpperCase()];
  if (paper) settings.push(`paper=${paper}`);
  if (pageRange && pageRange !== "all") settings.push(pageRange);

  const args = [];
  if (printerName) args.push("-print-to", printerName);
  else args.push("-print-to-default");
  args.push("-print-settings", settings.join(","), "-silent", "-exit-when-done", tempPath);
  return args;
}

async function printFileWindows(job, onStage) {
  const pre = await preflightWindows(job.printerName);
  if (!pre.ok) throw new PrintFailure(pre.code, pre.message);
  const printerName = pre.printerName;

  const exe = sumatraBinaryPath();
  if (!existsSync(exe)) {
    throw new PrintFailure(
      "ENGINE_MISSING",
      `Print engine not found at ${exe}. Reinstall the companion app to restore it.`
    );
  }

  const args = buildSumatraArgs(job, printerName);
  console.log("[Companion] SumatraPDF args:", args);

  const submit = async () => {
    try {
      // timeout + kill: a driver dialog surfacing behind -silent would otherwise
      // hang this promise for the life of the app, and the job with it.
      await execFileAsync(exe, args, {
        windowsHide: true,
        timeout: SUBMIT_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      console.log("[Companion] print-file: SumatraPDF accepted the job");
    } catch (err) {
      if (err.killed) {
        throw new PrintFailure("ENGINE_TIMEOUT", "The print engine stopped responding.");
      }
      throw new PrintFailure("ENGINE_FAILED", err.message);
    }
  };

  return watchSpoolJob({
    printerName,
    listJobs: listJobsWindows,
    submit,
    onStage,
    expectName: path.basename(job.tempPath),
  });
}

ipcMain.handle("print-file", async (event, options = {}) => {
  const {
    fileData,
    fileName,
    copies = 1,
    paperSize = "A4",
    printerName,
    colorMode = "color",
    duplex = "simplex",
    pageRange,
  } = options;

  console.log("[Companion] print-file:", { fileName, copies, colorMode, duplex, pageRange, paperSize });

  const buffer = Buffer.from(fileData);
  const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  const tempPath = path.join(tmpdir(), `print-${Date.now()}-${safeName}`);
  await writeFile(tempPath, buffer);

  const job = { tempPath, copies, paperSize, printerName, colorMode, duplex, pageRange };

  const onStage = (info) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // 'print-stage' is the legacy string channel the dashboard already listens
    // on. 'blocked' has no PrintStage equivalent, so it rides the richer
    // 'print-progress' channel only.
    if (info.stage !== "blocked") mainWindow.webContents.send("print-stage", info.stage);
    mainWindow.webContents.send("print-progress", info);
  };

  onStage({ stage: "preparing" });

  // Stands the status poll down so its PowerShell probes do not queue ahead of
  // the watchdog's.
  _printsInFlight++;

  try {
    const result = IS_WINDOWS
      ? await printFileWindows(job, onStage)
      : await printFileMac(job, onStage);

    onStage({ stage: "complete", confirmed: result.confirmed });
    console.log("[Companion] print-file done, confirmed:", result.confirmed);
    return result;
  } catch (error) {
    console.error("[Companion] print-file error:", error);
    onStage({ stage: "error", code: error.code, message: error.message });
    return {
      success: false,
      stage: "error",
      // A PrintFailure is a state we read out of the spooler; anything else is
      // an unexpected throw we cannot vouch for.
      confirmed: error instanceof PrintFailure,
      code: error.code || "UNKNOWN",
      error: error.message,
    };
  } finally {
    _printsInFlight--;
    // The printer's state is very likely different now — and the backend gates
    // the next customer's upload on it — so push a fresh reading rather than
    // waiting up to 30s for the poll to notice.
    void refreshRealStatus({ force: true }).catch(() => {});
    setTimeout(() => unlink(tempPath).catch(() => {}), 5000);
  }
});

// ── IPC: get-print-queue ──────────────────────────────────────────────────────

// Windows PowerShell 5.1 serialises DateTime as "/Date(1700000000000)/";
// PowerShell 7 emits ISO-8601.
function parsePsDate(value) {
  if (typeof value === "string") {
    const epoch = value.match(/\/Date\((\d+)\)\//);
    if (epoch) return new Date(Number(epoch[1])).toISOString();
    const parsed = new Date(value);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

async function getPrintQueueWindows(printerName) {
  try {
    // Defaults to the default printer, but takes a name so callers reading the
    // queue for a job print to the same printer that job was sent to.
    const name = printerName || (await resolveDefaultPrinterName());
    if (!name) return [];

    const out = await runPowerShell(
      `@(Get-PrintJob -PrinterName '${escapePs(name)}' -ErrorAction SilentlyContinue | ` +
        "Select-Object Id, DocumentName, SubmittedTime, " +
        "@{n='Status';e={[string]$_.JobStatus}}) | ConvertTo-Json -Compress -Depth 3"
    );
    if (!out) return [];

    const parsed = JSON.parse(out);
    const jobs = Array.isArray(parsed) ? parsed : [parsed];

    return jobs.filter(Boolean).map((j) => {
      const verdict = classifyJobStatus(j.Status);
      return {
        id: String(j.Id),
        fileName: j.DocumentName || "Untitled",
        status: verdict.blocked || verdict.fatal ? "blocked" : "pending",
        reason: (verdict.blocked || verdict.fatal || {}).message,
        createdAt: parsePsDate(j.SubmittedTime),
      };
    });
  } catch {
    // No spooler access, no jobs, or unparseable output — treat as empty queue
    return [];
  }
}

ipcMain.handle("get-print-queue", async (event, printerName) => {
  if (IS_WINDOWS) return getPrintQueueWindows(printerName);
  // macOS: no CUPS dependency — companion doesn't track the OS spooler.
  return [];
});

// ── IPC: print-file-native (PDF via webContents.print) ────────────────────────
// Unused by the dashboard — kept for the printer-test page. Note: pageSize below
// forwards the dashboard's uppercase enum, which Chromium rejects for
// 'LETTER'/'LEGAL' (it wants 'Letter'/'Legal'). See SUMATRA_PAPER for the
// equivalent mapping if this handler is ever put back into service.

function parsePageRangesNative(rangeStr) {
  // Converts 1-indexed UI format ("2-5", "1,3") to Electron's 0-indexed [{from,to}]
  const ranges = [];
  for (const part of rangeStr.split(",")) {
    const trimmed = part.trim();
    const dashMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (dashMatch) {
      const from = parseInt(dashMatch[1], 10) - 1;
      const to   = parseInt(dashMatch[2], 10) - 1;
      if (from >= 0 && to >= from) ranges.push({ from, to });
    } else {
      const n = parseInt(trimmed, 10) - 1;
      if (!isNaN(n) && n >= 0) ranges.push({ from: n, to: n });
    }
  }
  return ranges.length ? ranges : undefined;
}

ipcMain.handle("print-file-native", async (event, options = {}) => {
  const {
    fileData, fileName, copies = 1, printerName,
    colorMode = "color", duplex = "simplex", pageRange, paperSize = "A4",
  } = options;

  console.log("[Companion] print-file-native:", { fileName, copies, colorMode, duplex, pageRange, paperSize });

  const buffer   = Buffer.from(fileData);
  const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  const tempPath = path.join(tmpdir(), `print-${Date.now()}-${safeName}`);
  await writeFile(tempPath, buffer);

  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true },
  });

  try {
    await new Promise((resolve, reject) => {
      printWindow.webContents.once("did-finish-load", resolve);
      printWindow.webContents.once("did-fail-load", (_, code, desc) =>
        reject(new Error(`Failed to load: ${desc} (${code})`))
      );
      printWindow.loadFile(tempPath);
    });

    // Give the PDF renderer time to lay out all pages
    await new Promise((r) => setTimeout(r, 2000));

    const printOptions = {
      silent: true,
      printBackground: false,
      color: colorMode !== "blackwhite",
      pageSize: paperSize,
      copies,
      duplexMode:
        duplex === "longEdge"  ? "longEdge"  :
        duplex === "shortEdge" ? "shortEdge" : "simplex",
    };

    if (printerName) printOptions.deviceName = printerName;
    if (pageRange && pageRange !== "all") {
      const ranges = parsePageRangesNative(pageRange);
      if (ranges) printOptions.pageRanges = ranges;
    }

    console.log("[Companion] print-file-native options:", JSON.stringify(printOptions));

    if (mainWindow) mainWindow.webContents.send("print-stage", "printing");

    return new Promise((resolve) => {
      printWindow.webContents.print(printOptions, (success, errorType) => {
        printWindow.close();
        setTimeout(() => unlink(tempPath).catch(() => {}), 5000);
        console.log("[Companion] print-file-native result:", success, errorType);
        if (mainWindow) mainWindow.webContents.send("print-stage", success ? "complete" : "error");
        resolve(success
          ? { success: true,  stage: "complete" }
          : { success: false, stage: "error", error: errorType }
        );
      });
    });
  } catch (error) {
    printWindow.destroy();
    setTimeout(() => unlink(tempPath).catch(() => {}), 5000);
    console.error("[Companion] print-file-native error:", error);
    return { success: false, stage: "error", error: error.message };
  }
});

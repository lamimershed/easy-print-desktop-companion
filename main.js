const { app, BrowserWindow, ipcMain } = require("electron");

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

  if (!app.isPackaged) mainWindow.webContents.openDevTools();
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

function startPrinterStatusPolling() {
  const poll = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
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

app.whenReady().then(() => {
  createWindow();
  startPrinterStatusPolling();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

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

async function runPowerShell(script) {
  const { stdout } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true }
  );
  return stdout.trim();
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

// Electron's printer.status codes: 0=Idle, 1=Processing, 2=Paused, 3=Stopped, 4=Error
const ELECTRON_STATUS_MAP = { 0: "ready", 1: "printing", 2: "queue_stopped", 3: "queue_stopped", 4: "unknown" };

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
  return ELECTRON_STATUS_MAP[printer.status] ?? "unknown";
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

  // Physical-presence check. Gate on the Windows port name — `device-uri` is a
  // CUPS-only attribute that Windows never populates.
  try {
    const port = (await getWindowsPrinterPort(printer.name)) ?? "";
    if (/^(USB|DOT4)/i.test(port)) {
      const brand = printer.displayName.split(" ")[0];
      const out = await runPowerShell(
        `Get-PnpDevice | Where-Object {$_.FriendlyName -like '*${escapePs(brand)}*'} | Select-Object -ExpandProperty Status`
      );
      const anyOk = out
        .split(/\r?\n/)
        .map((l) => l.trim().toLowerCase())
        .some((l) => l === "ok");
      if (!anyOk) return "disconnected";
    }
  } catch {
    // Presence check failed — fall through to the queue state we already have
  }

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

// ── IPC: print-file (PDF) ─────────────────────────────────────────────────────
// Chromium's PDF viewer runs in an OOPIF sub-process, so webContents.print()
// captures a blank frame. Both platforms therefore hand the raw PDF to an
// external engine: CUPS `lpr` on macOS, bundled SumatraPDF on Windows.

// macOS — unchanged CUPS path.
async function printFileMac({ tempPath, copies, paperSize, printerName, colorMode, duplex, pageRange }) {
  const isGrayscale = colorMode === "blackwhite";

  try {
    // Canon's CUPS filter reads CNIJGrayScale from the printer's stored defaults,
    // not from per-job -o options. Set the default before printing, restore after.
    if (isGrayscale && printerName) {
      await execAsync(`lpoptions -p "${printerName}" -o CNIJGrayScale=1 2>/dev/null`).catch(() => {});
    }

    const lprArgs = [];
    if (printerName) lprArgs.push("-P", printerName);
    if (copies > 1) lprArgs.push("-#", String(copies));

    // Standard IPP color mode (honoured by non-Canon drivers)
    lprArgs.push("-o", isGrayscale ? "print-color-mode=monochrome" : "print-color-mode=color");

    // Duplex — IPP standard `sides` option
    // The customer was charged for this size, so print on it.
    if (paperSize) lprArgs.push("-o", `media=${paperSize}`);
    if (duplex === "longEdge") lprArgs.push("-o", "sides=two-sided-long-edge");
    else if (duplex === "shortEdge") lprArgs.push("-o", "sides=two-sided-short-edge");
    else lprArgs.push("-o", "sides=one-sided");

    // Page range — standard CUPS `page-ranges` (1-indexed, already in UI format)
    if (pageRange && pageRange !== "all") lprArgs.push("-o", `page-ranges=${pageRange}`);

    lprArgs.push(tempPath);
    console.log("[Companion] lpr args:", lprArgs);

    await execFileAsync("lpr", lprArgs);
    console.log("[Companion] print-file: lpr succeeded");
  } finally {
    // Always restore the color default, even if lpr threw
    if (isGrayscale && printerName) {
      await execAsync(`lpoptions -p "${printerName}" -o CNIJGrayScale=0 2>/dev/null`).catch(() => {});
    }
  }
}

// Windows — SumatraPDF. The dashboard's paperSize enum is uppercase
// ('LETTER'|'LEGAL'), but SumatraPDF expects those two lowercase.
const SUMATRA_PAPER = { A3: "A3", A4: "A4", A5: "A5", LETTER: "letter", LEGAL: "legal" };

function sumatraBinaryPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "vendor", "win", "SumatraPDF.exe")
    : path.join(__dirname, "vendor", "win", "SumatraPDF.exe");
}

async function printFileWindows({ tempPath, copies, paperSize, printerName, colorMode, duplex, pageRange }) {
  const exe = sumatraBinaryPath();
  if (!existsSync(exe)) {
    throw new Error(
      `Print engine not found at ${exe}. Reinstall the companion app to restore it.`
    );
  }

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

  console.log("[Companion] SumatraPDF args:", args);
  await execFileAsync(exe, args, { windowsHide: true });
  console.log("[Companion] print-file: SumatraPDF succeeded");
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

  if (mainWindow) mainWindow.webContents.send("print-stage", "printing");

  const job = { tempPath, copies, paperSize, printerName, colorMode, duplex, pageRange };

  try {
    if (IS_WINDOWS) await printFileWindows(job);
    else await printFileMac(job);

    if (mainWindow) mainWindow.webContents.send("print-stage", "complete");
    return { success: true, stage: "complete" };
  } catch (error) {
    console.error("[Companion] print-file error:", error);
    if (mainWindow) mainWindow.webContents.send("print-stage", "error");
    return { success: false, stage: "error", error: error.message };
  } finally {
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

async function getPrintQueueWindows() {
  if (!mainWindow) return [];
  try {
    const printers = await mainWindow.webContents.getPrintersAsync();
    const def = printers.find((p) => p.isDefault) || printers[0] || null;
    if (!def) return [];

    const out = await runPowerShell(
      `Get-PrintJob -PrinterName '${escapePs(def.name)}' | Select-Object Id, DocumentName, SubmittedTime | ConvertTo-Json -Compress`
    );
    if (!out) return [];

    const parsed = JSON.parse(out);
    const jobs = Array.isArray(parsed) ? parsed : [parsed];

    return jobs.filter(Boolean).map((j) => ({
      id: String(j.Id),
      fileName: j.DocumentName || "Untitled",
      status: "pending",
      createdAt: parsePsDate(j.SubmittedTime),
    }));
  } catch {
    // No spooler access, no jobs, or unparseable output — treat as empty queue
    return [];
  }
}

ipcMain.handle("get-print-queue", async () => {
  if (IS_WINDOWS) return getPrintQueueWindows();
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

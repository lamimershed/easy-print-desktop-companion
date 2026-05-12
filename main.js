require("dotenv").config();
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { writeFile, unlink } = require("fs/promises");
const { exec, execFile } = require("child_process");
const { promisify } = require("util");
const { tmpdir } = require("os");

const execFileAsync = promisify(execFile);

const execAsync = promisify(exec);

const WEB_APP_URL = process.env.WEB_APP_URL || "http://localhost:5174";

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

  mainWindow.loadURL(WEB_APP_URL);

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

  mainWindow.webContents.openDevTools();
}

// ── Printer status polling ────────────────────────────────────────────────────

let _lastPrinterStatus = null;
let _printerPollTimer = null;

function startPrinterStatusPolling() {
  const poll = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const printers = await mainWindow.webContents.getPrintersAsync();
      const def = printers.find((p) => p.isDefault) || printers[0] || null;
      const status = def ? def.status : -1;
      if (status !== _lastPrinterStatus) {
        _lastPrinterStatus = status;
        mainWindow.webContents.send("printer-status-change", status);
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

// ── IPC: get-printers ─────────────────────────────────────────────────────────

ipcMain.handle("get-printers", async () => {
  return mainWindow.webContents.getPrintersAsync();
});

// ── Supply levels from printer.options ───────────────────────────────────────
// Electron's getPrintersAsync() already includes marker-* attributes from the
// printer driver — no CUPS HTTP request needed.

function parseSupplyLevels(printer) {
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

// ── Cross-platform printer status ─────────────────────────────────────────────

// Electron's printer.status codes: 0=Idle, 1=Processing, 2=Paused, 3=Stopped, 4=Error
const ELECTRON_STATUS_MAP = { 0: "ready", 1: "printing", 2: "queue_stopped", 3: "disconnected", 4: "unknown" };

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
  const name = printer.name.replace(/'/g, "''");
  let state = "unknown";
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "Get-Printer -Name '${name}' | Select-Object -ExpandProperty PrinterStatus"`
    );
    const s = stdout.trim().toLowerCase();
    if (s === "normal") state = "idle";
    else if (s === "printing") state = "printing";
    else if (s === "offline" || s === "error" || s === "degraded") state = "stopped";
  } catch { /* PS unavailable */ }

  const deviceUri = printer.options?.["device-uri"] ?? "";
  if (deviceUri.startsWith("usb://")) {
    try {
      const brand = printer.displayName.split(" ")[0];
      const { stdout } = await execAsync(
        `powershell -NoProfile -Command "Get-PnpDevice | Where-Object {$_.FriendlyName -like '*${brand}*'} | Select-Object -ExpandProperty Status"`
      );
      if (stdout.trim().toLowerCase() !== "ok") return "disconnected";
    } catch {
      return "unknown";
    }
  }

  if (state === "printing") return "printing";
  if (state === "stopped") return "queue_stopped";
  if (state === "idle") return "ready";
  return "unknown";
}

async function getPrinterRealStatus(printer) {
  if (process.platform === "win32") return getWindowsPrinterStatus(printer);
  return getMacPrinterStatus(printer);
}

// ── IPC: get-device-info ──────────────────────────────────────────────────────

async function detectDuplexSupport(printerName) {
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

ipcMain.handle("get-device-info", async () => {
  if (!mainWindow) return { printer: null, supplyLevels: [], cupsError: null, supportsDuplex: false };

  const printers = await mainWindow.webContents.getPrintersAsync();
  const defaultPrinter = printers.find((p) => p.isDefault) || printers[0] || null;

  if (!defaultPrinter) return { printer: null, supplyLevels: [], cupsError: null, supportsDuplex: false };

  const [realStatus, supplyLevels, supportsDuplex] = await Promise.all([
    getPrinterRealStatus(defaultPrinter),
    Promise.resolve(parseSupplyLevels(defaultPrinter)),
    detectDuplexSupport(defaultPrinter.name),
  ]);

  return { printer: { ...defaultPrinter, realStatus }, supplyLevels, cupsError: null, supportsDuplex };
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
// Uses lpr — Chromium's PDF viewer runs in an OOPIF sub-process so
// webContents.print() captures a blank frame. lpr sends the raw PDF to CUPS.

ipcMain.handle("print-file", async (event, options = {}) => {
  const {
    fileData,
    fileName,
    copies = 1,
    printerName,
    colorMode = "color",
    duplex = "simplex",
    pageRange,
  } = options;

  console.log("[Companion] print-file:", { fileName, copies, colorMode, duplex, pageRange });

  const buffer = Buffer.from(fileData);
  const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  const tempPath = path.join(tmpdir(), `print-${Date.now()}-${safeName}`);
  await writeFile(tempPath, buffer);

  if (mainWindow) mainWindow.webContents.send("print-stage", "printing");

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
    if (duplex === "longEdge") lprArgs.push("-o", "sides=two-sided-long-edge");
    else if (duplex === "shortEdge") lprArgs.push("-o", "sides=two-sided-short-edge");
    else lprArgs.push("-o", "sides=one-sided");

    // Page range — standard CUPS `page-ranges` (1-indexed, already in UI format)
    if (pageRange && pageRange !== "all") lprArgs.push("-o", `page-ranges=${pageRange}`);

    lprArgs.push(tempPath);
    console.log("[Companion] lpr args:", lprArgs);

    await execFileAsync("lpr", lprArgs);
    console.log("[Companion] print-file: lpr succeeded");
    return { success: true, stage: "complete" };
  } catch (error) {
    console.error("[Companion] print-file error:", error);
    return { success: false, stage: "error", error: error.message };
  } finally {
    // Always restore color default and clean up the temp file
    if (isGrayscale && printerName) {
      await execAsync(`lpoptions -p "${printerName}" -o CNIJGrayScale=0 2>/dev/null`).catch(() => {});
    }
    setTimeout(() => unlink(tempPath).catch(() => {}), 5000);
  }
});

// ── IPC: get-print-queue ──────────────────────────────────────────────────────

ipcMain.handle("get-print-queue", async () => {
  // No CUPS dependency — return empty; companion doesn't track the OS spooler.
  return [];
});

// ── IPC: print-file-native (PDF via webContents.print) ────────────────────────
// Uses Electron's webContents.print() so color/pageRanges/duplexMode are
// applied by Chromium itself — no PPD option guessing needed.

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
    colorMode = "color", duplex = "simplex", pageRange,
  } = options;

  console.log("[Companion] print-file-native:", { fileName, copies, colorMode, duplex, pageRange });

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

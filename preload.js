const { contextBridge, ipcRenderer } = require("electron");

// ipcRenderer.on registers the wrapper, not the caller's callback, so `off` has
// to be handed that same wrapper. Passing the original callback silently
// removed nothing and leaked a listener on every print job.
const stageWrappers = new WeakMap();
const progressWrappers = new WeakMap();

function subscribe(registry, channel, cb) {
  if (typeof cb !== "function" || registry.has(cb)) return;
  const wrapper = (_event, payload) => cb(payload);
  registry.set(cb, wrapper);
  ipcRenderer.on(channel, wrapper);
}

function unsubscribe(registry, channel, cb) {
  const wrapper = typeof cb === "function" ? registry.get(cb) : null;
  if (wrapper) {
    ipcRenderer.off(channel, wrapper);
    registry.delete(cb);
  } else if (cb === undefined) {
    ipcRenderer.removeAllListeners(channel);
  }
}

contextBridge.exposeInMainWorld("electronAPI", {
  // Check if running in Electron
  isElectron: true,

  // Get list of available printers
  getPrinters: () => ipcRenderer.invoke("get-printers"),

  // Get default printer details + supply levels (paper/ink) via CUPS IPP
  getDeviceInfo: () => ipcRenderer.invoke("get-device-info"),

  // Silent print with options: { html: string, printerName?: string }
  print: (options) => ipcRenderer.invoke("print", options),

  // Print raw file (PDF, image, etc.): { fileData: ArrayBuffer, fileName: string, copies?: number, printerName?: string }
  printFile: (options) => ipcRenderer.invoke("print-file", options),

  // Print file via webContents.print() — Chromium-native color/pageRanges/duplexMode
  printFileNative: (options) => ipcRenderer.invoke("print-file-native", options),

  // Legacy: print "Hello World"
  printHello: () => ipcRenderer.invoke("print-hello"),

  // Subscribe to print stage events emitted by the main process during a print job.
  // The callback receives a PrintStage string:
  //   'preparing' | 'spooling' | 'printing' | 'complete' | 'error'
  onPrintStage: (cb) => subscribe(stageWrappers, "print-stage", cb),

  // Remove a previously registered print-stage listener
  offPrintStage: (cb) => unsubscribe(stageWrappers, "print-stage", cb),

  // Richer companion of print-stage, carrying what the OS spooler actually
  // reports for the job: { stage, pagesPrinted?, totalPages?, code?, message?,
  // confirmed? }. `stage: 'blocked'` is a recoverable stop (paper out, offline)
  // that the job resumes from on its own — it never reaches print-stage.
  onPrintProgress: (cb) => subscribe(progressWrappers, "print-progress", cb),
  offPrintProgress: (cb) => unsubscribe(progressWrappers, "print-progress", cb),

  // Get the current OS print spooler queue for a printer (default when omitted)
  getPrintQueue: (printerName) => ipcRenderer.invoke("get-print-queue", printerName),

  // Subscribe to push-based printer status changes from the main process
  onPrinterStatusChange: (cb) =>
    ipcRenderer.on("printer-status-change", (_event, status) => cb(status)),

  // Unsubscribe all printer-status-change listeners (safe — only usePrinterFeedback subscribes)
  offPrinterStatusChange: (_cb) =>
    ipcRenderer.removeAllListeners("printer-status-change"),

  // Resolve the physical printer state on demand: 'ready' | 'printing' |
  // 'queue_stopped' | 'disconnected' | 'unknown'. Cheaper than getDeviceInfo.
  getPrinterRealStatus: () => ipcRenderer.invoke("get-printer-real-status"),

  // Subscribe to realStatus changes pushed by the main process. Separate channel
  // from printer-status-change so the status reporter and usePrinterFeedback
  // can subscribe independently.
  onPrinterRealStatus: (cb) =>
    ipcRenderer.on("printer-real-status", (_event, status) => cb(status)),

  // Unsubscribe all printer-real-status listeners
  offPrinterRealStatus: () => ipcRenderer.removeAllListeners("printer-real-status"),
});


const { contextBridge, ipcRenderer } = require("electron");

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
  // The callback receives a PrintStage string: 'printing' | 'complete' | 'error'
  onPrintStage: (cb) =>
    ipcRenderer.on("print-stage", (_event, stage) => cb(stage)),

  // Remove a previously registered print-stage listener
  offPrintStage: (cb) => ipcRenderer.off("print-stage", cb),

  // Get the current OS print spooler queue
  getPrintQueue: () => ipcRenderer.invoke("get-print-queue"),

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


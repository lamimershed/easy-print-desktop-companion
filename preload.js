const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // Get list of available printers
  getPrinters: () => ipcRenderer.invoke("get-printers"),

  // Silent print with options: { html: string, printerName?: string }
  print: (options) => ipcRenderer.invoke("print", options),

  // Print raw file (PDF, image, etc.): { fileData: ArrayBuffer, fileName: string, copies?: number, printerName?: string }
  printFile: (options) => ipcRenderer.invoke("print-file", options),

  // Legacy: print "Hello World"
  printHello: () => ipcRenderer.invoke("print-hello"),

  // Check if running in Electron
  isElectron: true,
});

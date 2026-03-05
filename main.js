require("dotenv").config();
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { writeFile, unlink } = require("fs/promises");
const { exec } = require("child_process");
const { promisify } = require("util");
const { tmpdir } = require("os");

const execAsync = promisify(exec);

// Configuration from .env
const WEB_APP_URL =
  process.env.WEB_APP_URL || "https://safe-print-drop.vercel.app/shop";

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

  // Load the remote web app
  mainWindow.loadURL(WEB_APP_URL);

  // Intercept window.print() and redirect to silent printing
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.executeJavaScript(`
      window.print = function() {
        if (window.electronAPI && window.electronAPI.print) {
          // Get the current page HTML for printing
          const html = document.documentElement.outerHTML;
          window.electronAPI.print({ html: html });
        }
      };
      console.log('Print interceptor installed');
    `);
  });

  // Open DevTools in development
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Get list of printers
ipcMain.handle("get-printers", async () => {
  const printers = await mainWindow.webContents.getPrintersAsync();
  return printers;
});

// Silent print with custom HTML content
ipcMain.handle("print", async (event, options = {}) => {
  const { html, printerName } = options;

  // Create a hidden window to print from
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
    },
  });

  // Default HTML if none provided
  const content =
    html ||
    `
    <html>
      <body style="font-size: 24px; text-align: center; padding-top: 50px;">
        <h1>Hello World</h1>
      </body>
    </html>
  `;

  await printWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(content)}`,
  );

  return new Promise((resolve, reject) => {
    const printOptions = {
      silent: true,
      printBackground: true,
    };

    // Use specific printer if provided
    if (printerName) {
      printOptions.deviceName = printerName;
    }

    printWindow.webContents.print(printOptions, (success, errorType) => {
      printWindow.close();
      if (success) {
        resolve({ success: true });
      } else {
        console.error("Print failed:", errorType);
        resolve({ success: false, error: errorType });
      }
    });
  });
});

// Legacy support for print-hello
ipcMain.handle("print-hello", async () => {
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
    },
  });

  await printWindow.loadURL(`data:text/html,
    <html>
      <body style="font-size: 24px; text-align: center; padding-top: 50px;">
        <h1>Hello World</h1>
      </body>
    </html>
  `);

  printWindow.webContents.print(
    {
      silent: true,
      printBackground: true,
    },
    (success, errorType) => {
      printWindow.close();
      if (!success) {
        console.error("Print failed:", errorType);
      }
    },
  );

  return true;
});

// Print raw file (PDF, image, etc.) using system lpr command
ipcMain.handle("print-file", async (event, options = {}) => {
  const {
    fileData,
    fileName,
    copies = 1,
    printerName,
    colorMode = "color",
  } = options;

  try {
    // Convert ArrayBuffer to Buffer
    let buffer = Buffer.from(fileData);

    // For images with blackwhite mode, convert to grayscale
    // Note: For now we pass colorMode to lpr, actual grayscale conversion
    // would require image processing library like sharp
    // macOS lpr doesn't natively support grayscale, so this is a placeholder
    // A full implementation would use: const sharp = require('sharp');
    // buffer = await sharp(buffer).grayscale().toBuffer();

    // Create temp file path with sanitized filename
    const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
    const tempPath = path.join(tmpdir(), `print-${Date.now()}-${safeName}`);

    // Write buffer to temp file
    await writeFile(tempPath, buffer);

    // Build lpr command
    let command = `lpr -# ${copies}`;

    // Add color mode option (if supported by printer)
    // Note: -o ColorModel=Gray works on many printers for grayscale
    if (colorMode === "blackwhite") {
      command += ` -o ColorModel=Gray`;
    }

    if (printerName) {
      command += ` -P "${printerName}"`;
    }
    command += ` "${tempPath}"`;

    // Execute print command
    await execAsync(command);

    // Cleanup temp file after delay
    setTimeout(() => {
      unlink(tempPath).catch(() => {});
    }, 5000);

    return { success: true };
  } catch (error) {
    console.error("Print file failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Print failed",
    };
  }
});

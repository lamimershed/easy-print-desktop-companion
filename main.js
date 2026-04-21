require("dotenv").config();
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { writeFile, unlink } = require("fs/promises");
const { exec } = require("child_process");
const { promisify } = require("util");
const { tmpdir } = require("os");
const http = require("http");

const execAsync = promisify(exec);


// Configuration from .env
const WEB_APP_URL = process.env.WEB_APP_URL || "http://localhost:5174"; // Default to localhost for development

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
  mainWindow.webContents.openDevTools();
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

  console.log("[Companion] print-file called:", {
    fileName,
    copies,
    colorMode,
    hasData: !!fileData,
  });

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
    console.log("[Companion] Executing:", command);
    await execAsync(command);
    console.log("[Companion] Print command executed successfully");

    // Cleanup temp file after delay
    setTimeout(() => {
      unlink(tempPath).catch(() => {});
    }, 5000);

    console.log("[Companion] Returning success");
    return { success: true };
  } catch (error) {
    console.error("Print file failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Print failed",
    };
  }
});

/**
 * Get device info: default printer + supply levels via CUPS IPP.
 *
 * CUPS IPP endpoint: http://localhost:631/printers/<printer-name>
 * Operation: Get-Printer-Attributes (0x000b)
 * The response is binary IPP — we parse the `printer-supply` group.
 *
 * Supply levels are only returned if the printer driver implements the
 * `printer-supply` IPP attribute (most modern CUPS drivers do).
 * Falls back gracefully with cupsError set if CUPS is unavailable.
 */
ipcMain.handle("get-device-info", async () => {
  const printers = await mainWindow.webContents.getPrintersAsync();
  const defaultPrinter =
    printers.find((p) => p.isDefault) || printers[0] || null;

  if (!defaultPrinter) {
    return { printer: null, supplyLevels: [], cupsError: "No printers found" };
  }

  let supplyLevels = [];
  let cupsError = null;

  try {
    supplyLevels = await queryCupsSupplyLevels(defaultPrinter.name);
  } catch (err) {
    cupsError = err instanceof Error ? err.message : "CUPS query failed";
    console.warn("[Companion] CUPS supply query failed:", cupsError);
  }

  return { printer: defaultPrinter, supplyLevels, cupsError };
});

/**
 * Query CUPS IPP for printer supply levels.
 * Sends a minimal IPP Get-Printer-Attributes request and parses
 * the `printer-supply` keyword attributes from the response.
 *
 * IPP supply string format (RFC 3805):
 *   "type=<type>;maxcapacity=<max>;level=<current>;colorantname=<name>;"
 */
async function queryCupsSupplyLevels(printerName) {
  return new Promise((resolve, reject) => {
    // Build a minimal IPP/1.1 Get-Printer-Attributes request
    const printerUri = `ipp://localhost/printers/${encodeURIComponent(printerName)}`;
    const requestedAttr = "printer-supply";

    const ippRequest = buildIppGetPrinterAttributes(printerUri, requestedAttr);

    const options = {
      hostname: "localhost",
      port: 631,
      path: `/printers/${encodeURIComponent(printerName)}`,
      method: "POST",
      headers: {
        "Content-Type": "application/ipp",
        "Content-Length": ippRequest.length,
      },
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        const supplyLevels = parseIppSupplyLevels(body);
        resolve(supplyLevels);
      });
    });

    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error("CUPS request timed out"));
    });

    req.write(ippRequest);
    req.end();
  });
}

/** Build a binary IPP 1.1 Get-Printer-Attributes request buffer */
function buildIppGetPrinterAttributes(printerUri, ...requestedAttrs) {
  const parts = [];

  // IPP header: version (1.1), operation-id (0x000b = Get-Printer-Attributes), request-id
  parts.push(Buffer.from([0x01, 0x01, 0x00, 0x0b, 0x00, 0x00, 0x00, 0x01]));

  // Operation attributes tag
  parts.push(Buffer.from([0x01]));

  // attributes-charset: utf-8
  parts.push(ippAttr(0x47, "attributes-charset", "utf-8"));
  // attributes-natural-language: en
  parts.push(ippAttr(0x48, "attributes-natural-language", "en"));
  // printer-uri
  parts.push(ippAttr(0x45, "printer-uri", printerUri));

  // requested-attributes
  for (const attr of requestedAttrs) {
    parts.push(ippAttr(0x44, "requested-attributes", attr));
  }

  // end-of-attributes tag
  parts.push(Buffer.from([0x03]));

  return Buffer.concat(parts);
}

/** Encode a single IPP attribute (tag + name + value) */
function ippAttr(tag, name, value) {
  const nameBuf = Buffer.from(name, "utf8");
  const valueBuf = Buffer.from(value, "utf8");
  const header = Buffer.alloc(5);
  header.writeUInt8(tag, 0);
  header.writeUInt16BE(nameBuf.length, 1);
  header.writeUInt16BE(valueBuf.length, 3);
  return Buffer.concat([header, nameBuf, valueBuf]);
}

/**
 * Parse `printer-supply` keyword values from a raw IPP response buffer.
 * Each supply string looks like:
 *   "type=inkToner(ink);maxcapacity=100;level=72;colorantname=cyan;"
 */
function parseIppSupplyLevels(buf) {
  const text = buf.toString("binary");
  const supplies = [];

  // Find all occurrences of "type=..." supply strings
  const supplyRegex =
    /type=([^;]+);maxcapacity=(\d+);level=(-?\d+);colorantname=([^;]*)/gi;
  let match;

  while ((match = supplyRegex.exec(text)) !== null) {
    const [, typeRaw, maxCapStr, levelStr, colorant] = match;
    const maxCap = parseInt(maxCapStr, 10);
    const level = parseInt(levelStr, 10);

    const levelPercent =
      maxCap > 0 && level >= 0
        ? Math.min(100, Math.round((level / maxCap) * 100))
        : null;

    const typeLower = typeRaw.toLowerCase();
    let supplyType = "other";
    if (typeLower.includes("ink") || typeLower.includes("toner")) {
      supplyType = typeLower.includes("paper") ? "paper" : "ink";
    } else if (typeLower.includes("paper") || typeLower.includes("media")) {
      supplyType = "paper";
    }

    supplies.push({
      name: colorant.trim() || typeRaw.trim(),
      type: supplyType,
      levelPercent,
    });
  }

  return supplies;
}

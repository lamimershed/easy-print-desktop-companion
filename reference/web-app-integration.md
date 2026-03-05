# Web App Integration for Silent Printing

This guide explains how to integrate your web app with the Electron shell for silent printing.

> **Note**: No changes needed in the Electron app. These changes are for your **web app** only.

---

## Step 1: Create a Utility Function

Create a file in your web app (e.g., `lib/print.ts` or `utils/print.ts`):

```ts
// lib/print.ts

interface PrintOptions {
  html?: string;
  printerName?: string;
}

// Check if running inside Electron
export const isElectron = (): boolean => {
  return typeof window !== 'undefined' && window.electronAPI?.isElectron === true;
};

// Silent print function
export async function silentPrint(options?: PrintOptions): Promise<boolean> {
  if (isElectron()) {
    const result = await window.electronAPI!.print({
      html: options?.html || document.documentElement.outerHTML,
      printerName: options?.printerName,
    });
    return result.success;
  } else {
    // Browser fallback - shows print dialog
    window.print();
    return true;
  }
}

// Get printers (only works in Electron)
export async function getPrinters() {
  if (isElectron()) {
    return await window.electronAPI!.getPrinters();
  }
  return [];
}
```

---

## Step 2: Add TypeScript Types (Optional)

Create `types/electron.d.ts`:

```ts
interface ElectronAPI {
  isElectron: boolean;
  print: (options?: { html?: string; printerName?: string }) => Promise<{ success: boolean; error?: string }>;
  printFile: (options: { fileData: ArrayBuffer; fileName: string; copies?: number; printerName?: string }) => Promise<{ success: boolean; error?: string }>;
  getPrinters: () => Promise<Array<{ name: string; isDefault: boolean; status: number }>>;
  printHello: () => Promise<boolean>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
```

---

## Step 3: Update Your Print Button/Handler

Replace wherever you call `window.print()`:

### Before

```tsx
<button onClick={() => window.print()}>Print</button>
```

### After

```tsx
import { silentPrint, isElectron } from '@/lib/print';

function PrintButton() {
  const handlePrint = async () => {
    // Option A: Print current page
    await silentPrint();
    
    // Option B: Print custom receipt HTML
    await silentPrint({
      html: `
        <html>
          <head>
            <style>
              body { font-family: monospace; width: 80mm; margin: 0; padding: 10px; }
            </style>
          </head>
          <body>
            <h2>Order #123</h2>
            <p>Coffee x2 - $6.00</p>
            <p>Total: $9.50</p>
          </body>
        </html>
      `
    });
  };

  return (
    <button onClick={handlePrint}>
      {isElectron() ? 'Print (Silent)' : 'Print'}
    </button>
  );
}
```

---

## Step 4 (Optional): Show Printer Selector

```tsx
import { getPrinters, silentPrint, isElectron } from '@/lib/print';
import { useEffect, useState } from 'react';

function PrintWithPrinterSelect() {
  const [printers, setPrinters] = useState([]);
  const [selectedPrinter, setSelectedPrinter] = useState('');

  useEffect(() => {
    if (isElectron()) {
      getPrinters().then(setPrinters);
    }
  }, []);

  const handlePrint = () => {
    silentPrint({ printerName: selectedPrinter || undefined });
  };

  if (!isElectron()) {
    return <button onClick={() => window.print()}>Print</button>;
  }

  return (
    <div>
      <select value={selectedPrinter} onChange={(e) => setSelectedPrinter(e.target.value)}>
        <option value="">Default Printer</option>
        {printers.map((p) => (
          <option key={p.name} value={p.name}>{p.name}</option>
        ))}
      </select>
      <button onClick={handlePrint}>Print</button>
    </div>
  );
}
```

---

## Summary

| File | Purpose |
|------|---------|
| `lib/print.ts` | Utility functions for printing |
| `types/electron.d.ts` | TypeScript types (optional) |
| Your component | Replace `window.print()` with `silentPrint()` |

---

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  Web App (Browser or Electron)                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │  silentPrint({ html: '...' })                     │  │
│  │       │                                           │  │
│  │       ▼                                           │  │
│  │  isElectron() ───► false ───► window.print()     │  │
│  │       │                        (shows dialog)     │  │
│  │       ▼                                           │  │
│  │      true                                         │  │
│  │       │                                           │  │
│  │       ▼                                           │  │
│  │  window.electronAPI.print()                       │  │
│  └───────────────────────────────────────────────────┘  │
│              │                                          │
│              ▼ (IPC)                                    │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Electron Main Process                            │  │
│  │  - Creates hidden window                          │  │
│  │  - Loads HTML content                             │  │
│  │  - Prints silently to default/specified printer   │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

This approach is **reliable and production-grade** — the same pattern used by Slack, Discord, and Figma.

---

## Printing Raw Files (PDF, Images, etc.)

For printing existing files (not HTML), use `printFile`:

```ts
// lib/print.ts - add this function

interface PrintFileOptions {
  fileData: ArrayBuffer;
  fileName: string;
  copies?: number;
  printerName?: string;
}

export async function printFile(options: PrintFileOptions): Promise<boolean> {
  if (isElectron()) {
    const result = await window.electronAPI!.printFile(options);
    return result.success;
  }
  // No browser fallback for raw file printing
  console.warn('printFile only works in Electron');
  return false;
}
```

### Usage Examples

```tsx
// Print a PDF from a URL
async function printPdfFromUrl(url: string) {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  
  await printFile({
    fileData: arrayBuffer,
    fileName: 'document.pdf',
    copies: 1,
  });
}

// Print a PDF from file input
async function handleFileInput(event: React.ChangeEvent<HTMLInputElement>) {
  const file = event.target.files?.[0];
  if (!file) return;
  
  const arrayBuffer = await file.arrayBuffer();
  
  await printFile({
    fileData: arrayBuffer,
    fileName: file.name,
    copies: 2,
    printerName: 'Canon MG2500 series', // optional
  });
}

// Print a generated PDF (e.g., from jsPDF or pdf-lib)
async function printGeneratedPdf(pdfBytes: Uint8Array) {
  await printFile({
    fileData: pdfBytes.buffer,
    fileName: 'receipt.pdf',
  });
}
```

### Flow Diagram

```
┌─────────────────────────────────────────────────────────┐
│  Web App                                                │
│  ┌───────────────────────────────────────────────────┐  │
│  │  printFile({                                      │  │
│  │    fileData: ArrayBuffer,                         │  │
│  │    fileName: "receipt.pdf",                       │  │
│  │    copies: 2                                      │  │
│  │  })                                               │  │
│  └───────────────────────────────────────────────────┘  │
│              │                                          │
│              ▼ (IPC)                                    │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Electron Main Process                            │  │
│  │  1. Buffer.from(fileData)                         │  │
│  │  2. Write to /tmp/print-xxx-receipt.pdf           │  │
│  │  3. exec(`lpr -# 2 "/tmp/..."`)                   │  │
│  │  4. Delete temp file after 5 seconds             │  │
│  └───────────────────────────────────────────────────┘  │
│              │                                          │
│              ▼                                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │  System Printer                                   │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

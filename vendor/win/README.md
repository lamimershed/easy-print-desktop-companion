# Bundled print engine (Windows only)

`SumatraPDF.exe` is the Windows print engine used by `printFileWindows()` in
`main.js`. It plays the role CUPS `lpr` plays on macOS: it takes the raw PDF and
sends it to the spooler with copies / duplex / colour / paper-size / page-range
settings applied.

It is needed because Chromium's PDF viewer renders in an out-of-process iframe,
so `webContents.print()` captures a blank frame — the same reason the macOS path
shells out to `lpr` rather than printing in-process.

## Provenance

| | |
|---|---|
| Version | 3.5.2 (64-bit) |
| Source | https://www.sumatrapdfreader.org/dl/rel/3.5.2/SumatraPDF-3.5.2-64.zip |
| Zip SHA-256 | `66ccb395c9184dce6822dfbb9970c877383b3ead6d9417b5106a844aac512989` |
| Exe SHA-256 | `290e4aa7ed64c728138711c011e89aab7aa48dbc1ae430371dc2be4100b92bf0` |
| Licence | GPLv3 |
| Retrieved | 2026-09-03 |

The archive ships the file as `SumatraPDF-3.5.2-64.exe`; it is renamed to
`SumatraPDF.exe` here so `main.js` can resolve a stable path.

## Licence obligation

SumatraPDF is GPLv3. It is bundled as a **separate, unmodified executable**
invoked over a command line — it is not linked into the Electron app. Shipping it
this way requires that the corresponding source remain available, which it is at
https://github.com/sumatrapdfreader/sumatrapdf. Do not statically link it or
modify it without revisiting the licence terms.

## Packaging

`package.json` → `build.extraResources` copies `vendor/win` to
`resources/vendor/win` in the installed app, deliberately *outside* the asar so
the file stays executable. `sumatraBinaryPath()` in `main.js` switches between
the dev path and `process.resourcesPath` via `app.isPackaged`.

## Upgrading

Replace the exe, then update the version and both hashes above.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install                # Install dependencies
pnpm start                  # Run in dev (loads .env → usually a localhost dashboard)
pnpm build:mac              # Build the macOS .dmg
pnpm build:win              # Build the Windows installer + portable exe
pnpm build:win:download     # Same, then copy both .exe files to ~/Downloads
```

There is no test suite. `node --check main.js` is the only static gate; the
behaviour that matters here only shows up against a real printer.

## What this is

A thin Electron shell around the dashboard web app. It loads `WEB_APP_URL` in a
`BrowserWindow` and exposes an `electronAPI` bridge (`preload.js`) that the
dashboard calls for the things a browser cannot do: enumerate printers, read
supply levels, and print a PDF to a named printer while reporting what the OS
spooler says about it.

All session, socket and payment logic lives in the dashboard, not here. This
process owns exactly one thing: **turning "we submitted a job" into an outcome
somebody actually observed.**

- `main.js` — everything: window, printer probes, print engines, spool watchdog
- `preload.js` — the `contextBridge` surface and its IPC channel wrappers
- `vendor/win/SumatraPDF.exe` — the Windows print engine, shipped in the installer
- `build/` — electron-builder's **resources** directory (icons). Not an output;
  `dist/` is. Do not add it to `.gitignore` — that left `build/icon.ico`
  untracked while `package.json` pointed the Windows target at it.

## Env

`.env.production` is **committed on purpose** and is the only env file
electron-builder bundles. It holds no secret, and a build that reads its URL
from an untracked file is a build nobody else can reproduce. `.env` stays
untracked and is what dev loads.

## The rules that matter

**Submitting is not printing.** `lpr` returns the moment CUPS accepts a job and
SumatraPDF exits the moment the Windows spooler accepts one. Both succeed while
the printer is offline, jammed, paused, out of paper or switched off. Every
print therefore goes through `watchSpoolJob`, which follows the job through the
OS spooler and returns one of exactly three things:

| Outcome               | Meaning                                              |
| --------------------- | ---------------------------------------------------- |
| confirmed success     | the spooler showed us the job finish                 |
| unconfirmed success   | submitted cleanly, but we never got a view of it     |
| `PrintFailure`        | a classified, human-readable reason                  |

Collapsing the middle one into plain success is what made the customer's status
untrustworthy. It is reported as `confirmed: false` all the way to the
customer's success screen, which then says "collect and check" instead of
asserting the pages came out.

**`null` from a `listJobs` is "unreadable", never "empty".** Conflating the two
reports a PowerShell failure to the customer as a successful print. The watchdog
rides out `MAX_SPOOLER_READ_FAILURES` consecutive unreadable polls before giving
up, and gives up as an *unconfirmed* success.

**Recoverable stops are not failures.** Out of paper, offline, paused and
needs-attention are relayed live as `stage: 'blocked'` with a reason the
customer can read, and only become a `PrintFailure` if they outlast
`BLOCKED_GRACE_MS`. The shop refills the tray and the job resumes on its own.

**Preflight refuses rather than queues.** Windows queues into a black hole when
the printer is paused, offline, has "Use Printer Offline" ticked, or is simply
switched off — and reports `Normal` for the last of those right up until you
print into it. `preflightWindows` checks all four, including asking the device
layer whether a USB printer is physically present, because the alternative was
a customer watching a progress bar for the three minutes it took the watchdog's
idle timeout to notice.

## Windows specifics

**Every Windows probe runs in one long-lived PowerShell worker, serialised and
timed out.** A fresh `powershell.exe` per probe cost 1.5–5s (start-up plus
loading PrintManagement over WMI), and a print made a dozen in a row before
SumatraPDF started. The worker (`startPsWorker`) is started at launch and takes
one base64 script per stdin line, answering `__PSW__ <ok> <base64>`. Any error
record — even one hidden by `-ErrorAction SilentlyContinue` — fails the probe,
which is what keeps an unreadable spooler `null` rather than an empty queue.
Empty output is a valid answer (an empty queue is exactly that).
`runPowerShell` runs one script at a time behind a promise chain with an 8s
per-call ceiling; a timed-out probe kills the worker and the next probe starts
a fresh one. Start-up has its own 20s ceiling so a cold machine does not eat a
probe's budget. Both parts are load-bearing: `Get-Printer` against
a printer that dropped off the network genuinely never returns on some
driver/port combinations, and one of those inside the watchdog's 1.5s poll loop
hangs the loop for the life of the app. Unserialised, the watchdog and the
status poll pile up `powershell.exe` processes faster than they retire on
exactly the machine where it matters. The status poll also stands down entirely
while a print is in flight (`_printsInFlight`).

**PowerShell 5.1 vs 7 both have to parse.** `ConvertTo-Json` renders a flag enum
as an integer and serialises a lone object rather than a one-element array under
5.1, and dates as `/Date(…)/` rather than ISO-8601 — hence `[string]$_.JobStatus`,
the `@(…)` wrapper, and `parsePsDate`.

**Chromium cannot print a PDF.** Its PDF viewer runs in an OOPIF sub-process, so
`webContents.print()` captures a blank frame. Both platforms hand the raw file
to an external engine instead: CUPS `lpr` on macOS, bundled SumatraPDF on
Windows. `print-file-native` is kept only for the printer-test page.

**Supply levels come from SNMP or not at all.** Windows has no universal ink API.
Network printers answer the Printer-MIB (RFC 3805); USB printers expose nothing,
and we report an empty list rather than invent numbers. The whole probe carries
a hard ceiling because `net-snmp`'s done-callback is not guaranteed to fire.

**One instance per shop PC.** Two copies both answer `client:join` for the same
client and the backend hands jobs to whichever socket connected last, so the
window the staff are looking at is not necessarily the one that prints.
`requestSingleInstanceLock` makes the inevitable second double-click focus the
first window instead.

**Shop PCs sleep.** The backend gates customer uploads on the last printer
status this app reported, so a woken machine that kept advertising a stale
"ready" for a printer since switched off would take customers' money for
nothing. `powerMonitor` resume/unlock re-probe immediately rather than waiting
for the 30s poll to come round.

## Escaping

Two different escapes, and they are not interchangeable:

- `escapePs` — for a PowerShell **single-quoted string literal** (`'` → `''`).
  Every probe goes through `execFile`, not `exec`, so the script is one argv
  entry and there is no `cmd.exe` quoting layer to get wrong.
- `escapeShellArg` — for the double-quoted `exec` calls that remain on the macOS
  `lpoptions`/`lpstat` paths.

## Debugging a packaged build

A packaged build used to have no way to show its console, so a shop PC that
could not reach the server looked exactly like one that could. Now:

- `Ctrl+Shift+I` (Windows) / `Cmd+Alt+I` (macOS) toggles DevTools
- `--devtools` on the command line opens them from launch
- the renderer's `[socket]` logs and any error-level logs are mirrored into the
  main-process stdout, so launching the exe from a terminal is enough

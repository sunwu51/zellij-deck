# Side Shell · Zellij

A Chrome side-panel extension that keeps a local Zellij terminal alongside the page you are browsing. It uses xterm.js, a loopback-only Node.js WebSocket bridge, and your existing Zellij installation.

## Quick start (Windows and macOS)

Requirements: Node.js 22 or newer, Chrome 116 or newer, and a native Zellij installation. Read-only monitoring requires a Zellij version that supports `zellij watch`. The same extension build runs on both operating systems; install bridge dependencies separately on each machine, because node-pty contains platform-specific native binaries.

### macOS (Apple Silicon or Intel)

Install Node.js and Zellij with Homebrew, if they are not installed:

```sh
brew install node@24 zellij
export PATH="$(brew --prefix node@24)/bin:$PATH"
```

If node-pty needs to compile from source, install Apple's Command Line Tools (`xcode-select --install`) first. Then clone this repository, enter its directory, and follow the commands below. The bridge searches PATH, `/opt/homebrew/bin`, `/usr/local/bin`, and `~/.cargo/bin` for Zellij. Launch the bridge from Terminal/iTerm using the same macOS user as your existing Zellij sessions.

### Windows

Install Node.js and native Windows Zellij. The bridge searches PATH and `%LOCALAPPDATA%\\Zellij\\zellij.exe`. WSL sessions are separate from native Windows sessions and are not automatically bridged.

### Both platforms

```powershell
npm install
npm run build
npm run bridge
```

The bridge prints its port and pairing token. Keep this terminal running.

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and choose this project's **dist** folder.
3. Pin **Side Shell · Zellij**, then click its toolbar icon to open the sidebar. The suggested shortcut is **Alt+Shift+J**; change it in `chrome://extensions/shortcuts` if Chrome reserves it.
4. Paste the bridge's pairing token into the sidebar settings and click **Save & connect bridge**. The default port is **17329**. This verifies access and loads sessions; it does not open a terminal yet.
5. Choose a session and click **Open session**. **Watch** is read-only; **Interact** attaches a normal Zellij client.
6. To start a dedicated session for the sidebar, expand **Create a session**, enter a name, and click **Create**. You can create another while connected.
7. To switch, choose another session and mode, then click **Switch**. The previous session keeps running. There is one visible terminal at a time, but multiple persistent sessions can run.

A **bridge** is the local transport service. A **session** is a persistent Zellij workspace with its own shells, panes, and tasks. Session listing uses authenticated HTTP; an opened terminal streams input/output over WebSocket. Saving bridge settings is separate from opening a workspace.

Existing sessions from the native Zellij installation on the machine running the bridge appear automatically, including exited sessions. Interactively attaching to an exited session can resurrect it; watching an exited session may fail until it has been resurrected. Session names in this MVP are restricted to 1–96 ASCII letters, numbers, dots, underscores, and hyphens, beginning with a letter or number.

## What stays running?

Closing the side panel, clicking **Detach**, or stopping the bridge closes only the attached Zellij client. The Zellij session server and its tasks continue running. Reopen the panel and reconnect to redraw the current session. Browser scrollback is not persisted; Zellij is responsible for session state.

The panel automatically retries an interrupted connection up to ten times with capped exponential backoff. It does not automatically connect merely because you open the panel, and it does not reconnect after a deliberate detach or normal client exit.

A closed sidebar cannot display output or show notifications. This MVP does not request background notification permissions or monitor terminal output while its UI is closed.

Watch mode uses the actual `zellij watch` command and also drops input at the bridge, rather than merely hiding the keyboard UI. Interactive attachment may change a shared session's layout or effective terminal dimensions; prefer **Watch** when monitoring another terminal. Existing session configuration still controls how Zellij renders itself.

## Keyboard shortcuts and clipboard

Click the terminal and use **Interact** mode to send keyboard input. Watch mode never sends input.

| Action | Shortcut / control |
| --- | --- |
| Paste clipboard text | **Ctrl+V** or **Ctrl+Shift+V** (macOS: **Cmd+V**) |
| Copy selected terminal text | **Ctrl+Shift+C** (macOS: **Cmd+C**) |
| Interrupt a terminal process | **Ctrl+C** (unchanged; not Copy) |
| Send a Chrome-reserved Ctrl combination | **Ctrl+.**, release, then press a letter |
| Send Ctrl+T to Zellij | **Ctrl+.**, then **T**, or choose **Ctrl+T** and click **Send Ctrl** |
| Cancel a pending Ctrl prefix | **Escape**, focus outside the terminal, or wait five seconds |
| Send literal Ctrl+V rather than paste | **Ctrl+.**, then **V**, or choose **Ctrl+V (literal)** and click **Send Ctrl** |

The prefix is scoped to the focused xterm terminal; settings fields keep normal editing behavior. It maps A–Z to standard terminal control bytes. It is not a global shortcut remapping and does not change Zellij's configuration. The toolbar returns focus to the terminal after sending a key, so subsequent Zellij mode keys can be typed normally.

Chrome reserves shortcuts such as Ctrl+T, Ctrl+W, Ctrl+N, and Ctrl+Tab before a side-panel page can reliably handle them. `preventDefault()` and xterm handlers cannot guarantee reclaiming those shortcuts; the prefix/toolbar avoids the conflict rather than trying to override Chrome. Other Ctrl keys continue through xterm's standard handling. A native terminal remains preferable when exact desktop keyboard behavior is required.

Paste uses Chrome's real clipboard paste event and xterm's bracketed-paste behavior, rather than sending the literal Ctrl+V byte. This supports **text only**. Clipboard images/files do not pass through the terminal text stream; applications that support image paste in a native terminal may need a separate image-transfer integration here. No background clipboard reading is performed. The extension requests `clipboardWrite` for explicit Copy actions.

## Configuration

Optional bridge environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEBSHELL_PORT` | `17329` | Loopback listening port (1024–65535). Also set this in sidebar settings. |
| `ZELLIJ_PATH` | Zellij on PATH | Absolute executable path if discovery fails. |
| `WEBSHELL_CWD` | Your home directory | Working directory for Zellij clients/new sessions. |
| `WEBSHELL_STATE_DIR` | This project's `.bridge` directory | Optional location for the pairing token. |
| `WEBSHELL_EXTENSION_ID` | Any valid Chrome extension origin with the token | Restrict access to one installed extension ID. Recommended for a hardened local setup. |
| `WEBSHELL_TOKEN` | Generated random token | Override the pairing token. Use 32–256 letters, numbers, underscores, or hyphens. |

Example:

```powershell
$env:ZELLIJ_PATH = "$env:LOCALAPPDATA\Zellij\zellij.exe"
$env:WEBSHELL_EXTENSION_ID = "your-extension-id-from-chrome-extensions"
npm run bridge
```

The example extension ID is a placeholder; replace it with the real 32-character ID before running. Omit this variable for the default pairing flow.

macOS configuration example (normally no override is needed):

```sh
ZELLIJ_PATH="$(command -v zellij)" npm run bridge
```

The generated token is stored in this project's `.bridge/token`, independent of the directory from which you launch the bridge. `WEBSHELL_STATE_DIR` overrides that directory. The extension stores its copy in device-local Chrome extension storage, not Chrome Sync. Treat it as a credential: possession permits interactive shell access through the bridge. To rotate a generated token, stop the bridge, delete `.bridge/token`, restart, and pair again.

The bridge uses Windows ConPTY on Windows and Unix PTYs on macOS through node-pty. Zellij discovery supports native Windows, Apple Silicon Homebrew, Intel Homebrew, and Cargo installations. Linux PATH discovery is also supported, but Linux is not currently in the CI matrix.

When moving between Windows and macOS, clone the source, run `npm ci` and `npm run build` locally, and pair using the new machine's bridge token. Do not copy `.bridge/` credentials or `node_modules/`. Sessions are local to each OS/user; migration does not transfer a running Windows session to macOS. Shared client behavior applies to Terminal/iTerm on macOS in the same way as WT on Windows.

Windows native Zellij integration is tested locally. GitHub Actions runs type checks, unit tests, and builds on Windows and macOS with Node 22/24, plus a real macOS Zellij integration test using Homebrew. A configured CI job is not a passing result; check the repository's Actions tab for the actual macOS status.

### macOS Unix socket path limit

macOS Unix sockets have a short path limit. A long `$TMPDIR` combined with a long session name can cause Zellij to report `IPC socket path is too long`. Prefer short session names. If needed, use the same shorter socket directory in **both** your regular terminal and the bridge:

```sh
export ZELLIJ_SOCKET_DIR="/tmp/zellij-$(id -u)"
# Use this export in every terminal that should share these sessions.
zellij attach --create dev
# In another terminal with the same export:
npm run bridge
```

Changing the socket directory does not move existing sessions. Keep the existing setting when attaching to an already running session. The bridge preserves `ZELLIJ_SOCKET_DIR` and Zellij configuration variables, while clearing only nested-session identity variables.

## Security model

- Binds only to `127.0.0.1`; no LAN listener, remote hosting, or arbitrary destination setting.
- Checks Host and Chrome-extension Origin headers; website and null origins are rejected. For privileged HTTP extension fetches that omit Origin, requires an explicit extension-ID header plus the pairing token. WebSocket upgrades still require a valid extension Origin.
- Requires the pairing token for session listing and WebSocket upgrades.
- Sends the WebSocket token as a subprotocol, not in a URL. Traffic is unencrypted loopback traffic; local debugging tools and privileged local software can inspect it.
- Supports optional pinning to a single extension ID.
- Spawns only Zellij with validated, separate arguments; no command-string interpolation or arbitrary executable API.
- Enforces message/resize/output buffer bounds and limits concurrent WebSocket clients.
- Does not inject content scripts, read pages, capture browser history, or load scripts from a CDN.
- Bundles xterm.js locally to comply with Manifest V3's remote-code restrictions.

The local bridge is a shell-access service, not a multi-user security boundary. Do not expose it through a proxy or port forward. Origin checks alone do not authenticate native programs; keep the token private. The extension's localhost host permission covers all loopback HTTP ports so that the bridge port is configurable.

## Development and verification

```powershell
npm run check
npm test
npm run build
npm run test:integration
```

`test:integration` starts a bridge on a temporary port, verifies authentication/origin restrictions, creates a uniquely named disposable Zellij session, attaches through a native PTY, checks that detach preserves the session, and reconnects with a read-only watcher. It terminates only its own test session afterward; an exited test-session entry may remain in Zellij's session history. It does not manipulate existing sessions.

After source changes, rebuild and click **Reload** for the extension in `chrome://extensions`. Reopen the side panel.

Project layout:

```text
extension/          Manifest V3 side panel, xterm.js UI, service worker
bridge/             Authenticated localhost HTTP/WebSocket to PTY bridge
scripts/build.mjs   Local extension bundling
tests/              Protocol unit tests and native Zellij integration smoke test
dist/               Generated unpacked extension (load this folder)
```

If native dependency lifecycle scripts are blocked by your npm configuration, review and approve the `node-pty` and `esbuild` install scripts before rebuilding. Windows prebuilt node-pty binaries worked in the tested environment.

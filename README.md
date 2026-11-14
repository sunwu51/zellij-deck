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

## Fullscreen and pop-out windows

Use **⛶** in the header to toggle fullscreen. If Chrome does not permit the side panel to enter document fullscreen, Side Shell opens a dedicated fullscreen extension window instead. In a pop-out, the same button enters/exits window fullscreen and restores its previous normal/maximized state. For document fullscreen, Escape also exits; for window fullscreen use the button or the OS/Chrome fullscreen controls.

Use **↗** to open a resizable standalone terminal window. When a session is connected, the new window automatically attaches to that same session with the same Watch/Interact mode; it never implicitly creates or resurrects via `--create`. Pairing credentials are read from extension storage, not placed in the URL. Without a connected session, the new window opens the session picker.

The original sidebar remains connected. Each view is a separate Zellij client: both can operate in Interact mode, so avoid simultaneous typing. Closing either view detaches only that client. Different viewport sizes may affect the shared Zellij layout. Themes are loaded from the device's saved settings when a window opens; an already-open window does not live-sync theme edits made in another window.

## Session previews

Click **▦** in the side-panel header to open **Session previews** in a browser tab. If it is already open, that tab is focused. Like a browser automation dashboard, it shows a live thumbnail for every running Zellij session at once:

- Each card renders the session's active tab as Zellij would show it: pane positions, frames, focused-pane highlight, visible floating panes, and ANSI/24-bit colors in your saved terminal theme.
- Click a tab chip to preview another tab of that session. Click the thumbnail for a large view of the whole tab; Escape closes it.
- **Watch** / **Interact** open that session in a pop-out terminal window. Exited sessions are listed separately and can be resurrected with Interact.
- Auto-refresh defaults to every 5 seconds (off, 2s, 5s, or 15s). It pauses while the tab is hidden.

Previews are strictly read-only and do not attach a Zellij client. The bridge reads layout with `zellij action list-tabs --json` / `list-panes --json` and screen text with `dump-screen --pane-id --ansi`, so capturing never changes a session's size, focus, or active tab. Before pane text leaves the bridge, it is reduced to printable text plus SGR color/style codes. At most six Zellij query processes run at once, and at most 48 panes are captured per session. Plugin panes (status bar, tab bar, sidebars) have no screen text to dump and appear as labeled placeholders. A session with no attached client is marked **DETACHED**: it is still running in the background (Zellij keeps its server process alive after the last client leaves), but no terminal window shows it. Such a session reports no active tab, so the first tab is shown. If the dashboard says the bridge is out of date, stop the bridge and run `npm run bridge` again; a bridge started before this feature cannot capture previews. Previews require a Zellij version with these actions (verified with 0.45.1); older versions show an upgrade message on the card.

## MCP server for AI agents

The bridge also serves a [Model Context Protocol](https://modelcontextprotocol.io) endpoint, so agents (TabManager, Claude Code, Codex, any MCP client) can run commands in terminals you can watch live, type into them, and read their output:

```text
http://127.0.0.1:17329/mcp        Authorization: Bearer <pairing token>
```

Claude Code example: `claude mcp add --transport http side-shell http://127.0.0.1:17329/mcp --header "Authorization: Bearer <token>"`. Restart the bridge after updating; the sidebar and dashboard use the same token.

Side Shell does not replace an agent's built-in shell tool. Its server instructions and the `pane_open` description tell the agent to use a pane for blocking or long-running work (dev servers, watchers, long builds and tests, anything likely to take more than about 60 seconds) and for REPLs and TUIs, so you can watch it in the dashboard. Simple commands that finish in seconds stay with the agent's own shell tool.

### Isolation: one MCP session, one Zellij session

The standard `Mcp-Session-Id` is the identity. `initialize` issues a session id, and **the Zellij session an MCP session creates belongs to it**. Other MCP sessions cannot list, read, type into, close, or adopt its panes (they get "not found", which does not reveal that they exist), and your own sessions opened in the side panel are invisible to agents. The id travels in an HTTP header managed by the client, so a model cannot forge another conversation's identity. TabManager gives every conversation its own MCP session; most other clients use one per process.

This prevents accidental cross-talk. It is not an OS-level boundary: every shell runs as you, so a command inside one agent terminal could still run `zellij kill-session` on another.

### Lifetime and cleanup

An MCP session lasts 24 hours from its last request (every request renews it; change with `WEBSHELL_MCP_TTL_HOURS`, 1–720). A client that never sends `DELETE` therefore cannot leak terminals: once a session is idle past the TTL, the bridge kills its Zellij sessions. `DELETE /mcp` with the session header ends it immediately. A bridge restart keeps sessions (`.bridge/mcp-sessions.json`, which stores no token) and grants a one-hour grace period, so downtime alone does not expire them. Rotating the pairing token invalidates old ids; their terminals are cleaned up one TTL later. A client that resumes with a new session id (for example `claude --resume`) can take over an abandoned terminal with `session_adopt` once its previous owner has been idle for two hours.

### Tools

There are no sessions, tabs, or layouts for an agent to manage. Your MCP session owns **one private Zellij session**, created by your first `pane_open`, and every pane lives in **its own full-size tab** (opened without moving focus), so agents never juggle splits and TUIs are never squeezed by neighbors. A pane is addressed by its id (`terminal_3`); with exactly one pane open it can be omitted.

| Group | Tools |
| --- | --- |
| Panes | `pane_open` (always a shell; optional `command` is typed into it and run, optional `name`, `cwd`). When a command finishes the pane is simply back at its prompt and stays usable. If the shell itself exits (for example you typed `exit`), Zellij closes the pane and its tab, `pane_list`, `pane_close` (closing the last pane ends your session; the next `pane_open` starts a new one) |
| Input | `pane_type` (literal text, optional Enter, bracketed paste for multiple lines), `pane_keys` (`Enter`, `Esc`, `Up`/`Down`, `Ctrl c`, `F5`, ...), `pane_mouse` (click, double/right click, wheel scroll at a row and column; only for programs that enabled mouse tracking). Each returns `offset`, the pane's line count just before the input |
| Output | `pane_read` (plain-text lines by `tail`, or `offset`/`limit`, with `total_lines`/`next_offset`; optional regex `pattern`), `pane_screen` (what the pane shows now, plus the cursor) |
| Waiting | `pane_wait` until a pattern appears or output goes idle; always returns within 45 s, or earlier with `closed` if the pane is closed meanwhile (later calls say the pane "was closed" rather than "not found") |
| Session | `session_kill` (end all your panes; the next `pane_open` starts fresh), `session_adopt` (take over an abandoned session after resuming a conversation) |

Agent sessions are named `ag-<client>-xxxxxx`, so they also appear in the dashboard and can be watched or taken over from the side panel; each agent pane is one tab to preview. `pane_read` returns the pane's whole history (scrollback plus screen), not just the last command; pass the `offset` returned by `pane_type` to read only what that input produced. `pane_wait` matches lines added since your last input, so "type, then wait" works and the typed command's own echo is not matched. Menus and approval prompts in TUIs (Claude Code, Codex) are driven by reading `pane_screen` and sending `pane_keys`. Calls return within 45 seconds because common MCP clients time out at 60 seconds; long work keeps running and is polled. Panes report no exit code; an agent that needs one prints it (for example by appending `; echo EXIT=$?`).

To let TabManager connect, add its extension ID to `WEBSHELL_EXTENSION_ID` (comma-separated) if you pin origins. Native clients send no `Origin`; browser requests with any other origin are rejected, so web pages cannot reach the endpoint.

## Terminal themes and custom palettes

Open **Settings (⚙) → Terminal theme**. Choose a preset, inspect the color preview, then click **Apply theme**. This updates the existing terminal without reconnecting or saving/changing bridge credentials.

Presets:
- **Catppuccin Mocha**: standard Mocha ANSI colors, including mauve magenta.
- **Catppuccin Mocha (Claude)**: preserves the previous sidebar palette and the customized WT scheme: pink magenta and bright blue mapped to `#FF79C6`. This is the default when there is no saved preference.
- **Dracula**: dark purple background with Dracula's pink, purple, green, and yellow ANSI palette.

For a custom palette, expand **Import a custom palette**, paste a single JSON object or load a `.json` file, then click **Import & apply**. File loading alone does not apply changes. One custom palette is retained; importing another replaces it. Switching presets keeps the custom palette available. Preferences are saved in device-local extension storage, not Chrome Sync. There is no automatic inheritance from WT/iTerm.

Import requirements:
- Maximum 32 KB; strict JSON, no comments or trailing commas.
- Required: `background`, `foreground`, and all 16 ANSI colors, each as `#RRGGBB`.
- Windows Terminal `purple` / `brightPurple` / `cursorColor` map to xterm `magenta` / `brightMagenta` / `cursor`.
- Optional: `name`, `cursor` or `cursorColor`, `selectionBackground`. Cursor defaults to foreground; selection defaults to bright black.
- Copy **one object** from WT's `schemes` array, not the full settings file. Unknown fields are ignored. Invalid palettes leave the active theme unchanged.

See [examples/dracula-windows-terminal.json](examples/dracula-windows-terminal.json) for a complete importable example. Import is entirely local; files are not uploaded to the bridge or a remote service. ANSI colors respond to palette changes; applications emitting explicit 24-bit RGB colors still choose those exact colors themselves. Bold text does not automatically select a different ANSI palette slot.

The extension also bundles a licensed Nerd Font symbols fallback for Powerline separators; no OS font installation or remote font request is required.

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

In the **Ctrl key** dropdown, choose **Custom…**, enter one character, then click **Send Ctrl** or press Enter. Letters A–Z are case-insensitive. Standard punctuation mappings are also supported: Ctrl+Space / Ctrl+@ (NUL), Ctrl+[ (Escape), Ctrl+backslash, Ctrl+], Ctrl+^, Ctrl+_, and Ctrl+? (DEL). Other characters are rejected because they do not have a standard single-byte terminal Ctrl encoding. These controls are disabled outside a connected Interact session. Ctrl+S/Ctrl+Q can affect shell flow control depending on the shell's terminal configuration.

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
| `WEBSHELL_EXTENSION_ID` | Any valid Chrome extension origin with the token | Restrict access to specific installed extension IDs (comma-separated, e.g. Side Shell and TabManager). Recommended for a hardened local setup. |
| `WEBSHELL_MCP_TTL_HOURS` | `24` | Idle lifetime of an MCP session before its terminals are cleaned up (1–720). |
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
- Spawns only Zellij with validated, separate arguments; no command-string interpolation or arbitrary executable API. Session previews use only Zellij's read-only query actions.
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
extension/          Manifest V3 side panel, xterm.js UI, session-preview dashboard, service worker
bridge/             Authenticated localhost HTTP/WebSocket to PTY bridge, plus bridge/mcp/ (MCP server)
scripts/build.mjs   Local extension bundling
tests/              Protocol unit tests and native Zellij integration smoke test
dist/               Generated unpacked extension (load this folder)
```

If native dependency lifecycle scripts are blocked by your npm configuration, review and approve the `node-pty` and `esbuild` install scripts before rebuilding. Windows prebuilt node-pty binaries worked in the tested environment.

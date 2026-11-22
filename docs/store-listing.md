# Chrome Web Store listing — Zellij Deck

**Category:** Developer Tools  **Language:** English (+ 中文)  **Package:** `npm run package:store` → `release/zellij-deck-<version>.zip`

## Name
Zellij Deck

## Summary (≤132 chars)
- EN: Manage your local Zellij terminal sessions from the browser: live previews, watch or interact, one click.
- 中文: 在浏览器中管理本机 Zellij 会话:实时预览、只读观看或交互操作。

## Description (EN)
Zellij Deck turns Chrome into a control panel for the Zellij sessions already running on your computer.

• Dashboard with live, read-only previews of every session, tab and pane
• Watch (read-only) or Interact in a dedicated terminal window (xterm.js, WebGL, Unicode, Sixel images, OSC 52 clipboard)
• Create, resurrect and delete sessions
• Built-in MCP endpoint so AI coding agents can run long commands in panes you can watch

How it works: start the local bridge with `npx -y zellij-deck` (Node.js 22+ and Zellij required), copy the pairing token it prints into the extension settings, and open the dashboard. Everything stays on your machine; nothing is sent to any server.

Setup guide and source: https://github.com/sunwu51/zellij-deck

## Description (中文)
Zellij Deck 把 Chrome 变成本机 Zellij 会话的控制面板。

• 仪表盘实时只读预览所有会话、标签页和窗格
• 在独立终端窗口中「观看」(只读)或「交互」(xterm.js、WebGL、Unicode、Sixel 图片、OSC 52 剪贴板)
• 创建、恢复、删除会话
• 内置 MCP 端点,AI 编程代理可在你能观看的窗格里运行长时间命令

使用方法:运行 `npx -y zellij-deck` 启动本地 bridge(需要 Node.js 22+ 和 Zellij),把它打印的配对 token 填入扩展设置,然后打开仪表盘。所有数据只在你的电脑上流转,不会发送到任何服务器。

## Single purpose
Provide a browser dashboard and terminal windows for managing the user's own local Zellij sessions through a user-run local bridge.

## Permission justifications
- `storage`: saves the bridge address, pairing token and display preferences locally (`chrome.storage.local`).
- `clipboardWrite`: lets terminal programs (OSC 52) and Copy write to the clipboard. The clipboard is never read.
- No host permissions: the extension talks only to the user-configured bridge, which grants CORS to the extension's origin.
- CSP `connect-src http://*:* ws://*:*`: the bridge address is a user-chosen IPv4 address (loopback by default, LAN optional), so the exact host is unknown at build time. Only that address is contacted.
- CSP `'wasm-unsafe-eval'`: required by the bundled xterm.js addons. No remote code is loaded or evaluated.

## Data-use disclosures
No user data is collected, sold, or transferred. Privacy policy URL: https://github.com/sunwu51/zellij-deck/blob/master/docs/PRIVACY.md

## Assets to capture
- Icon 128×128: `extension/icons/icon-128.png` (uploaded inside the zip too)
- Screenshots 1280×800 (min. 1): (1) dashboard with several live previews, (2) enlarged tab preview, (3) terminal window in Interact mode, (4) settings with pairing token field
- Small promo tile 440×280 (required for featuring; optional to publish)

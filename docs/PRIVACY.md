# Zellij Deck — Privacy Policy

_Last updated: 2026-11-22_

Zellij Deck is a Chrome extension that talks to a bridge process (`npx -y zellij-deck`) running on a computer you control. It has no server of its own.

**What we collect:** nothing. The extension and the bridge contain no analytics, telemetry, advertising, or crash reporting, and make no requests to the developer or any third party.

**What stays on your devices:**
- Terminal content, session names, and session previews travel only between the extension and the bridge address you configure (`127.0.0.1` by default, or a LAN IPv4 address you choose explicitly).
- The bridge pairing token and your display settings (font, theme, port) are stored in `chrome.storage.local` on your device. They are not synced to your Google account.
- The bridge stores its token in `~/.zellij-deck/token` on the machine where it runs.

**Clipboard:** the extension writes to the clipboard only when a terminal program requests it (OSC 52) or you copy a selection. It never reads the clipboard.

**Third parties:** none receive your data. The extension bundles all of its code and fonts and loads no remote code.

**Contact:** open an issue at https://github.com/sunwu51/zellij-deck/issues

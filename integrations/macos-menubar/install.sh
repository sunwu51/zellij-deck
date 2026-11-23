#!/bin/bash
# Install the Zellij Deck menu bar item (macOS, via SwiftBar).
#   ./install.sh [--ext-id <id>] [--browser "Google Chrome"]
#   ./install.sh --uninstall
set -euo pipefail

[ "$(uname)" = "Darwin" ] || { echo "macOS only." >&2; exit 1; }

SRC="$(cd "$(dirname "$0")" && pwd)"
DIR="$HOME/.zellij-deck-swiftbar"
PLUGIN_NAME="zellij-deck.5s.sh"
BROWSER="${ZELLIJ_DECK_BROWSER:-Google Chrome}"
EXT_ID="${ZELLIJ_DECK_EXT_ID:-}"
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ext-id) EXT_ID="$2"; shift 2 ;;
    --browser) BROWSER="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

plugin_dir() {
  defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || true
}

if [ "$UNINSTALL" = 1 ]; then
  pd="$(plugin_dir)"
  [ -n "$pd" ] && rm -f "$pd/$PLUGIN_NAME"
  rm -rf "$DIR"
  echo "Removed the menu bar plugin. SwiftBar itself was left installed (brew uninstall --cask swiftbar to remove)."
  exit 0
fi

# 1. SwiftBar
if [ ! -d /Applications/SwiftBar.app ]; then
  command -v brew >/dev/null || { echo "Install Homebrew (https://brew.sh) or SwiftBar (https://swiftbar.app) first." >&2; exit 1; }
  brew install --cask swiftbar
fi

# 2. Plugin directory (reuse the one SwiftBar already uses)
PD="$(plugin_dir)"
if [ -z "$PD" ]; then
  PD="$HOME/SwiftBarPlugins"
  defaults write com.ameba.SwiftBar PluginDirectory "$PD"
fi
mkdir -p "$PD"

# 3. Extension ID, needed only to open the dashboard when no tab is open.
#    Unpacked and Chrome Web Store installs have different IDs, so detect it from open tabs.
if [ -z "$EXT_ID" ] && osascript -e "application \"$BROWSER\" is running" 2>/dev/null | grep -q true; then
  EXT_ID="$(osascript -e "tell application \"$BROWSER\" to get URL of every tab of every window" 2>/dev/null \
    | tr ',' '\n' | grep -oE 'chrome-extension://[a-z]{32}/(terminal|dashboard)\.html' | head -1 | cut -d/ -f3)"
fi
[ -n "$EXT_ID" ] || echo "Note: extension ID not detected (open the dashboard in $BROWSER and re-run, or pass --ext-id). The Dashboard item will only focus an already-open tab."

# 4. Files
mkdir -p "$DIR"
install -m 755 "$SRC/zellij-deck-ctl.sh" "$DIR/zellij-deck-ctl.sh"
# 36px at 144 dpi renders at 18pt, which fits the menu bar.
cp "$SRC/../../extension/icons/icon-48.png" "$DIR/icon.png"
sips -z 36 36 -s dpiWidth 144 -s dpiHeight 144 "$DIR/icon.png" >/dev/null
cat > "$DIR/config.sh" <<EOF
ZELLIJ_DECK_BROWSER="$BROWSER"
ZELLIJ_DECK_EXT_ID="$EXT_ID"
EOF
install -m 755 "$SRC/$PLUGIN_NAME" "$PD/$PLUGIN_NAME"

open -a SwiftBar
echo "Installed. Look for the Zellij Deck icon in the menu bar."
echo "If macOS asks to let SwiftBar control $BROWSER, choose Allow."

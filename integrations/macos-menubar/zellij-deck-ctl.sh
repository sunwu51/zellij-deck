#!/bin/bash
# Click actions for the menu bar item.
#   zellij-deck-ctl.sh focus <windowId> <tabIndex>   bring that browser window/tab to front
#   zellij-deck-ctl.sh dashboard                     focus the dashboard tab, or open one
DIR="$HOME/.zellij-deck-swiftbar"
[ -f "$DIR/config.sh" ] && . "$DIR/config.sh"
BROWSER="${ZELLIJ_DECK_BROWSER:-Google Chrome}"

case "$1" in
  focus)
    [[ "$2" =~ ^[0-9]+$ && "$3" =~ ^[0-9]+$ ]] || exit 2
    osascript <<EOF
tell application "$BROWSER"
  set index of (first window whose id is $2) to 1
  set active tab index of (first window whose id is $2) to $3
  activate
end tell
EOF
    ;;
  dashboard)
    osascript <<EOF
tell application "$BROWSER"
  repeat with w from 1 to count windows
    set wid to id of window w
    repeat with t from 1 to count tabs of window w
      set u to URL of tab t of window w
      if u starts with "chrome-extension://" and u contains "/dashboard.html" then
        set index of (first window whose id is wid) to 1
        set active tab index of (first window whose id is wid) to t
        activate
        return
      end if
    end repeat
  end repeat
end tell
EOF
    # No dashboard tab open: open a new one (needs the extension ID saved by install.sh).
    if [ -n "$ZELLIJ_DECK_EXT_ID" ]; then
      osascript -e "tell application \"$BROWSER\"" -e 'activate' \
        -e "open location \"chrome-extension://$ZELLIJ_DECK_EXT_ID/dashboard.html\"" -e 'end tell'
    else
      osascript -e 'display notification "Extension ID unknown. Open the dashboard once (click the extension icon), then re-run install.sh." with title "Zellij Deck"'
    fi
    ;;
  *) echo "usage: $0 focus <windowId> <tabIndex> | dashboard" >&2; exit 2 ;;
esac

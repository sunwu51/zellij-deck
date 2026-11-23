#!/bin/bash
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# Zellij Deck menu bar item for SwiftBar: lists open terminal windows and focuses them on click.
# Installed by integrations/macos-menubar/install.sh.
DIR="$HOME/.zellij-deck-swiftbar"
[ -f "$DIR/config.sh" ] && . "$DIR/config.sh"
BROWSER="${ZELLIJ_DECK_BROWSER:-Google Chrome}"
CTL="$DIR/zellij-deck-ctl.sh"

# Terminal windows are extension pages: chrome-extension://<id>/terminal.html
# Output: one "windowId<TAB>tabIndex<TAB>title" line per window.
windows=$(osascript <<EOF
if application "$BROWSER" is not running then return ""
set out to ""
set tb to ASCII character 9
tell application "$BROWSER"
  repeat with w from 1 to count windows
    set wid to id of window w
    repeat with t from 1 to count tabs of window w
      set u to URL of tab t of window w
      if u starts with "chrome-extension://" and u contains "/terminal.html" then
        set out to out & wid & tb & t & tb & (title of tab t of window w) & linefeed
      end if
    end repeat
  end repeat
end tell
return out
EOF
)

count=0
[ -n "$windows" ] && count=$(printf '%s\n' "$windows" | grep -c .)
icon=""
[ -f "$DIR/icon.png" ] && icon=" | image=$(base64 -i "$DIR/icon.png" | tr -d '\n')"
echo "$count$icon"
echo "---"
echo "Dashboard | bash=\"$CTL\" param1=dashboard terminal=false"
echo "---"
while IFS=$'\t' read -r wid idx title; do
  [ -z "$wid" ] && continue
  title="${title#Zellij Deck · }"
  title="${title//|/¦}"
  echo "$title | bash=\"$CTL\" param1=focus param2=$wid param3=$idx terminal=false"
done <<< "$windows"

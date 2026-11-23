#!/bin/bash
# ログインしたら自動で起動し、落ちたら再起動する（launchd）。使い方: bash autostart-install.sh
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
PL="$HOME/Library/LaunchAgents/com.twc.chathost.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$DIR/data"
cat > "$PL" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.twc.chathost</string>
<key>WorkingDirectory</key><string>$DIR</string>
<key>ProgramArguments</key><array>
<string>/usr/bin/caffeinate</string><string>-i</string><string>$NODE</string>
<string>--env-file=.env</string><string>--disable-warning=ExperimentalWarning</string><string>server.mjs</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$DIR/data/server.log</string>
<key>StandardErrorPath</key><string>$DIR/data/server.log</string>
</dict></plist>
PLIST
launchctl unload "$PL" 2>/dev/null; launchctl load "$PL"
echo "登録しました。ログは $DIR/data/server.log（tail -f で見られます）"
echo "止める: launchctl unload $PL"

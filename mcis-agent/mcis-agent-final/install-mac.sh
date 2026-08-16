#!/bin/bash
# Run this once after downloading mcis-agent-macos binary
# Registers it as a macOS LaunchAgent so it starts automatically on login

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_PATH="$SCRIPT_DIR/mcis-agent-macos"
PLIST_PATH="$HOME/Library/LaunchAgents/com.mcis.agent.plist"

chmod +x "$AGENT_PATH"

cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.mcis.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>$AGENT_PATH</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF

launchctl load "$PLIST_PATH"
echo "MCIS Agent will now start automatically when you log in to macOS."
echo "It has also been started right now."

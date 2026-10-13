# Process reliability (P1.11)

This covers two independent processes: the voice pipeline
(`voice/main.py`) and the HTTP bridge (`api_server.py`). Neither
replaces the existing voice/execution architecture — this is about
what happens around it when something goes wrong, not what it does.

## Voice pipeline (`voice/main.py`)

### What's already built in

`main()` wraps `VoiceController().run()` in a restart loop:

- A crash (any `Exception`) tears down and rebuilds the controller,
  forces a fresh microphone stream (`SharedMicrophone.close()` — a
  crash caused by a bad audio device handle would otherwise just crash
  again immediately on reuse), and restarts after a short delay.
- **Transient vs. terminal, correctly distinguished.** A run that stays
  up for at least `HEALTHY_RUN_SECONDS` (60s) before crashing resets
  the consecutive-failure counter — occasional crashes spread across
  days of otherwise-healthy operation never add up to a false
  "terminal failure." Only genuinely repeated, close-together crashes
  (more than `MAX_CONSECUTIVE_RESTARTS`, currently 5, with no healthy
  run in between) are treated as terminal.
- **Terminal failure is surfaced clearly, not silently.** Exceeding the
  cap logs an explicit `TERMINAL FAILURE` message (not just another
  "restarting..." line) and re-raises, so the process actually exits
  with a non-zero-equivalent failure (an uncaught exception) rather
  than looping forever or dying quietly.
- **Crash diagnostics are preserved.** Every crash (including the
  final terminal one) is appended, with its full traceback, to
  `nexus/nexus_voice_crash.log` — not just printed to whatever terminal
  happens to be attached. That file is the first thing to check after
  "the voice assistant stopped responding."
- `Ctrl+C` (`KeyboardInterrupt`) is treated as an intentional stop, not
  a crash — no log entry, no restart, clean exit.

### What this does NOT do

It does not restart the **process** itself if the Python interpreter
exits (e.g. an OS-level kill, a crash inside a C extension that takes
the interpreter down with it, a machine reboot). That's a job for an
OS-level supervisor, not application code — see below.

### Recommended supervisor configuration

Pick whichever matches the deployment platform. In every case, point
the supervisor at `python -m voice.main` (run from the `nexus/`
directory) and let the supervisor restart the process if it exits;
`main()`'s own internal retry logic still handles the common
in-process failure modes described above, so the supervisor is a
second, coarser safety net, not a replacement for it.

**Windows (the primary target platform for the desktop/voice
automation this talks to) — NSSM or Task Scheduler:**

```powershell
# Using NSSM (https://nssm.cc/) to run it as a Windows service:
nssm install NexusVoice "C:\Path\To\python.exe" "-m voice.main"
nssm set NexusVoice AppDirectory "C:\Path\To\nexus"
nssm set NexusVoice AppExit Default Restart
nssm set NexusVoice AppRestartDelay 2000
nssm start NexusVoice
```

Or, for a simpler per-user setup without a service, a Scheduled Task
with trigger "At log on" and action `pythonw.exe -m voice.main`
(working directory `nexus/`), with "Restart on failure" enabled in the
task's Settings tab.

**Linux (systemd user service, e.g. for the HTTP bridge on a headless
box — the voice pipeline itself needs a real audio device, which is
less commonly run under Linux systemd, but the pattern is identical):**

```ini
# ~/.config/systemd/user/nexus-voice.service
[Unit]
Description=Nexus voice pipeline

[Service]
WorkingDirectory=/path/to/nexus
ExecStart=/usr/bin/python3 -m voice.main
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now nexus-voice.service
journalctl --user -u nexus-voice.service -f   # live logs
```

**macOS (launchd):**

```xml
<!-- ~/Library/LaunchAgents/com.nexus.voice.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.nexus.voice</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>-m</string>
        <string>voice.main</string>
    </array>
    <key>WorkingDirectory</key><string>/path/to/nexus</string>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>2</integer>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.nexus.voice.plist
```

## HTTP bridge (`api_server.py`)

This is a FastAPI app under `uvicorn` — standard practice applies:
run it under the same supervisor patterns above
(`uvicorn api_server:app --host 127.0.0.1 --port 8000`, or
`python api_server.py` to use its own `__main__` block, which already
enforces the localhost-binding/auth-token checks described in
`docs/DEPLOYMENT.md`), with `Restart=on-failure` (systemd) or
`AppExit Default Restart` (NSSM) equivalently.

Within the process, `/execute` already has its own narrower safety net:
a per-request timeout (`GATEWAY_CALL_TIMEOUT`) that rebuilds the
single-worker executor if a call hangs past it, so one stuck action
doesn't permanently wedge the whole bridge even without a process
restart.

# OR3 Node Agent — Service Management Follow-Up

`or3-node launch` is the simplest way to get a node enrolled and connected.
After that works, the next operational step is usually to run the agent as a
machine-managed background service.

This document is intentionally a **follow-up** guide. The primary v1 packaging
story is still:

```bash
bun install -g or3-node
or3-node launch
```

Today, the safest service command is still the foreground runtime:

```bash
or3-node launch --foreground --no-interactive
```

That keeps enrollment, credential refresh, reconnect handling, and structured
logging inside the same path contributors already test interactively.

## Recommended rollout order

1. Install with `bun install -g or3-node` and verify `or3-node --help`.
2. Verify the node works interactively with `or3-node launch`.
3. Confirm approval, credential issuance, and a successful remote command.
4. Run `or3-node launch --foreground --no-interactive` manually once.
5. Only then install a service wrapper around that exact foreground command.

## `systemd` (Linux)

Use `systemd` when the node should start on boot and be restarted
automatically on failure.

Example unit:

```ini
[Unit]
Description=OR3 Node Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/or3-node launch --foreground --no-interactive
Restart=always
RestartSec=5
User=or3-node
Group=or3-node
Environment=HOME=/var/lib/or3-node
Environment=XDG_CONFIG_HOME=/var/lib/or3-node/.config
Environment=XDG_DATA_HOME=/var/lib/or3-node/.local/share
WorkingDirectory=/var/lib/or3-node
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Notes:

- create a dedicated service user instead of running as `root`
- set `HOME`, `XDG_CONFIG_HOME`, and `XDG_DATA_HOME` explicitly so state files
  land in a predictable place
- use `journalctl -u or3-node -f` to watch structured logs in real time
- configure `allowedRoots` before enabling file operations in production

Useful commands:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now or3-node.service
sudo systemctl status or3-node.service
journalctl -u or3-node.service -f
```

## `launchd` (macOS)

Use `launchd` for a machine-level or user-level managed node on macOS.

Example `LaunchAgent` plist:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>dev.or3.node</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/or3-node</string>
      <string>launch</string>
      <string>--foreground</string>
      <string>--no-interactive</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>/Users/your-user/.or3-node</string>
    <key>StandardOutPath</key>
    <string>/Users/your-user/.or3-node/or3-node.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/your-user/.or3-node/or3-node.stderr.log</string>
  </dict>
</plist>
```

Notes:

- prefer a user `LaunchAgent` first; it is easier to debug than a system daemon
- keep stdout/stderr paths explicit so structured logs are easy to inspect
- if Bun or `or3-node` is installed in a nonstandard path, use the absolute path

Useful commands:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.or3.node.plist
launchctl kickstart -k gui/$(id -u)/dev.or3.node
launchctl print gui/$(id -u)/dev.or3.node
```

## Windows service follow-up

Windows is still a follow-up path rather than a polished first-class service
story in this repo.

Recommended current approach:

- prove the node works interactively in PowerShell first
- wrap `or3-node launch --foreground --no-interactive` with your existing
  Windows service manager of choice
- keep PTY hidden on Windows for now; Bun's current Terminal API is POSIX-only

Practical options:

- Windows Task Scheduler for logon/startup execution
- NSSM (Non-Sucking Service Manager) if your environment already standardizes on it
- a future repo-managed Windows service wrapper after the service story is more mature

## Operational cautions

- do not use the background launcher path as the service entrypoint; wrap the
  foreground path instead
- do not store bootstrap tokens in service definitions once enrollment is done
- prefer service-user scoped storage over shared admin directories
- treat `credentials.json` as sensitive runtime material and keep file
  permissions tight
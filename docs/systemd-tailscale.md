# Running GoTTY as a Systemd User Service on Tailscale

This guide sets up GoTTY as a persistent background service under your own user account (no root/sudo required), accessible only over your Tailscale network with basic authentication.

---

## Prerequisites

- Linux with systemd
- Tailscale installed and connected (`tailscale status` should show `Connected`)
- Either Go toolchain (`go version`) **or** ability to download a pre-built binary

---

## Step 1 — Install GoTTY into your home directory

**Option A: via `go install` (recommended if Go is available)**

```sh
go install github.com/sorenisanerd/gotty@latest
```

The binary lands at `~/go/bin/gotty`. Verify:

```sh
~/go/bin/gotty --version
```

**Option B: download a release binary**

```sh
mkdir -p ~/.local/bin
curl -fsSL https://github.com/sorenisanerd/gotty/releases/latest/download/gotty_linux_amd64.tar.gz \
  | tar -xz -C ~/.local/bin gotty
chmod +x ~/.local/bin/gotty
```

Then make sure `~/.local/bin` is in your PATH:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

---

## Step 2 — Get your Tailscale IP

```sh
tailscale ip -4
```

Note the IP (e.g. `100.x.x.x`). You'll use it in the next step.

---

## Step 3 — Create the GoTTY config file

Store your address and credentials in `~/.gotty` so they never appear in the process list or service file.

```sh
cat > ~/.gotty <<'EOF'
address = "100.x.x.x"     // replace with your Tailscale IP from Step 2
port    = "8080"

permit_write      = true
enable_basic_auth = true
credential        = "youruser:yourpassword"
max_connection = 5
close_timeout = 10

preferences {
    theme = "light"
}
EOF

chmod 600 ~/.gotty
```

> **Note:** Replace `100.x.x.x`, `youruser`, and `yourpassword` with your actual values.

---

## Step 4 — Enable user service lingering

By default, user services stop when you log out. Enable lingering so your service keeps running:

```sh
loginctl enable-linger $USER
```

---

## Step 5 — Create the systemd user unit file

```sh
mkdir -p ~/.config/systemd/user
```

```sh
cat > ~/.config/systemd/user/gotty.service <<'EOF'
[Unit]
Description=GoTTY Web Terminal (Tailscale)
After=network.target

[Service]
ExecStart=%h/go/bin/gotty bash
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
```

> If you installed via Option B, replace `%h/go/bin/gotty` with `%h/.local/bin/gotty`.
>
> `%h` is systemd's specifier for your home directory — no need to hardcode the path.

---

## Step 6 — Enable and start the service

```sh
systemctl --user daemon-reload
systemctl --user enable gotty
systemctl --user start gotty
systemctl --user status gotty
```

You should see `active (running)`.

---

## Step 7 — Verify

Open a browser on any Tailscale-connected device and navigate to:

```
http://100.x.x.x:8080
```

You'll be prompted for the username and password you set in `~/.gotty`.

---

## Optional: Handle a changing Tailscale IP

If your Tailscale IP changes (e.g. after re-registering the machine), update `~/.gotty` and restart:

```sh
sed -i "s/^address = .*/address = \"$(tailscale ip -4)\"/" ~/.gotty
systemctl --user restart gotty
```

Or create a small wrapper script at `~/bin/gotty-tailscale.sh`:

```sh
mkdir -p ~/bin
cat > ~/bin/gotty-tailscale.sh <<'EOF'
#!/usr/bin/env bash
set -e
TS_IP=$(tailscale ip -4)
sed -i "s/^address = .*/address = \"${TS_IP}\"/" ~/.gotty
exec ~/go/bin/gotty bash
EOF
chmod +x ~/bin/gotty-tailscale.sh
```

Then update the service `ExecStart` line to use `%h/bin/gotty-tailscale.sh` and reload:

```sh
systemctl --user daemon-reload
systemctl --user restart gotty
```

---

## Security notes

| Concern | Recommendation |
|---------|---------------|
| `-w` enables write access | Anyone who authenticates can run arbitrary commands — use a strong password and keep the Tailscale ACL tight |
| Credentials in `~/.gotty` | File is `0600` (only readable by you); still avoid reusing passwords |
| Plain HTTP | Traffic is encrypted by Tailscale's WireGuard layer, so HTTP over Tailscale is acceptable; for extra assurance add `enable_tls = true` in `~/.gotty` |

---

## Useful commands

```sh
# View live logs
journalctl --user -u gotty -f

# Stop the service
systemctl --user stop gotty

# Disable autostart
systemctl --user disable gotty
```

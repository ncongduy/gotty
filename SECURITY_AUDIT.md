# GoTTY Security Audit

**Date**: 2026-05-22
**Codebase**: `github.com/sorenisanerd/gotty`
**Deployment context**: Private — Tailscale VPN + Caddy (TLS termination) + UFW firewall

Tailscale eliminates direct internet exposure and significantly narrows the attack surface. The residual threat model is: a compromised or rogue Tailnet node, lateral movement from another internal service, or misconfiguration. Findings are prioritized accordingly.

---

## Summary

| # | Severity | Title | File |
|---|----------|-------|------|
| 1 | Critical | WebSocket endpoint bypasses HTTP Basic Auth | `server/server.go:236` |
| 2 | Critical | Timing attack on credential comparison | `server/middleware.go:42`, `server/handlers.go:113` |
| 3 | Critical | No brute-force / rate-limiting protection | `server/middleware.go`, `server/handlers.go` |
| 4 | High | Memory exhaustion: full WS message buffered before size check | `server/ws_wrapper.go:33` |
| 5 | High | `permit_arguments` enables CLI flag injection via WS message | `backend/localcommand/factory.go:42` |
| 6 | High | Missing security headers | `server/middleware.go:18` |
| 7 | Medium | Goroutine leak: `Close()` blocks forever with default config | `backend/localcommand/local_command.go:92` |
| 8 | Medium | `pass_headers` injects all HTTP headers as env vars | `backend/localcommand/local_command.go:41` |
| 9 | Medium | Negative terminal dimensions cause uint16 wrap-around | `webtty/webtty.go:212` |
| 10 | Medium | Default `MaxConnection = 0` (unlimited) | `server/options.go:25` |
| 11 | Medium | Credential exposed as a global JS variable in `auth_token.js` | `server/handlers.go:268` |
| 12 | Low | `GOTTY_CREDENTIAL` env var visible in process listings | `utils/flags.go:26` |
| 13 | Low | `innerHTML` in message overlay (currently safe, future XSS sink) | `js/src/xterm.tsx:81` |
| 14 | Low | Server fingerprinting via `Server` header | `server/middleware.go:21` |

---

## Critical

### 1. WebSocket endpoint bypasses HTTP Basic Auth

**File**: `server/server.go:236-239`

```go
wsMux := http.NewServeMux()
wsMux.Handle("/", siteHandler)                                    // has basic auth
wsMux.HandleFunc(pathPrefix+"ws", server.generateHandleWS(...))  // NO basic auth
```

The WS handler is registered on `wsMux` **after** `wrapBasicAuth` is applied to `siteHandler`. The `/ws` endpoint is protected only by the in-protocol `AuthToken` check in `processWSConn`. If `Credential` is empty — the default when `--credential` is not passed — any Tailnet node can connect and get a PTY by sending `{"AuthToken":""}`.

This is by design (browsers cannot send `Authorization` headers on WS upgrade), but the consequence is that the WS endpoint's security is entirely dependent on the credential being non-empty.

**Verify exposure**:
```sh
curl -i --include \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  http://host:8080/ws
```

**Fix**: Always set `credential = "user:strongpassword"` in `.gotty`. Without it, the process is fully exposed to every Tailnet peer.

---

### 2. Timing attack on credential comparison

**Files**: `server/middleware.go:42`, `server/handlers.go:113`

```go
// HTTP basic auth check
if credential != string(payload) { ... }

// WebSocket auth check
if init.AuthToken != server.options.Credential { ... }
```

Both comparisons use Go's built-in `!=` on strings, which is not constant-time. A Tailnet attacker with low-latency access can measure response times to leak credential bytes one character at a time.

**Fix**: Replace both comparisons with `subtle.ConstantTimeCompare`:

```go
import "crypto/subtle"

// middleware.go
if subtle.ConstantTimeCompare([]byte(credential), payload) != 1 { ... }

// handlers.go
if subtle.ConstantTimeCompare([]byte(init.AuthToken), []byte(server.options.Credential)) != 1 { ... }
```

---

### 3. No brute-force / rate-limiting protection

**Files**: `server/middleware.go:26-51` (HTTP), `server/handlers.go:99-115` (WS)

Neither the HTTP basic auth middleware nor the WebSocket auth handler tracks failed attempts, applies delays, or rate-limits by IP. An attacker with Tailnet access can spray passwords at wire speed against either endpoint indefinitely with no lockout or backoff.

**Fix**: Add a per-IP attempt counter with exponential backoff, or front GoTTY with Caddy's `rate_limit` directive. At minimum, set a strong long random credential to make offline brute-force impractical.

---

## High

### 4. Memory exhaustion: full WS message buffered before size check

**File**: `server/ws_wrapper.go:33-35`

```go
b, err := io.ReadAll(reader)   // reads ENTIRE message into memory
if len(b) > len(p) {           // size check happens after full read
    return 0, errors.Wrapf(err, "Client message exceeded buffer size")
}
```

`io.ReadAll` reads the complete WebSocket message into a temporary buffer before the size check occurs. A client can send a message of arbitrary size, consuming server memory before any rejection happens. With `MaxConnection = 0` (default) and no rate limiting, multiple concurrent clients can exhaust available memory.

**Fix**: Cap the read with `io.LimitReader`:

```go
limited := io.LimitReader(reader, int64(len(p))+1)
b, err := io.ReadAll(limited)
if len(b) > len(p) { ... }
```

---

### 5. `permit_arguments` enables CLI flag injection via WebSocket message

**File**: `backend/localcommand/factory.go:42-44`

```go
if params["arg"] != nil && len(params["arg"]) > 0 {
    argv = append(argv, params["arg"]...)
}
```

When `permit_arguments = true`, any authenticated WS client can inject arbitrary command-line arguments by crafting the `Arguments` field in the init message directly — no URL manipulation needed:

```json
{"AuthToken": "user:pass", "Arguments": "?arg=--init-file&arg=/tmp/evil"}
```

This bypasses any URL-level filtering entirely since the argument injection happens in the WebSocket protocol layer. Depending on the command being served:

- `gotty bash` → `bash --init-file /path/to/attacker/script`
- `gotty vim` → `vim /etc/passwd`
- `gotty ssh host` → `ssh -o ProxyCommand=... host`

**Fix**: Keep `permit_arguments = false` (default). If arguments are required, validate and whitelist them server-side before appending.

---

### 6. Missing security headers

**File**: `server/middleware.go:18-24`

```go
func (server *Server) wrapHeaders(handler http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Server", "GoTTY")  // only header set
        handler.ServeHTTP(w, r)
    })
}
```

The following headers are absent:

| Header | Risk without it |
|--------|----------------|
| `Content-Security-Policy` | `auth_token.js` delivers the credential as a global JS var; any injected script can read it |
| `X-Frame-Options` | Clickjacking — terminal embedded in attacker iframe |
| `X-Content-Type-Options: nosniff` | MIME sniffing attacks on served assets |
| `Referrer-Policy` | Credential or path leakage in `Referer` headers |
| `Strict-Transport-Security` | HTTPS downgrade (Caddy handles this but GoTTY doesn't enforce it) |

**Fix**: Add these in your Caddy config since GoTTY itself does not provide them:

```caddy
header {
    Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss:; img-src 'self' data:;"
    X-Frame-Options "DENY"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "no-referrer"
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
}
```

---

## Medium

### 7. Goroutine leak: `Close()` blocks forever with default config

**Files**: `backend/localcommand/local_command.go:92-104`, `backend/localcommand/factory.go:11`

Default `close_timeout = -1` means infinite. The `closeTimeoutC()` function returns a channel that never fires:

```go
func (lcmd *LocalCommand) closeTimeoutC() <-chan time.Time {
    if lcmd.closeTimeout >= 0 {
        return time.After(lcmd.closeTimeout)
    }
    return make(chan time.Time)  // never fires
}
```

In `Close()`:

```go
lcmd.cmd.Process.Signal(lcmd.closeSignal)  // SIGHUP by default
for {
    select {
    case <-lcmd.ptyClosed:
        return nil
    case <-lcmd.closeTimeoutC():  // never fires → goroutine leaks if process ignores SIGHUP
        lcmd.cmd.Process.Signal(syscall.SIGKILL)
    }
}
```

If the spawned process ignores `SIGHUP` (common for interactive shells and daemons), `Close()` blocks forever, leaking the goroutine and the PTY file descriptor.

**Fix**: Set `close_timeout = 10` in `.gotty` to ensure processes are forcibly killed within 10 seconds of disconnect.

---

### 8. `pass_headers` injects all HTTP headers as environment variables

**File**: `backend/localcommand/local_command.go:41-44`

```go
for key, values := range headers {
    h := "HTTP_" + strings.Replace(strings.ToUpper(key), "-", "_", -1) + "=" + strings.Join(values, ",")
    cmd.Env = append(cmd.Env, h)
}
```

When `pass_headers = true`, every HTTP request header becomes an environment variable with the `HTTP_` prefix. A client controlling arbitrary headers (trivial with a custom WS client) can inject values into the subprocess environment. While the prefix prevents direct attacks like `LD_PRELOAD` or `PATH` hijacking, programs that consume `HTTP_*` vars (CGI scripts, some web frameworks) or that have long env-sensitive names may behave unexpectedly.

**Fix**: Keep `pass_headers = false` (default). If specific headers must be forwarded, implement an explicit allowlist rather than forwarding all headers.

---

### 9. Negative terminal dimensions cause uint16 wrap-around

**Files**: `webtty/webtty.go:212-235`, `backend/localcommand/local_command.go:114-127`

```go
// webtty.go — client controls Columns and Rows as float64
var args argResizeTerminal
json.Unmarshal(data[1:], &args)
wt.slave.ResizeTerminal(int(args.Columns), int(args.Rows))

// local_command.go — int cast to uint16 without range check
window := pty.Winsize{
    Rows: uint16(height),  // int(-1) → uint16(65535)
    Cols: uint16(width),
}
pty.Setsize(lcmd.pty, &window)
```

An authenticated client sending `ResizeTerminal` with negative values causes integer wrap-around to 65535 when cast to `uint16`. This produces a nonsensical terminal geometry and can destabilize terminal-aware applications.

**Fix**: Clamp columns and rows to a sane range before conversion:

```go
if args.Columns < 1 || args.Columns > 65535 { args.Columns = 80 }
if args.Rows < 1 || args.Rows > 65535 { args.Rows = 24 }
```

---

### 10. Default `MaxConnection = 0` (unlimited)

**File**: `server/options.go:25`

```go
MaxConnection int `hcl:"max_connection" ... default:"0"`
```

With the default of 0, an unlimited number of clients can hold open sessions simultaneously. Each session spawns a PTY, a subprocess, and multiple goroutines. A single Tailnet attacker can exhaust file descriptors, memory, and CPU with concurrent connections.

**Fix**: Set a sensible limit in `.gotty`:

```
max_connection = 5
```

---

### 11. Credential exposed as a global JavaScript variable

**File**: `server/handlers.go:268-270`

```go
func (server *Server) handleAuthToken(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/javascript")
    // @TODO hashing?
    w.Write([]byte("var gotty_auth_token = '" + server.options.Credential + "';"))
}
```

The full `user:pass` credential is delivered to every authenticated browser session as the global variable `gotty_auth_token`. It is visible in:

- Browser DevTools → Sources tab
- Any browser extension with page script access
- JavaScript heap dumps
- Browser history if the URL includes it

This is intentional design (the WS connection needs the token), but since the WS token equals the HTTP basic auth credential, a single exposure compromises both layers.

In your Tailscale-only setup this is low-risk, but it argues for treating the credential as a dedicated random token rather than a reused password.

---

## Low

### 12. `GOTTY_CREDENTIAL` env var visible in process listings

**File**: `utils/flags.go:26`

Any option — including `credential` — can be set via `GOTTY_*` environment variables. Credentials passed this way appear in `/proc/self/environ`, are visible to other processes owned by the same user via `/proc/<pid>/environ`, and may appear in container inspection output (`docker inspect`).

**Fix**: Prefer the config file (`~/.gotty`) with mode `600` over environment variables for secrets. Alternatively, pass credentials via a secrets manager and write them to the config file at startup.

---

### 13. `innerHTML` in message overlay (currently safe, latent XSS sink)

**File**: `js/src/xterm.tsx:81`

```typescript
showMessage(message: string, timeout: number) {
    this.message.innerHTML = message;  // XSS sink
    ...
}
```

Currently `showMessage` is only called with the static string `"Connection Closed"` and the numeric resize dimensions (e.g., `"80x24"`). No user-controlled data flows into it today. However, `innerHTML` is an XSS sink — any future caller passing server-derived or user-derived content would introduce reflected XSS.

**Fix**: Replace with `textContent`:

```typescript
this.message.textContent = message;
```

---

### 14. Server fingerprinting via `Server` header

**File**: `server/middleware.go:21`

```go
w.Header().Set("Server", "GoTTY")
```

Advertises the exact server software to every HTTP response. In a Tailscale-only deployment this is a minor concern, but removing it reduces passive fingerprinting.

**Fix**: Either remove the header entirely or let Caddy rewrite it.

---

## Recommended `.gotty` Hardening Configuration

```hcl
# Bind only to localhost; let Caddy proxy
address = "127.0.0.1"
port    = "8080"

# Mandatory: credential protects the WS endpoint
credential = "user:use-a-long-random-password-here"

# Disable dangerous features
permit_write     = false   # enable only if you need interactive input
permit_arguments = false
pass_headers     = false
enable_reconnect = false

# Resource limits
max_connection = 5
close_timeout  = 10        # force-kill after 10s, prevents goroutine leaks
timeout        = 300       # close idle sessions after 5 minutes

# Optional: random URL adds a second secret to the path
enable_random_url  = true
random_url_length  = 16
```

## Recommended Caddy Security Headers

```caddy
header {
    Content-Security-Policy    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss:; img-src 'self' data:;"
    X-Frame-Options            "DENY"
    X-Content-Type-Options     "nosniff"
    Referrer-Policy            "no-referrer"
    Strict-Transport-Security  "max-age=31536000; includeSubDomains"
    -Server                    # remove upstream Server header
}
```

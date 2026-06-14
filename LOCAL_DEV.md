# Local Development

This repository is the 909 Signal IT website and Signal Desk dashboard. It uses static HTML built by Vite, then an Express server serves the built `dist` folder and the authenticated `/desk` dashboard.

Do not use or edit any nested `signalscan-technician-console` desktop app folder when working on the website.

## Install

```powershell
npm.cmd install
```

## Build

```powershell
npm.cmd run build
```

The build writes static site output to `dist/`.

## Start The Local Website

```powershell
npm.cmd start
```

By default, `server.js` uses port `3000`.

Local URLs:

- Homepage: `http://localhost:3000/`
- SignalScan public page: `http://localhost:3000/signalscan`
- Dashboard login: `http://localhost:3000/desk/login`
- SignalScan dashboard panel: `http://localhost:3000/desk/signalscan`

The dashboard requires login. For a local dashboard smoke test, set temporary local environment variables before starting the server:

```powershell
$env:ADMIN_USERNAME="local-admin"
$env:ADMIN_PASSWORD="local-password"
$env:SESSION_SECRET="local-development-session-secret"
npm.cmd start
```

Then open `http://localhost:3000/desk/login`, sign in with those values, and visit `http://localhost:3000/desk/signalscan`.

## Vite Dev Server

```powershell
npm.cmd run dev
```

The Vite dev server is useful for static page editing, but the Express server is the local test target for extensionless production routes like `/signalscan` and for all `/desk` dashboard routes.

## Route Smoke Test

With the Express server running:

```powershell
npm.cmd run smoke:routes
```

Optional custom base URL:

```powershell
$env:SMOKE_BASE_URL="http://localhost:3000"
npm.cmd run smoke:routes
```

If `ADMIN_USERNAME` and `ADMIN_PASSWORD` are set, the smoke test signs in and expects `/desk/signalscan` to return HTTP 200. Without local auth credentials, the smoke test accepts the expected redirect to `/desk/login`.

## SignalScan Safety Copy

SignalScan must remain positioned as a read-only PC health check and technician-reviewed report. Public pages must not claim that SignalScan repairs computers, removes malware, cleans up files, optimizes settings, deletes files, changes system settings, replaces a technician, or provides public download links.

# Changelog

## 0.2.0 — 2026-10-03

### Changed

- **Adding the package now installs the tray too, and removing the package takes it
  away.** One command each, no separate tray step:
  - The plugin installs its own companion on the first start after the package was
    added (it ships the tray, so nothing is downloaded). A package manager cannot do
    this for us - pnpm 10+ refuses to run a dependency's install script unless it is
    allowlisted, and the DSH plugin command has no hooks - so the plugin does it, at
    `apply()` time, and reports the outcome in the status document. Nothing needs
    administrator rights.
  - `dsh plugin --profile web remove @mostkia/dsh-launcher` is noticed by the still
    running plugin: the package folder is gone and the profile no longer depends on
    it, so the tray is uninstalled through the copy in the install directory (the
    package's own copy left with the package).
- **Removing the tray on purpose is remembered.** The uninstaller leaves an opt-out
  marker next to the install folder, which the automatic install respects - otherwise
  a user who wanted the plugin without the tray would find it reinstalled on every
  restart. `install.cmd` clears the marker; `DSH_LAUNCHER_NO_TRAY_INSTALL=1` disables
  the automatic install outright.

### Notes

- Both lifecycle steps are exercised in the host suite against scratch scripts and a
  scratch `%LOCALAPPDATA%`, so the tests never install or remove a real tray. The
  suite is Windows-only for those checks, and asserts the `windows-only` answers
  elsewhere, because the CI matrix also runs it on Linux.
- `tray\uninstall.ps1 -FromPlugin` is the plugin-driven path: it removes the tray
  without recording an opt-out, since being removed with the package is not the user's
  decision.

## 0.1.2 — 2026-10-03

### Fixed

- **The installed folder could not uninstall itself.** `install.ps1` copied the tray
  but not the uninstaller, so `%LOCALAPPDATA%\DSH-Launcher\uninstall.cmd` - the path
  the README pointed at - did not exist; the only copy was in the package, where a
  user has no reason to look. The installer now copies `uninstall.cmd` and
  `uninstall.ps1` alongside the tray, and records it as `uninstall` in
  `install.json`.

### Added

- **"Uninstall tray" in the tray menu.** Right-click the icon and pick it: the tray
  asks for confirmation, then hands the job to `uninstall.ps1` in a separate process
  (the uninstaller stops the tray and deletes the files the tray runs from, so it
  must not depend on the tray surviving). Nobody has to find a script any more, which
  was the actual complaint behind the bug above.
- `install.ps1 -TargetDir`, so the installer can be pointed at a scratch directory -
  which is what lets the suite install and uninstall in one go. The suite now covers
  that round trip: install, assert the uninstaller travelled with the tray, then let
  the copy inside the installed folder remove the installation.

## 0.1.1 — 2026-10-03

### Added

- `tray\uninstall.cmd` (backed by `tray\uninstall.ps1`): removes the tray that
  `install.cmd` put on the machine. It stops a running tray that was started from
  that directory, removes the start-at-logon value and the desktop shortcut - each
  only when it points at that installation - and deletes the install directory.
  `-DryRun` reports what would go without changing anything, `-KeepState` keeps the
  logs in `state\`, `-NoStop` leaves a running tray alone.
- `test\tray-uninstall.ps1`: pins those promises in scratch locations (scratch
  install directory, scratch shortcut, scratch registry key, scratch tray process),
  which the ownership guards make possible - so the suite proves the guards work
  instead of trusting them.

### Notes

- The uninstaller never stops DSH: killing the tray leaves the DSH it supervised
  running, and removing the plugin stays a separate step
  (`dsh plugin --profile web remove @mostkia/dsh-launcher`).

## 0.1.0 — 2026-10-03

First public release.

### Added

- **Sidebar power action** in the official `sidebar.footer.action` seat, directly
  above Settings: a dialog with **Shut down** and **Restart**, each behind a
  second confirmation, and a **Start at logon** switch at its foot.
- **Graceful exit** through the host's bounded shutdown controller
  (`ctx.appExit`): shutdown leaves with code 0, restart with code 42 so a
  supervisor can relaunch it.
- **Windows tray launcher**: starts DSH without a console window, captures its
  output (mixed UTF-8 and OEM encodings decoded per line), shows it on demand,
  restarts DSH, runs one instance per port, and carries a checkable
  start-at-logon item.
- Same-origin endpoints under `/_dsh-launcher`: `status`, `shutdown`, `restart`,
  `autostart/enable`, `autostart/disable`.
- `tray\install.cmd`: installs into `%LOCALAPPDATA%\DSH-Launcher`, writes the
  shared `install.json`, creates the desktop shortcut. Start at logon stays
  opt-in and is never enabled by the installer.
- Three offline test suites (host 17 checks, client 14, tray 9) and
  [`RELEASE.md`](./RELEASE.md).

### Fixed before the first release

An adversarial review of the repository (2026-10-03) found these; all are fixed
and covered by tests.

- **CSRF guard:** an `Origin` whose host merely matched the request's `Host` was
  accepted, which is a DNS-rebinding hole - a page served from a name that
  resolves to 127.0.0.1 could reach every destructive endpoint. Only loopback
  origins are accepted now, and the README states that precisely.
- **No false success:** shutdown and restart answered `200` and only then asked the
  host to exit, so a missing exit controller left the process running while the
  dialog said "shut down". The controller is resolved before the reply, a missing
  one answers `503`, and the dialog waits for the service to stop answering before
  it reports success.
- **Tray:** a restart no longer starts a child blindly. If the port is still in use
  after exit code 42, the tray kills the tree, waits again, and otherwise reports
  that it did not restart - instead of silently losing control while the old DSH
  keeps serving.
- **Tray:** `Test-Supervised` carried a fallback that could never be true (a process
  fetched by id has a default `StartInfo`). It is gone, and the log now says the
  status endpoint did not answer; the forced-restart balloon and window text state
  that running work is interrupted.
- **Autostart:** disabling an entry that was not registered reported failure (since
  `reg delete` fails on a missing value), and a failed delete reported success.
  Both report what happened now, and `runReg` no longer flattens a spawn failure
  into exit code 0.
- **Client:** Escape and a backdrop click no longer dismiss the dialog while an
  action is running, so its outcome cannot be hidden by accident.
- **Layout:** the power action now sits in the same row as Settings, at its right,
  instead of taking a row of its own above it. The 56px rail still stacks the two
  icons, where there is no horizontal room to share.
- **Shortcut:** the desktop shortcut's icon was stored as `"path",0` - literal
  quotes around the path - which Explorer could not resolve, so it drew the blank
  document icon. The icon file was renamed as well, which gives the shell's icon
  cache a fresh key, and the installer now nudges that cache.

### Notes

- No coexistence shims on purpose: the plugin claims only its own namespace, so
  it does not fight another power plugin over routes.
- A restart is only performed when a supervisor says it is there
  (`DSH_LAUNCHER_SUPERVISED=1`, set by the tray): without it the endpoint reports
  `unsupervised` and leaves the process running rather than killing a session.
- The tray and start-at-logon are Windows-only; the plugin itself is
  platform-neutral.
- No runtime dependencies: every `@deepseek-ai/*` value is a peerDependency, so a
  package manager cannot install a second copy of a shared DSH package.

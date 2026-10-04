# Changelog

## 0.1.0 — 2026-10-03

First public release: power controls in the DSH sidebar, and a Windows tray launcher
that supervises DSH.

### The plugin

- **Sidebar power button**, in the shell's own `sidebar.footer.action` seat beside
  Settings: a dialog with **Shut down** (graceful exit, code 0) and **Restart** (exit
  code 42, which the tray turns back into a relaunch), each behind a second
  confirmation, plus a **Start at logon** switch.
- Both exits go through the host's bounded shutdown controller (`ctx.appExit`), so the
  plugin tree is disposed and the port released before the process leaves.
- A restart only happens when a supervisor is actually there
  (`DSH_LAUNCHER_SUPERVISED=1`, set by the tray); without it the endpoint reports
  `unsupervised` and leaves the process alone.
- Its own namespace, a loopback-Origin guard on every state-changing endpoint, zero
  runtime dependencies (`@deepseek-ai/*` stays in `peerDependencies`), and a client
  half that imports nothing and is built from theme tokens.

### The tray

- **Installed by the plugin itself**, on the first DSH start after the package was
  added. A package manager will not run a dependency's install script (pnpm 10+
  blocks them) and the plugin command has no hooks, so the plugin copies the tray it
  ships into `%LOCALAPPDATA%\DSH-Launcher`, creates the **DSH Launcher** desktop
  shortcut, and writes `install.json` for both halves to read. Nothing in there needs
  administrator rights.
- Starts DSH without a console window, captures its output (double-click the icon),
  restarts it, offers the same start-at-logon switch, and removes itself through the
  **Uninstall tray…** menu item - which also takes the install directory and the
  shortcut with it. `-DryRun` and `-KeepState` exist for the cautious.
- `tray\uninstall.ps1` touches only what belongs to the installation it is pointed at:
  a running tray whose command line runs from that directory, and a start-at-logon
  value or desktop shortcut that points there.

### Notes

- **Removing the plugin does not remove the tray, and removing the tray does not
  remove the plugin.** The two halves stay independent on purpose: the plugin goes
  with `dsh plugin --profile web remove @mostkia/dsh-launcher`, the tray through its
  own menu item (or `uninstall.cmd` in the install directory). Installing again puts a
  missing tray back.
- `DSH_LAUNCHER_NO_TRAY_INSTALL=1` keeps the plugin from installing the tray at all.
- Four suites cover it - host half (34 checks, plus the platform-specific ones again
  with `process.platform` patched to linux), client half (14 checks), tray supervision
  (against a fake DSH) and the tray install/uninstall round trip (33 assertions) - and
  a package-contents check runs alongside them in CI, on Linux and Windows.

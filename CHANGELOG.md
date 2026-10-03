# Changelog

## 0.1.0 — unreleased (development builds report 0.0.1)

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

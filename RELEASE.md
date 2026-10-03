# Releasing @mostkia/dsh-launcher

Maintainer notes; this file is not part of the published package.

`package.json` carries the development version `0.0.1`; the first public release
is `v0.1.0`. Run everything below from the repository root.

## 1. Pre-flight (all of these must pass)

```bash
git status --short                      # clean working tree
node test/host-half.test.mjs            # 17 checks, exit 0
node test/client-half.test.mjs          # 14 checks, exit 0
powershell -NoProfile -ExecutionPolicy Bypass -File test\tray-supervision.ps1
                                        # 9 assertions, exit 0
npm pack --dry-run --cache .npm-pack    # 16 entries; test/ and tools/ absent
```

`--cache` keeps npm's cache inside the checkout. Without it npm writes to
`%LOCALAPPDATA%\npm-cache`, which a confined shell refuses (`EPERM`).

Then confirm nothing from a single workstation leaked into the published files:

```bash
git grep -nE 'D:\\|C:\\Users|@example\.com' -- .   # must print nothing
git grep -nE 'LOCALAPPDATA|USERPROFILE|SystemRoot' -- .   # env-based only, expected
```

## 2. Cut the release

```bash
# package.json -> "version": "0.1.0"
git commit -am "release: 0.1.0"
git tag -a v0.1.0 -m "v0.1.0"
```

## 3. Publish

```bash
gh auth setup-git        # one-time; writes ~/.gitconfig, outside the repo, needs approval
gh repo create mostkia/dsh-launcher --public --source . --remote origin --push
git push origin v0.1.0
```

Users then install with the pinned tag:

```bash
dsh plugin --profile web add github:mostkia/dsh-launcher#v0.1.0
```

## 4. Optional: GitHub Release with a tarball

```bash
npm pack --cache .npm-pack          # mostkia-dsh-launcher-0.1.0.tgz
gh release create v0.1.0 mostkia-dsh-launcher-0.1.0.tgz --title "v0.1.0" --generate-notes
```

A release asset lets users install without git:

```bash
dsh plugin --profile web add "https://github.com/mostkia/dsh-launcher/releases/download/v0.1.0/mostkia-dsh-launcher-0.1.0.tgz"
```

## 5. Optional: community market listing

A pull request against `awesome-dsh-plugin/awesome-dsh-plugin`. Their catalog
accepts GitHub-only plugins (`"npm": null`), so publishing to npm is **not**
required. Values for this project:

| field | value |
|---|---|
| name | `dsh-launcher` |
| owner | `mostkia` |
| url | `https://github.com/mostkia/dsh-launcher` |
| category | `ui` |
| description.en | Power controls in the DSH sidebar (shutdown / restart, each with a second confirmation, plus a start-at-logon switch) and a Windows tray launcher that starts DSH without a console window, shows its captured output, restarts it and offers the same logon switch. |
| description.zh | DSH 侧边栏电源按钮（关机 / 重启，各自二次确认，底部带开机自启动开关），外加 Windows 托盘启动器：无窗口启动 DSH、可查看捕获的控制台输出、可优雅重启，菜单里也能开关开机自启动。 |
| install | `dsh plugin --profile web add github:mostkia/dsh-launcher` |

Their tooling fills in version, stars and downloads; the pull request carries the
repository and the texts only. Ready-made screenshots for the listing live in
`docs/screenshots/` (light and dark dialog, tray window); they are not part of
the published package.

## 6. Rollback

- Unpublished tag: `git tag -d v0.1.0`, fix, re-tag.
- Published but broken for users: delete the GitHub release/tag, then ship a
  fixed patch version. A user who already installed it recovers with
  `dsh plugin --profile web remove @mostkia/dsh-launcher` — the plugin writes
  nothing outside its own endpoints, and the tray's only persistent change is the
  `HKCU\...\Run` value `DSHLauncher`, which its installer leaves disabled unless
  the user switches it on.

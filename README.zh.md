# @mostkia/dsh-launcher

DeepSeek Harness（DSH）的电源控制：侧边栏一个电源按钮，外加一个 Windows 托盘启动器（可拉起、可重启、可查看控制台输出）。

🌏 [English](./README.md) · **简体中文**

## 这套东西包含什么

| 部件 | 位置 | 作用 |
|---|---|---|
| **电源按钮** | DSH 侧边栏官方 `sidebar.footer.action` 槽位（设置按钮旁边那一列） | 点击弹对话框：**关机** / **重启**（各自再确认一次），底部还有 **开机自启动** 滑动开关 |
| **托盘启动器** | `%LOCALAPPDATA%\DSH-Launcher`，由桌面快捷方式启动 | 无窗口启动 `dsh web`、按需重启 DSH、菜单里开关开机自启；它抓取的输出随时双击可看，全程没有命令行窗口挡在前面 |

两半由**一个包**装出，但**不熔合**：卸掉插件，托盘照旧能用（重启降级为硬杀进程树）；没装托盘，插件也照旧能用（点"重启"会明确告诉你没有监督器，并且**不会**动你的进程）。

## 截图

| 电源弹窗（浅色） | 电源弹窗（深色） | 侧边栏按钮 |
|:--:|:--:|:--:|
| ![浅色主题下的电源弹窗](docs/screenshots/power-dialog-light.png) | ![深色主题下的电源弹窗](docs/screenshots/power-dialog-dark.png) | ![侧边栏里紧邻“设置”的电源按钮](docs/screenshots/sidebar-power.png) |

弹窗的颜色、圆角、阴影全部来自主题 token，所以跟随宿主明暗主题；电源按钮用的是宿主侧边栏脚部
自己的槽位，紧邻「设置」，不额外占一行。

## 安装

```bash
# 1) 插件（从 GitHub 装；建议钉住发布 tag）
dsh plugin --profile web add github:mostkia/dsh-launcher#v0.1.0

# 2) Windows 托盘（可选，但强烈建议——优雅重启靠它）
#    在装好的包目录里运行：
#    tray\install.cmd     （双击，或在终端里执行）
```

然后重启一次 DSH（`dsh web` 或你现有的启动方式），再刷新页面。

`tray\install.cmd` 会把托盘复制到 `%LOCALAPPDATA%\DSH-Launcher`，写一份
`install.json`（两半共同读取的唯一事实来源），并在桌面创建 **DSH Launcher**
快捷方式。它**不会**碰开机自启——那必须你显式开启。

## 使用

- **侧边栏电源按钮**：`关机` = 优雅退出（退出码 0）；`重启` = 以重启码退出，由托盘重新拉起。两个动作都要**二次确认**，因为这个入口伸手就够得着。
- **开机自启动**：电源弹窗底部的滑动开关，与托盘右键菜单里那个可勾选项，读写的**是同一个注册表值**（`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `DSHLauncher`），所以两处状态永远一致。
- **托盘图标**：双击查看抓取到的控制台输出；右键菜单含 显示/隐藏、启动、重启、打开 DSH 界面、打开日志文件、开机自启动、关闭 DSH 并退出。

## "重启"到底怎么实现

插件自己**从不**裸调 `process.exit`：

1. 界面请求宿主半部重启；
2. 宿主半部先回 `200`，再请**启动器的有界关闭控制器**（`ctx.appExit`）退出——插件树先被 dispose、端口先被释放；
3. 退出码（42）就是契约：监督器据此重新拉起。

只有监督器**自报家门**时才会真的走第 3 步：托盘会给它启动的 DSH 进程设置
`DSH_LAUNCHER_SUPERVISED=1`。没有这个标记时，重启端点返回
`{"ok":false,"reason":"unsupervised"}` 且**保持进程存活**——"一点就丢掉整个会话"不是我们要的功能。
这也是唯一还会出现硬重启的地方：卸了插件但留着托盘时，托盘自己的重启会退化为 `taskkill /T /F`。

## HTTP 接口（给脚本/其它启动器用）

所有端点会拒绝任何**不是本机回环地址**的 `Origin`（一律 `403`），且都在本插件自己的命名空间下。
不带 `Origin` 的请求（脚本、`curl`）按设计放行：浏览器在 POST 时一定会带 `Origin`，
所以"没有这个头"才是 CSRF 守卫该忽略的情形；而**带着 `Origin` 时绝不能因为它的 host 与请求的
`Host` 相同就信任**——早期版本正是这么写的，那是一个 DNS 重绑定漏洞（评审实测发现）。

| 方法 | 路径 | 含义 |
|---|---|---|
| `GET` | `/_dsh-launcher/status` | 平台、pid、是否有监督器、自启状态 |
| `POST` | `/_dsh-launcher/shutdown` | 优雅退出，退出码 0 |
| `POST` | `/_dsh-launcher/restart` | 优雅退出，退出码 42（仅在有监督器时） |
| `POST` | `/_dsh-launcher/autostart/enable` | 注册开机自启 |
| `POST` | `/_dsh-launcher/autostart/disable` | 取消开机自启 |

## 测试

两半都带自测，不需要真实 dsh 会话：

```bash
# 宿主半部：端点、守卫、退出码、自启状态（23 项）
node test/host-half.test.mjs

# 客户端半部：槽位注册与中英文案完整性（无需浏览器）
node test/client-half.test.mjs

# 托盘：监督探测与两条重启路径（对着假 dsh 跑）
powershell -NoProfile -ExecutionPolicy Bypass -File test\tray-supervision.ps1
```

托盘测试在临时端口用 `test/fake-dsh.mjs`（一个会说插件端点的小 HTTP 服务）当被监督的子进程，
不会启动、杀掉或重启你的真实 dsh。它钉住的是最要紧的那个判断：子进程确实被监督时，
托盘才去请求插件并等重启码；发现没被监督时**不去调那个必然回 `ok:false` 的端点**，
自己强制重启。受限 shell 里 `taskkill` 会被拒绝，所以强制路径的"杀进程"那一步在那里观察不到，
脚本会说明该限制（假子进程改为自行退出）。

维护者：发布前的自检、打标签与上架步骤见 [RELEASE.md](./RELEASE.md)。以上测试外加"发布产物内容检查"，
每次 push / PR 都由 CI 跑一遍（`.github/workflows/tests.yml`）。

## 环境要求

- DSH **0.1.7 或更新**（用到 `sidebar.footer.action`、`ctx.appExit` 与 `webServer` 注册接口）。
  **注意**：DSH 的兼容闸按 semver 判定 peer 依赖，而 `0.1.7-rc.2` 这类**预发布版**不满足 `>=0.1.7`，
  所以本包的 peer 范围写成 `>=0.1.7-0`（含预发布）。自己写插件时踩到这个坑，用同样写法即可。
- Node `^22.19.0 || >=24.0.0`（DSH 自身的要求）。
- 托盘与开机自启**仅 Windows**；插件本体跨平台，遇到不支持时会明确告知。

## 设计说明

- **刻意零运行时依赖**：所有 `@deepseek-ai/*` 都写在 `peerDependencies`，绝不写进
  `dependencies`——包管理器一旦在 profile 里装出第二份物理副本，包内私有 Symbol 就会分裂，
  宿主调度器会直接报错。
- **客户端半部不 import 任何东西**：不依赖 `@deepseek-ai/dsh-client-ui-*`，界面全部用主题
  token（`--dsw-alias-*`、`--dsw-radius-*`、`--dsw-shadow-*`）手写，明暗主题与宿主设计语言
  自动跟随；所有可见文字走客户端 locale 服务（中 + 英）。
- **不与其它插件冲突**：只占用自己的路径，不在路由层做"共存/替换 dsh-shutdown"的兼容——
  各自单装都能用。

## 致谢与许可

独立实现。退出码重启约定与"启动器配合电源插件"的思路参考了
[dsh-shutdown](https://github.com/knlght/DSH-shutdown)（MIT），但**未包含其任何代码**。
托盘图标取自 DSH 前端自带的 `favicon.svg`，用于标识本启动器。

[MIT](./LICENSE) © 2026 mostkia

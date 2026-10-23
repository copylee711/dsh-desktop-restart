# dsh-desktop-restart

[![npm](https://img.shields.io/npm/v/@copylee/dsh-desktop-restart)](https://www.npmjs.com/package/@copylee/dsh-desktop-restart)

DeepSeek Harness（DSH）桌面版一键重启插件：解决桌面版安装、更新或卸载插件后必须去系统托盘右键退出再重新打开的痛点。零配置开箱即用，在**左下角官方客户端更新按钮旁**和**插件市场（`dsh-market`）需重启横幅内**提供原生的重启按钮。



## 功能亮点

| 功能 | 说明 |
| --- | --- |
| **左下角官方更新按钮旁入口** | 自动嵌入侧边栏底部账号行右侧（与官方 `DesktopUpdateIndicator` 并排，并自动为 `@copylee/dsh-remote-control` 手机图标预留间距，**绝不重叠**）。有插件变动时显示醒目的 **`↻ 需重启 (N)`** 胶囊；平时显示轻量常驻 **`↻`** 图标按钮 |
| **插件市场（`dsh-market`）内嵌按钮** | `dsh-market` 在桌面版会隐藏自带的重启按钮（因为 Web 重启无法重开 Electron 进程）。本插件会自动在 `↻ N 项变更需重启 DeepSeek Harness 后生效` 横幅右侧补上 **「立即重启」** 主按钮，并在市场标题栏右上角提供 **`↻ 需重启`** 按钮 |
| **二次确认防误触 & 活动任务守卫** | 点击一次进入 5 秒「确认重启？」状态，再点一次才执行重启；若检测到正在运行的会话回合或后台任务，会提示确认后再重启；若检测到 `pnpm` 正在安装/更新插件（`.plugin-manager/run.json` 锁存活），则自动禁用并拦截重启以防损坏依赖 |
| **优雅落盘退出 + 干净重启** | 独立 `helper.cjs` 进程仅终止 Electron 主进程（`taskkill /PID <mainPid> /F`，不加 `/T`），使 `dsh-desktop-host` 子进程通过 IPC `disconnect` 事件触发完整的 `application.shutdown.shutdown(0)` 数据落盘，随后清理残留句柄与 `ELECTRON_RUN_AS_NODE` 环境变量并重拉 `DeepSeek Harness.exe` |
| **Web 版 / 远程端安全静默（No-Op）** | 若用户误在 `dsh web`（纯 Node 命令行版）安装，或通过手机远程控制访问页面，插件前后端会自动识别非 Electron 桌面环境：**前端不渲染任何按钮、不覆盖 `dsh-market` 原生 Web 重启按钮，后端拒绝执行进程操作** |
| **`/restart` 斜杠命令** | 在桌面版支持通过 `/restart`（或 `/restart --force`）快捷触发桌面客户端重启 |

## 安装

在 DSH 桌面版打开 **设置 → 插件**（或 **插件市场**），搜索并安装：

```text
@copylee/dsh-desktop-restart
```

要求：
- Windows 10 / 11（DeepSeek Harness Desktop Electron 客户端）
- DSH `>= 0.2.0-rc.2`

## 工作原理与安全性

1. **为什么普通进程自杀无法重启桌面版？**
   DSH Desktop 采用 Electron 主进程 + `ELECTRON_RUN_AS_NODE=1` Host 子进程双层架构。若插件在 Host 子进程内直接退出或继承环境变量拉起 `DeepSeek Harness.exe`，新进程会因为带有 `ELECTRON_RUN_AS_NODE=1` 而退化成无界面的后台 Node 进程。
2. **本插件如何安全重启？**
   - 校验请求必须来自本机回环地址（`127.0.0.1` / `::1`）且通过宿主 `connection.requestRejection` 同源鉴权；
   - 启动脱离当前进程树的 `lib/helper.cjs`；
   - 关闭 Electron 主进程后等待 Host 子进程完成优雅关闭与端口释放（最多 8 秒，超时再定点清理同路径残留进程）；
   - 剥离 `ELECTRON_RUN_AS_NODE`、`DSH_DESKTOP_NODE_EXECUTABLE`、`DSH_SESSION_ID`、`DSH_WEB_URL` 等内部环境变量，保留原启动参数重新拉起桌面客户端；
   - 每次重启日志保存在 `~/.dsh/desktop-restart/restart-<timestamp>.log`（自动保留最近 20 次）。

## 致谢与参考

本插件在设计进程脱离与端口释放流程时参考了社区开源项目：
- [luoshuizhiwei/dsh-desktop-restart](https://github.com/luoshuizhiwei/dsh-desktop-restart)
- [xiaolu511/dsh-hot-restart](https://github.com/xiaolu511/dsh-hot-restart)

## License

[MIT](LICENSE)

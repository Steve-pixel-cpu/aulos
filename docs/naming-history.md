# 命名约定与改名史

> 自 README 移出的开发者备忘（2026-10）。

项目经历了 `x-code → aulos` 更名（v5.0.0 完成），由此形成两条持久的约定：

**显示名与标识符双轨**——用户可见处一律首字母大写 **Aulos**（窗口标题、
快捷方式、CLI 横幅、README 标题、安装包名）；技术标识符一律小写 `aulos`
且**不可改动**，改了会断机制或丢数据：

| 标识 | 为什么不能改 |
|---|---|
| `config.py` 的 `APP_NAME = "aulos"` | 决定用户数据目录 `~/.aulos`，改名 = 全部会话/配置/记忆"消失" |
| `x-aulos-token` 头 / `aulos_token` cookie | 桌面壳与后端的握手约定，两端必须一致 |
| `/api/ping` 返回的 `app: "aulos"` | 壳靠它确认"这是 aulos 后端"（8000 可能被打印服务等抢占） |
| `com.aulos.desktop` / `aulos-server.exe` | 打包标识与 sidecar 文件名，发布链按此装配 |

**产物名单点化**——安装包/更新清单的文件名（`Aulos_<ver>_x64-setup.exe` 等）
统一从 `src-tauri/tauri.conf.json` 的 `productName` 派生：JS 脚本直接读 conf，
cmd 批处理用 `findstr` 提取。改名只动 conf 一处，各发布脚本零改动；
漏改任何一处会导致 `latest.json` 指向不存在的文件、自动更新静默断链。

`config.py` 里保留的 `LEGACY_APP_NAME = "x-code"` 与一次性迁移逻辑是给
老用户的无感升级路径（首启自动搬 `~/.xcode` → `~/.aulos`），新代码不要
引用它，也不要删除——直到官方宣布不再支持 v4 以前的升级。

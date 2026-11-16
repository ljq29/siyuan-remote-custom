# SiYuan Remote Custom

基于 [SiYuan](https://github.com/siyuan-note/siyuan) `v3.8.10` 的开源 Windows 定制版，保留 AGPL-3.0 许可证与上游版权声明。上游提交基线：`be17ed1e0510bb6371cb8a162e16898a697fa118`。

## 定制功能

- `remote.json` 驱动远程内核模式，命令行参数优先
- 内置 SSH 隧道、断线重连、OpenSSH TCP 桥与自动鉴权
- 内嵌站点、HTTP 正向代理、一端口一站点和响应换源改写
- 内嵌 SSH Server 与反向端口转发
- 固定任务栏标题、远程托盘状态和远程延迟趋势面板
- 移除官方云账号界面、解锁第三方同步并停用相关遥测
- `ignoreVersionMismatch` 可显式忽略本地与远端版本号差异

仓库不包含任何真实服务器地址、账号、密码或私钥。

## 下载与配置

Tag 对应的 GitHub Actions 会自动构建并发布：

- `siyuan-<版本>-win.exe`：NSIS 安装包
- `siyuan-<版本>-win-green.zip`：免安装绿色版
- `SHA256SUMS.txt`：产物校验值

将 [`docs/remote.json.example`](docs/remote.json.example) 复制为 `%USERPROFILE%\.config\siyuan\remote.json`，再替换示例地址和凭据。配置支持 JSONC 注释与尾逗号。

`ignoreVersionMismatch` 默认是 `false`。设为 `true` 时只忽略版本号差异，不会忽略连接失败、超时或无效响应；生产环境仍建议保持客户端和内核版本一致。详细配置和升级锚点见 [`docs/远程配置与新版迁移.md`](docs/远程配置与新版迁移.md)。

## 本地构建

Windows 构建依赖 Node `24.x`、pnpm `12.6.0`、`kernel/go.mod` 指定的 Go 版本，以及支持 CGO 的 MinGW-w64 GCC。

```bash
cd app
pnpm install --frozen-lockfile
pnpm run install:electron
pnpm run lint
pnpm run build

cd ../kernel
export CGO_ENABLED=1 GOOS=windows GOARCH=amd64
go install github.com/josephspurrier/goversioninfo/cmd/goversioninfo@latest
"$(go env GOPATH)/bin/goversioninfo.exe" -platform-specific=true -icon=resource/icon.ico -manifest=resource/goversioninfo.exe.manifest
go build -tags "fts5 sqlcipher" -o ../app/kernel/SiYuan-Kernel.exe -ldflags "-s -w -X github.com/siyuan-note/siyuan/kernel/util.Mode=prod"

cd ../app
pnpm run dist
```

产物位于 `app/build-release/`。

## 云端构建与发布

`.github/workflows/custom-release.yml` 支持手动触发和 `v*-custom.*` tag 触发。手动触发只构建并上传 Actions artifacts；tag 触发还会创建或更新同名 GitHub Release。

## 许可证

本仓库继续采用 [AGPL-3.0](LICENSE)。上游说明见 [`README.upstream.md`](README.upstream.md)，第三方声明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

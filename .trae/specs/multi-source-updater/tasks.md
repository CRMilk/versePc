# Tasks

- [x] Task 1: 创建 update.json 版本元数据文件
  - 在仓库根目录创建 `update.json`，填入当前版本 1.0.0 的信息
  - 包含 version、releaseDate、releaseName、releaseNotes、files（win-x64 含 url/sha256/size）、minSupportedVersion、force 字段

- [x] Task 2: 修改 GitHub Actions workflow 自动更新 update.json
  - 修改 `.github/workflows/build.yml`
  - 在 Windows 构建完成后，计算安装包 SHA256
  - 自动生成/更新 `update.json` 内容
  - 提交并推送到 main 分支（仅在 tag 触发时）

- [x] Task 3: 在 main.js 中实现多源更新检测逻辑
  - 新增 `fetchUpdateJson()` 函数，按优先级依次尝试 GitHub Raw → ghproxy → jsDelivr 获取 `update.json`
  - 每个源设置 5 秒超时，失败自动切换下一个
  - 返回解析后的 JSON 对象或 null（全部失败时）
  - 新增 `compareVersions()` 函数，使用 semver 比较版本号

- [x] Task 4: 在 main.js 中实现多源文件下载逻辑
  - 新增 `downloadWithFallback()` 函数，替代 electron-updater 的 downloadUpdate
  - 从 `update.json` 的 `files` 字段获取原始下载 URL
  - 按优先级尝试：原始 URL → ghproxy 代理 → jsDelivr CDN
  - 支持下载进度回调
  - 下载完成后计算 SHA256 并校验

- [x] Task 5: 重写 initAutoUpdater 函数
  - 替换 electron-updater 的事件监听为自定义多源检测
  - 保留启动 3 秒后静默检查的行为
  - 保留版本跳过机制（`skippedVersion`）
  - 保留更新通知弹窗和下载进度 UI
  - 保留退出时自动安装逻辑
  - 错误时静默记录日志，不弹出错误弹窗

- [x] Task 6: 更新 index.html 更新设置页面
  - 移除手动镜像选择下拉框
  - 改为显示多源自动切换状态信息
  - 保留"检查更新"和"跳过版本"按钮

- [x] Task 7: 清理 electron-updater 相关代码
  - 移除 `autoUpdater` 的导入和相关事件监听
  - 移除 `setFeedURL` 镜像切换逻辑
  - 移除 IPC 中的 `updater:toggle-mirror` 和 `updater:get-mirror-config`
  - 保留 `updater:check-for-updates`、`updater:download-update`、`updater:install-update`、`updater:skip-version`、`updater:open-release-page` IPC 接口但改为调用新逻辑

# Task Dependencies

- Task 1（update.json）是独立的，可先完成
- Task 2（CI/CD）依赖 Task 1 的 update.json 格式
- Task 3（检测逻辑）依赖 Task 1 的 update.json 格式
- Task 4（下载逻辑）依赖 Task 3 的检测结果
- Task 5（重写 initAutoUpdater）依赖 Task 3 和 Task 4
- Task 6（UI 更新）依赖 Task 5
- Task 7（清理）依赖 Task 5 和 Task 6

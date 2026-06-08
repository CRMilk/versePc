# Checklist

## update.json
- [x] `update.json` 文件存在于仓库根目录
- [x] 包含 version、releaseDate、releaseName、releaseNotes、files、minSupportedVersion、force 字段
- [x] files 中包含 win-x64 平台的 url、sha256、size 信息

## CI/CD
- [x] GitHub Actions workflow 在 tag 推送时自动计算 SHA256 并更新 `update.json`
- [x] 更新后的 `update.json` 自动提交推送到 main 分支

## 多源检测
- [x] `fetchUpdateJson()` 按 GitHub Raw → ghproxy → jsDelivr 顺序尝试
- [x] 每个源超时 5 秒后自动切换下一个
- [x] 全部失败时返回 null，不抛出异常
- [x] `compareVersions()` 正确比较 semver 版本号

## 多源下载
- [x] `downloadWithFallback()` 按原始 URL → ghproxy → jsDelivr 顺序尝试
- [x] 下载进度通过 IPC 实时通知渲染进程
- [x] 下载完成后 SHA256 校验通过
- [x] SHA256 不匹配时报错并提示用户

## initAutoUpdater
- [x] 启动 3 秒后静默检查更新
- [x] 发现新版本弹出通知弹窗
- [x] 版本跳过机制正常工作
- [x] 下载进度弹窗正常显示
- [x] 退出时自动安装正常工作
- [x] 错误时静默记录日志，不弹出错误弹窗
- [x] 不再依赖 electron-updater 的 autoUpdater 对象进行检测和下载

## UI
- [x] 更新设置页面移除了手动镜像选择下拉框
- [x] "检查更新"按钮正常工作
- [x] "跳过版本"按钮正常工作

## 清理
- [x] main.js 中不再调用 autoUpdater.checkForUpdates()
- [x] main.js 中不再调用 autoUpdater.downloadUpdate()
- [x] 移除了 updater:toggle-mirror 和 updater:get-mirror-config IPC
- [x] electron-updater 依赖仍保留（quitAndInstall 使用）

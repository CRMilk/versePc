# 多源自动更新系统 Spec

## Why

VersePC 当前使用 `electron-updater` 直接调用 GitHub Releases API 检测更新，在中国网络环境下 GitHub API 不可达导致更新检测失败。虽然提供了 ghproxy 代理选项，但用户需要手动切换且代理服务不稳定。需要参照 PCL2-CE 的架构，实现自建 JSON 端点 + 多源自动故障转移的更新系统。

## What Changes

- 在仓库根目录新增 `update.json` 版本元数据文件
- 新增 GitHub Actions workflow，在构建发布时自动更新 `update.json`
- 替换 `electron-updater` 的更新检测逻辑为自定义多源 JSON 端点检测
- 实现多源自动故障转移（GitHub Raw → ghproxy → jsDelivr）
- 下载也支持多源故障转移（GitHub Releases → ghproxy 代理 → jsDelivr）
- 保留 SHA256 文件校验
- 保留版本跳过、退出时自动安装等现有功能

## Impact

- Affected specs: 自动更新系统
- Affected code: `main.js`（更新检测与下载逻辑）、`index.html`（更新设置 UI）、`js/app.js`（更新状态渲染）、`package.json`（构建配置）、`.github/workflows/build.yml`（CI/CD）、新增 `update.json`

## ADDED Requirements

### Requirement: 多源更新检测

系统 SHALL 按优先级依次尝试以下源获取版本信息，任一成功即停止：

1. GitHub Raw: `https://raw.githubusercontent.com/doujie081231/versePc/main/update.json`
2. ghproxy: `https://mirror.ghproxy.com/https://raw.githubusercontent.com/doujie081231/versePc/main/update.json`
3. jsDelivr: `https://cdn.jsdelivr.net/gh/doujie081231/versePc@main/update.json`

#### Scenario: GitHub Raw 可达
- **WHEN** 应用启动 3 秒后触发更新检测
- **THEN** 首先尝试 GitHub Raw 获取 `update.json`，成功则使用该结果

#### Scenario: GitHub Raw 超时，ghproxy 可达
- **WHEN** GitHub Raw 请求超时（5 秒）
- **THEN** 自动切换到 ghproxy 源获取 `update.json`

#### Scenario: 所有源均失败
- **WHEN** 三个源全部超时或返回错误
- **THEN** 静默失败，不弹出错误提示，控制台记录日志

### Requirement: 多源文件下载

系统 SHALL 在用户点击下载更新时，按优先级尝试以下源下载安装包：

1. GitHub Releases 原始链接
2. ghproxy 代理链接
3. jsDelivr CDN 链接

#### Scenario: GitHub Releases 可达
- **WHEN** 用户点击"立即下载"
- **THEN** 从 GitHub Releases 下载，显示进度

#### Scenario: GitHub Releases 超时
- **WHEN** GitHub Releases 下载超时（10 秒无响应）
- **THEN** 自动切换到 ghproxy 代理下载

#### Scenario: 下载完成后校验
- **WHEN** 文件下载完成
- **THEN** 计算 SHA256 并与 `update.json` 中的哈希比对，不匹配则报错重试

### Requirement: CI/CD 自动更新 update.json

GitHub Actions SHALL 在每次 tag 推送构建完成后，自动更新 `update.json` 并提交到 main 分支。

#### Scenario: 推送 v1.0.1 tag
- **WHEN** 开发者推送 `v1.0.1` tag 并触发构建
- **THEN** Actions 计算安装包 SHA256，更新 `update.json` 中的版本号、下载链接、哈希值，提交并推送到 main 分支

### Requirement: update.json 格式

```json
{
  "version": "1.0.1",
  "releaseDate": "2026-06-09T12:00:00Z",
  "releaseName": "VersePC v1.0.1",
  "releaseNotes": "更新内容...",
  "files": {
    "win-x64": {
      "url": "https://github.com/doujie081231/versePc/releases/download/v1.0.1/VersePC-Setup-1.0.1.exe",
      "sha256": "a1b2c3...",
      "size": 524288000
    }
  },
  "minSupportedVersion": "1.0.0",
  "force": false
}
```

## MODIFIED Requirements

### Requirement: 更新设置页面

更新设置页面中的镜像选择改为显示多源自动切换状态，用户不再需要手动选择镜像。保留"检查更新"和"跳过版本"功能。

### Requirement: 更新通知与安装

保留现有的更新通知弹窗、下载进度显示、退出时自动安装等行为，仅替换底层检测和下载逻辑。

## REMOVED Requirements

### Requirement: 手动镜像切换

**Reason**: 多源自动故障转移取代手动选择，用户无需关心具体使用哪个镜像
**Migration**: 现有用户的 `~/.versepc/update-config.json` 中的 `useMirror` 和 `mirrorUrl` 配置将被忽略，不影响功能

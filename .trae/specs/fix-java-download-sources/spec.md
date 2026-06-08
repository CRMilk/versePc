# Java 下载源修复 Spec

## Why
Java 下载功能的所有源均不可用，导致用户无法下载 JDK。根本原因是：(1) 中国国内镜像目录结构已变更导致 404；(2) GitHub API 和 Releases 在中国大陆无法访问；(3) 镜像 URL 生成逻辑硬编码为 Windows x64 平台，不支持跨平台。

## What Changes
- 修复 `getTemurinMirrorUrl` 函数，使用正确的镜像目录结构
- 修复 GitHub fallback 中硬编码的 `windows` 和 `x64` 平台判断
- 添加 Adoptium CDN 镜像源作为额外回退
- 将镜像源检查从 `HEAD` 请求改为支持超时和重试

## Impact
- Affected specs: Java 下载功能
- Affected code: `server.js` 中的 `downloadJavaAsync`、`getTemurinMirrorUrl`、GitHub fallback 逻辑

## 问题根因分析

### 问题 1：镜像目录结构已变更
代码中的镜像 URL 生成逻辑：
```
https://mirrors.ustc.edu.cn/adoptium/{majorVer}/ga/windows/x64/jdk/{tag}/{fileName}
```
实际镜像目录结构已变更为：
```
https://mirrors.ustc.edu.cn/adoptium/releases/temurin{majorVer}-binaries/{tag}/{fileName}
```
三个国内镜像（USTC、Tsinghua、ISCAS）均返回 404。

### 问题 2：GitHub 不可达
- `api.github.com` 从中国大陆无法访问（连接超时）
- `github.com/adoptium/temurin*-binaries/releases/` 同样不可达

### 问题 3：GitHub fallback 硬编码平台
```javascript
// 第 5666 行
const asset = (ghResp.assets || []).find(a => 
    a.name && a.name.includes('windows') && a.name.includes('x64') && ...
);
```
硬编码了 `windows` 和 `x64`，macOS/Linux 用户无法通过此 fallback 下载。

## ADDED Requirements

### Requirement: 修复国内镜像目录结构
系统 SHALL 使用正确的 Adoptium 镜像目录结构生成下载 URL。

#### Scenario: 成功获取镜像 URL
- **WHEN** `getTemurinMirrorUrl` 被调用，传入 GitHub Releases URL
- **THEN** 返回的镜像 URL 应指向正确的目录结构，且包含当前平台和架构信息

### Requirement: 支持跨平台镜像
系统 SHALL 根据当前操作系统和 CPU 架构生成对应的镜像 URL，而非硬编码 Windows x64。

#### Scenario: macOS ARM64 用户下载
- **WHEN** 用户在 macOS ARM64 设备上请求下载 Java
- **THEN** 镜像 URL 应包含 `macos/aarch64` 路径

#### Scenario: Linux x64 用户下载
- **WHEN** 用户在 Linux x64 设备上请求下载 Java
- **THEN** 镜像 URL 应包含 `linux/x64` 路径

### Requirement: GitHub fallback 跨平台支持
系统 SHALL 在 GitHub fallback 中使用动态平台和架构判断，而非硬编码值。

## MODIFIED Requirements

### Requirement: downloadJavaAsync 下载流程
修改 `downloadJavaAsync` 函数，使镜像 URL 生成支持动态平台参数。

## REMOVED Requirements
无

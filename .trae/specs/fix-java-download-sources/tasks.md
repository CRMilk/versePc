# Tasks

- [x] Task 1: 修复 `getTemurinMirrorUrl` 函数（镜像目录结构变更）
- [x] Task 2: 修复 GitHub fallback 跨平台支持
- [x] Task 3: 重构下载源优先级策略
  - [x] SubTask 3.1: 镜像目录扫描优先（扫描 USTC/Tsinghua/ISCAS 目录，找可用版本）
  - [x] SubTask 3.2: Adoptium 官方 API 作为回退（会重定向到 GitHub）
  - [x] SubTask 3.3: 移除无效的 GitHub API fallback（中国不可达）
  - [x] SubTask 3.4: 移除冗余的镜像 HEAD 检查和二次目录扫描
- [x] Task 4: 验证修复
  - [x] SubTask 4.1: USTC 镜像 jdk-21.0.9+10 返回 HTTP 200
  - [x] SubTask 4.2: 镜像 API v3 端点已全部 404（不再使用）

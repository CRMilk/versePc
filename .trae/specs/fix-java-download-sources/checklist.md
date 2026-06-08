# Checklist

- [x] 镜像目录扫描优先，避免 GitHub 超时
- [x] 镜像目录结构使用 `releases/temurin{ver}-binaries/` 路径
- [x] 自动从镜像目录解析可用版本并选择最新版
- [x] Adoptium API 作为回退源
- [x] 移除无效的 GitHub API fallback
- [x] 移除冗余的镜像 HEAD 检查和二次目录扫描
- [x] USTC 镜像 jdk-21.0.9+10 返回 HTTP 200
- [x] 总超时时间从 ~90s 降低到 ~24s

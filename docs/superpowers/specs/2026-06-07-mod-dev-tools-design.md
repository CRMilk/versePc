# 模组开发工具 & 一句话生成模组 设计文档

## 概述

为 VersePC AI 添加模组开发能力：当用户切换到「开发者模式」后，AI 可调用模组开发工具链，支持 Fabric/Forge/NeoForge 模组的创建、编码、编译、安装全流程。简单需求（自定义配方、战利品表等）通过数据包实现，复杂需求生成完整模组代码并本地编译。

## 架构

```
用户输入 "创建一个添加钻石镐的模组"
    │
    ▼
AI (开发者模式) ─── 判断复杂度 ──┬── 简单 → 数据包生成 (JSON)
                                └── 复杂 → 完整模组代码生成
    │
    ▼
dev-tools-manager (工具链管理)
    ├── 检查 JDK 21 → 缺失则自动下载 (Adoptium Temurin)
    ├── 检查 Gradle → 缺失则自动下载
    └── 检查 MDK 模板 → 缺失则从 GitHub 下载 (fabric-example-mod / forge-mdk)
    │
    ▼
代码生成 (AI 子代理)
    ├── 基于模板生成项目结构
    ├── AI 编写 Java/Kotlin 代码
    └── 生成资源文件 (textures, models, lang)
    │
    ▼
Gradle 编译 → 输出 .jar 文件
    │
    ▼
安装到目标版本的 mods/ 文件夹
```

## 三大模块

### 模块 1: Dev-Tools-Manager (工具链管理器)

**职责**: 检测、下载、管理开发工具链

**工具存储路径**: `~/.versepc/dev-tools/`
```
~/.versepc/dev-tools/
├── jdk-21.0.6+7/          # Adoptium Temurin JDK 21
│   ├── bin/java.exe
│   └── ...
├── gradle-8.12/           # Gradle 发行版
│   ├── bin/gradle
│   └── ...
├── templates/             # MDK 模板缓存
│   ├── fabric-1.21.4/     # Fabric 示例模组
│   ├── forge-1.21.4/      # Forge MDK
│   └── neoforge-1.21.4/   # NeoForge MDK
└── config.json            # 工具链配置
```

**JDK 下载源** (按优先级):
1. Adoptium API: `https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse`
2. 清华镜像: `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/windows/x64/`
3. 华为云: `https://repo.huaweicloud.com/openjdk/`

**Gradle 下载源**:
1. 官方: `https://services.gradle.org/distributions/gradle-8.12-bin.zip`
2. 腾讯镜像: `https://mirrors.cloud.tencent.com/gradle/gradle-8.12-bin.zip`

**MDK 模板下载**:
- Fabric: `https://github.com/FabricMC/fabric-example-mod/archive/refs/heads/master.zip`
- Forge: `https://files.minecraftforge.net/net/minecraftforge/forge/index_1.21.4.html` (MDK 下载)
- NeoForge: `https://projects.neoforged.net/neoforged/neoforge` (MDK 下载)

### 模块 2: AI 开发工具 (插件系统)

**实现方式**: 通过现有 `plugin-manager.js` 插件系统加载

**插件目录**: `plugins/mod-dev-tools/`

**工具定义**:

| 工具名 | 描述 | 风险 |
|--------|------|------|
| `init_mod_project` | 初始化模组项目（选择加载器、MC版本、项目名） | safe |
| `build_mod` | 调用 Gradle 编译模组 | moderate |
| `create_datapack` | 创建数据包（配方/战利品表/标签等） | safe |
| `create_resourcepack` | 创建资源包（模型/纹理/语言文件等） | safe |
| `check_dev_environment` | 检查开发环境状态（JDK/Gradle/MDK） | safe |
| `install_dev_tools` | 安装缺失的开发工具 | moderate |
| `mod_compile_and_install` | 一键编译并安装到指定版本 | moderate |

### 模块 3: 一句话生成模组 (AI 工作流)

**复杂度判断规则**:

| 需求类型 | 示例 | 生成方式 |
|----------|------|----------|
| 自定义配方 | "添加一个钻石块合成配方" | 数据包 JSON |
| 战利品表修改 | "让僵尸掉落钻石" | 数据包 JSON |
| 自定义进度 | "添加一个成就" | 数据包 JSON |
| 自定义标签 | "让钻石剑可以破坏黑曜石" | 数据包 JSON |
| 新物品 | "添加一个彩虹剑" | 完整模组 (需要代码) |
| 新方块 | "添加一个铜矿石" | 完整模组 (需要代码) |
| 新生物 | "添加一个Boss怪物" | 完整模组 (需要代码) |
| 新机制 | "添加飞行背包" | 完整模组 (需要代码) |

## 实现步骤

### 第 1 步: 插件目录和 manifest

创建 `plugins/mod-dev-tools/manifest.json` 和 `index.js`

### 第 2 步: Dev-Tools-Manager 核心

创建 `dev-tools-manager.js`:
- `checkEnvironment()` → 检查 JDK/Gradle/MDK 状态
- `installJDK(version)` → 下载安装 JDK
- `installGradle(version)` → 下载安装 Gradle
- `downloadTemplate(loader, mcVersion)` → 下载 MDK 模板
- `getJavaPath()` → 返回 JDK java.exe 路径
- `getGradlePath()` → 返回 Gradle 可执行文件路径

### 第 3 步: 工具实现

每个工具的实现:

**check_dev_environment**:
```
→ 检查 ~/.versepc/dev-tools/jdk-*/ 是否存在
→ 检查 ~/.versepc/dev-tools/gradle-*/ 是否存在
→ 检查 ~/.versepc/dev-tools/templates/ 是否有对应模板
→ 返回 { jdk: { installed, version, path }, gradle: {...}, templates: {...} }
```

**init_mod_project**:
```
→ 参数: modName, modId, loader(fabric/forge/neoforge), mcVersion, packageName
→ 检查 dev environment，缺失则自动安装
→ 复制 MDK 模板到项目目录
→ 替换模板中的占位符 (modid, modname, version, etc.)
→ 生成基础代码文件
→ 返回项目路径和文件列表
```

**build_mod**:
```
→ 参数: projectPath
→ 调用 gradle build
→ 流式输出编译日志
→ 返回 { success, jarPath, errors }
```

**create_datapack**:
```
→ 参数: mcVersion, namespace, items[] (每项包含 type/recipe/loot_table/tags)
→ 生成 pack.mcmeta
→ 生成 JSON 文件到正确目录结构
→ 返回 datapack 路径
```

**create_resourcepack**:
```
→ 参数: mcVersion, namespace, items[] (每项包含 model/textures/lang)
→ 生成 pack.mcmeta
→ 生成 JSON 模型文件和纹理占位
→ 返回 resourcepack 路径
```

### 第 4 步: System Prompt 扩展

在开发者模式下，system prompt 追加:
```
## 模组开发工具 (仅开发者模式)
- check_dev_environment: 检查开发环境，在使用其他开发工具前应先调用
- init_mod_project: 初始化新模组项目
- build_mod: 编译模组项目
- create_datapack: 创建数据包（简单需求优先用数据包）
- create_resourcepack: 创建资源包
- mod_compile_and_install: 一键编译安装

### 生成模组流程:
1. 判断需求复杂度（数据包 vs 完整模组）
2. 数据包: 直接 create_datapack → 写入版本文件夹
3. 完整模组: check_dev_environment → init_mod_project → AI编写代码 → build_mod → 安装
4. 模组开发参考: https://fabricmc.net/wiki/ 或 https://docs.neoforged.net/
```

## 涉及文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `dev-tools-manager.js` | 新建 | 工具链管理核心 |
| `plugins/mod-dev-tools/manifest.json` | 新建 | 插件清单 |
| `plugins/mod-dev-tools/index.js` | 新建 | 插件工具实现 |
| `js/ai-chat.js` | 修改 | 系统提示扩展（开发者模式） |
| `server.js` | 修改 | 添加工具链下载 API（可选） |
| `main.js` | 修改 | 注册插件工具执行 |

## 不做的事

- 不做 IDE 集成（VS Code/IntelliJ）
- 不做 GUI 纹理编辑器
- 不做模组发布到 CurseForge/Modrinth
- 不做反编译/反混淆其他模组

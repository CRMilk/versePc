# 联机页面 & AI 设置页面 UI 重设计

## Why
当前联机页面（陶瓦联机、端口映射联机）和 AI 设置页面的 UI 较为基础，缺乏品牌一致性和视觉层次。需要统一重设计，提升用户体验和视觉品质。

## What Changes
- 重设计陶瓦联机页面布局和视觉样式
- 重设计端口映射联机页面布局和视觉样式
- 重设计 AI 聊天设置页面布局和视觉样式
- 统一三个页面的设计语言（圆角、间距、配色、动效）
- 保持所有现有功能和 API 调用不变

## Impact
- Affected specs: 联机模块、AI 聊天模块
- Affected code: `index.html`（HTML 结构）、`css/style.css`（样式）、`js/app.js`（联机 JS）、`js/ai-chat.js`（AI 设置 JS）

## ADDED Requirements

### Requirement: 陶瓦联机页面重设计
系统 SHALL 重新设计陶瓦联机页面的布局和视觉样式。

#### Scenario: 页面加载
- **WHEN** 用户点击"陶瓦联机"导航
- **THEN** 页面以新设计布局展示，包含状态卡片、操作区域、房间面板

#### Scenario: 功能完整性
- **WHEN** 用户执行创建房间、加入房间、断开连接等操作
- **THEN** 所有 API 调用和状态流转与原实现完全一致

### Requirement: 端口映射联机页面重设计
系统 SHALL 重新设计端口映射联机页面的布局和视觉样式。

#### Scenario: 页面加载
- **WHEN** 用户点击"端口映射"导航
- **THEN** 页面以新设计布局展示，包含状态卡片、操作区域、UPnP 诊断、日志区域

#### Scenario: 功能完整性
- **WHEN** 用户执行创建房间、加入房间、UPnP 诊断等操作
- **THEN** 所有 API 调用和状态流转与原实现完全一致

### Requirement: AI 设置页面重设计
系统 SHALL 重新设计 AI 聊天设置页面的布局和视觉样式。

#### Scenario: 设置页面加载
- **WHEN** 用户点击 AI 设置按钮
- **THEN** 设置面板以新设计布局展示，包含标签导航、搜索、内容区域

#### Scenario: 功能完整性
- **WHEN** 用户切换标签、搜索设置、修改配置、保存设置
- **THEN** 所有设置功能与原实现完全一致

## Design Direction

### 视觉风格：Minecraft Forge（锻造台风格）
- 深色主色调搭配暖色高亮（琥珀/铜色）
- 方块感元素呼应 Minecraft 主题
- 精致的微交互动效（hover、focus、状态切换）
- 卡片式布局，清晰的信息层次

### 配色方案
- 主背景：`#1a1a2e` / `#16213e`
- 卡片背景：`#0f3460` / `#1a1a2e`
- 强调色：`#e94560`（操作按钮）/ `#533483`（信息高亮）
- 状态色：绿 `#22c55e`、黄 `#f59e0b`、红 `#ef4444`
- 文字：主 `#e2e8f0`、次 `#94a3b8`、弱 `#64748b`

### 布局原则
- 状态卡片顶部通栏，带渐变边框
- 操作区域使用 2 列等宽卡片网格
- 表单区域使用紧凑的字段间距
- 日志/代码区域使用等宽字体 + 暗色背景

## MODIFIED Requirements

### Requirement: 联机页面 HTML 结构
陶瓦联机和端口映射联机页面的 HTML 结构将被重写，但保留所有 ID 和 onclick 属性不变。

### Requirement: 联机页面 CSS 样式
所有 `.lan-*` 类名的样式将被重写，新增部分辅助类名。

### Requirement: AI 设置页面 HTML 结构
AI 设置面板的 HTML 结构将被重写，但保留所有 ID 和数据属性不变。

### Requirement: AI 设置页面 CSS 样式
所有 `.rc-settings-*` 类名的样式将被重写。

## REMOVED Requirements
无

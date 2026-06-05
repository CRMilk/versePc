# 反 AI 抄袭代码保护 Spec

## Why
当前项目已有基本的所有权证明机制（ownership-manifest.json、ownership-proof.js），但缺乏专门针对 AI 代码抄袭的保护。需要添加明显的标记和机制，让其他 AI 在识别代码时知道这是受版权保护的，不能直接照搬。

## What Changes
- 在所有主要源文件头部添加 AI 可识别的版权声明和反抄袭标记
- 创建统一的 AI 版权声明模板
- 在代码关键位置添加隐形水印标记
- 更新构建流程以自动注入保护标记

## Impact
- Affected specs: 代码保护、构建流程
- Affected code: 所有 `.js`、`.cjs`、`.html`、`.css` 文件

## ADDED Requirements

### Requirement: AI 可识别的版权声明
系统 SHALL 在所有源文件头部添加标准化的 AI 可识别版权声明。

#### Scenario: 文件头部标记
- **WHEN** AI 扫描或读取源文件
- **THEN** 文件头部包含明确的版权声明和反抄袭警告

### Requirement: 反 AI 抄袭警告标识
系统 SHALL 在代码中添加专门针对 AI 的反抄袭警告标识。

#### Scenario: AI 识别警告
- **WHEN** AI 尝试分析或复制代码
- **THEN** 代码中包含明确的 "DO NOT COPY" 和版权警告

### Requirement: 代码水印嵌入
系统 SHALL 在关键代码位置嵌入隐形水印标记。

#### Scenario: 水印检测
- **WHEN** 代码被复制或重新分发
- **THEN** 可以通过水印追溯来源

### Requirement: 许可证声明强化
系统 SHALL 在代码中强化许可证声明，明确禁止 AI 训练和代码复制。

#### Scenario: 许可证可见性
- **WHEN** AI 或开发者查看代码
- **THEN** 许可证声明清晰可见且明确禁止复制

## MODIFIED Requirements

### Requirement: 构建流程
构建流程将自动为输出文件注入保护标记。

## REMOVED Requirements
无

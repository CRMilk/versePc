# 赞助用户卡片功能 Spec

## Why
为了感谢和展示对软件提供赞助的用户，需要在设置页面的"其它"页面顶部添加一个专门的卡片来展示赞助者信息。

## What Changes
- 在 `page-settings-other` 页面顶部添加赞助用户展示卡片
- 卡片仅包含赞助用户昵称（不显示头像）
- 支持响应式布局，适配不同数量的赞助者

## Impact
- Affected specs: 设置页面 UI
- Affected code: `index.html` (page-settings-other 区域)

## ADDED Requirements
### Requirement: 赞助用户展示卡片
系统 SHALL 在设置页面的"其它"页面顶部提供一个卡片组件，用于展示赞助用户信息。

#### Scenario: 正常显示赞助用户
- **WHEN** 用户导航到设置 > 其他页面
- **THEN** 页面顶部显示赞助用户卡片，包含赞助者昵称标签

#### Scenario: 赞助用户数据为空
- **WHEN** 暂无赞助用户数据
- **THEN** 卡片显示默认提示信息或隐藏

## MODIFIED Requirements
无

## REMOVED Requirements
无

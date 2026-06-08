# 修复引导页 AI 角色头像不显示

## 问题

引导页（AI 接入流程）中 AI 角色的头像显示为深灰色方块，不显示图片。

## 根本原因

引导页使用 `<img src="/api/avatar?uuid=...&offline=1">` 加载头像，该请求经过 Electron `protocol.handle` → `handleNativeAPI` → 服务器处理链路。当 `sharp` 模块处理 `steve_head.png` 失败或返回异常时，最终走到 302 重定向分支，而 Electron 对 `<img>` 标签的 302 重定向处理不可靠，导致图片为空白。

**而 AI 聊天页面的头像正常工作**，因为它使用完全不同的方案：CSS `background-image: var(--steve-skin)`，其中 `--steve-skin` 是 base64 编码的 PNG，直接内嵌在 CSS 中，零网络依赖。

## 修复方案

将引导页 3 处头像从 `<img src="/api/avatar">` 改为 CSS 背景图方式，与聊天页一致。

### 修改文件

#### 1. `index.html`（3 处修改）

将所有引导页头像从：
```html
<div class="onboard-msg-avatar">
    <img src="/api/avatar?uuid=8667ba71-b85a-4004-af54-457a9734eed7&offline=1" alt="" onerror="this.src='img/icon.png'">
</div>
```
改为：
```html
<div class="onboard-msg-avatar onboard-msg-avatar-steve"></div>
```

涉及行：1682-1683、1696-1697、1713-1714

#### 2. `css/style.css`（1 处新增）

在 `.onboard-msg-avatar` 样式之后添加新样式（参考已有的 `.ai-msg-avatar-steve`，适配 40x40px 尺寸）：

```css
.onboard-msg-avatar-steve {
    background-image: var(--steve-skin);
    background-size: 160px;
    background-position: -20px -20px;
    image-rendering: pixelated;
}
```

## 优势

- 与聊天页头像渲染方式完全一致
- 零网络请求依赖，100% 可靠
- 不需要 `sharp` 模块
- 不受 Electron protocol.handle 行为影响
- `--steve-skin` CSS 变量已存在于 `css/style.css` 第 44 行

## 验证

- 启动应用，进入引导页，确认 AI 角色头像显示为 Steve 皮肤头像
- 确认头像与聊天页面中的 AI 头像一致

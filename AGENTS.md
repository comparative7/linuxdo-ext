# AGENTS.md

## 项目简介
这是一个基于 Manifest V3 (MV3) 的 Chrome 浏览器插件，专门用于在 LinuxDo 论坛上模拟真实用户的自动浏览行为。
**核心原则**：只读不写，依靠原生浏览器环境规避反爬，维持活跃度。

## 目录地图 (预定)
- `manifest.json`: 插件核心配置，必须是 V3 格式。
- `popup/`: 存放 `popup.html` 和 `popup.js`，提供开始/停止开关、状态与足迹。
- `options/`: 独立配置页（`options.html` / `options.js`），全部浏览参数。
- `scripts/background.js`: 全局 Service Worker，负责记录状态和调度页面跳转。
- `scripts/content.js`: 注入到 `linux.do` 的脚本，负责寻找未读帖子和执行平滑随机滚动。
- `specs/`: 存放业务需求。
- `.cursor/rules/`: 存放所有 Agent 协作规则与 Skill。

## 常用命令
- **开发与测试**：本项目**无**构建工具（零依赖）。测试时，在 Chrome 打开 `chrome://extensions/`，开启“开发者模式”，点击“加载已解压的扩展程序”，选择当前项目根目录即可。
- **提交代码**：说「提交」「commit」「commit push」「保存进度」等均可触发 `git-committer` 规则；须用 `[NF]`/`[BF]` 等前缀格式，且 Agent 会先征求确认再执行 `git commit`。

## 全局红线 (NEVER)
- **绝对不要**引入 React、Vue 等框架或 Webpack 等打包工具。
- **绝对不要**处理登录和密码验证，默认用户已在浏览器中自行登录。
- **绝对不要**写出没有任何延迟的连续 DOM 操作，必须穿插随机等待时间，否则极易触发反机器验证。

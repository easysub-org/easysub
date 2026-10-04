# 贡献指南

感谢愿意花时间。提 PR 之前请先看这页 —— **只有一件事是硬性要求：签 CLA**。

## 一、签 CLA（必须）

本项目采用 [CLA.md](CLA.md)：**你保留自己贡献的版权，但授予项目所有者按任意许可证
（含商业许可）再许可的权利**。这样项目以后若改成「AGPL 开源 + 商业授权」的双许可模式，
不必回头找每一位历史贡献者补签。

**怎么签**：在**你的 PR 里发一条评论**，内容照抄这一句（与 [CLA Assistant](https://cla-assistant.io/)
用的是同一句）：

> I have read the CLA Document and I hereby sign the CLA.

建议下一行写上你的**法定姓名**，便于留档（可选，但推荐）：

> Name: 张三

发完之后 `cla` 工作流会：把你的用户名、姓名、日期与该评论链接写进
[`signatures/cla.json`](signatures/cla.json)（**签名落库**，所以事后删掉或编辑那条评论不影响记录 ——
这也是主流 CLA 机器人存签名的原因），并打上 `cla-signed` 标签。**没签之前这个检查会失败**
（`cla-pending`），如果仓库开了分支保护并把 `CLA` 设为必需状态检查，PR 就无法合并。

不想签也完全没问题 —— 那这个 PR 里的**代码**没法合并，但欢迎提 issue 讨论思路。

**改过 CLA 正文或这个工作流之后怎么测**：本地跑 `node scripts/test-cla-workflow.mjs` —— 它从
`cla.yml` 里抽出内嵌脚本，用假的 GitHub API 跑 11 个场景（免签名单 / 未签 / 已提醒 / 签署落库 /
姓名注入 / 签名库不存在 / 库里已有 / 大小写 / 别人评论 / 已关闭 PR / 手动重跑），零依赖、不联网。
真机路径用 Actions → `cla` → **Run workflow**（填 PR 号）手动重跑。

> 为什么不靠 GitHub 默认规则：默认的 "inbound = outbound" 只让项目按**当时那份许可证**使用你的
> 贡献，不包含「换成别的许可证」的权利。细节见 CLA.md 第 2 条。

## 二、提 PR 的小约定

- **一个 PR 做一件事**，标题写清影响面。提交信息风格：`feat(scope): …` / `fix(scope): …`（中文正文）。
- 提交信息可选带 DCO 签名（`git commit -s`）——有助于追溯来源，但**不强制**（法律侧由 CLA 覆盖）。
- 不要提交本地产物与个人笔记：`dist/`、`dist-web/`、`node_modules/`、模型文件
  （`public/wasm/*.data|*.wasm|*.onnx`）、`.workbuddy/`、设计/审计用的本地 `.md`。
  `.gitignore` 已覆盖大部分，PR 里出现这些请自行摘掉。

## 三、本地检查（提交前请自己跑一遍）

```bash
npm install
npm run typecheck     # tsc --noEmit，必须干净
npm run build         # 扩展
npm run build:web     # 纯 Web 版
```

本项目没有自动化测试套件；行为验证靠手动跑一遍受影响的两条宿主（扩展 / Web 版）。
改动涉及音频链路时，请说明你**实测过哪些平台与浏览器**。

## 四、领域边界（免得白做）

- 主仓库 = **扩展 + 纯 Web 版**（TypeScript）。桌面端采集在**独立仓库**
  [easysub-helper](https://github.com/easysub-org/easysub-helper)（Python），不要往主仓库里塞 Python。
- 助手只做两件事：**采集本机音频 + 与页面配对**。它不托管 Web 产物、不碰模型、不把设备列表
  做成 HTTP API —— 往这些方向提 PR 会被拒。
- 音频契约固定：**16 kHz 单声道 f32le，20 ms 一帧（320 采样 / 1280 字节，无帧头）**，
  走 `ws://127.0.0.1:<port>/ws`。改这个要两个仓库一起改。

## 五、文案与 i18n

- **所有用户可见文案必须中英双语**：改 `src/i18n.ts` 时 zh / en 两个 catalog 都要动，
  key 必须一一对应（不要只加一边）。
- 界面里已有的静态文案走 `data-key` 委托或 `tSync()`；新增文案请沿用同一套机制，不要硬编码中文。

## 六、交流

就事论事、正常交流。不接受人身攻击、广告、与项目无关的灌水。

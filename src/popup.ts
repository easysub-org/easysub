// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
// 扩展弹窗入口：只负责挂载共享控制面板（src/panel.ts）。
// 面板 DOM/CSS 与纯 Web 版共用一份模板（src/ui.css + src/ui-body.html），
// 面板逻辑共用 src/panel.ts，扩展与 Web 的差异全部收在 platform.ts 的宿主判定里。
// 这就是"两版长期共存、新功能只写一遍"的结构：新功能加在 panel.ts / ui-body.html 里，
// 两端自动都有；只有真的依赖扩展 API 时才在 panel.ts 里按 IS_EXTENSION 分支。
import { mountPanel } from './panel';

mountPanel();

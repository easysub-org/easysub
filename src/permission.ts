// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
import { getLang, setLang, tSync } from './i18n';

const statusEl = document.getElementById('status')!;
const btn = document.getElementById('btnGrant') as HTMLButtonElement;
const btnLang = document.getElementById('btnLang') as HTMLButtonElement;

// 状态行统一走安全 DOM 构建（文本全部经 textContent 落盘，不经过 HTML 解析）。
// 坑：原实现用 innerHTML 拼接错误对象，e.toString() 的内容会被当 HTML 解析，
// 某些 UA 错误信息含尖括号时可注入标记。
function setStatusLine(text: string, cls: '' | 'ok' | 'err') {
  statusEl.replaceChildren();
  if (!cls) { statusEl.textContent = text; return; }
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = text;
  statusEl.appendChild(span);
}

let currentLang = 'zh_CN';

async function applyLang() {
  currentLang = await getLang();
  const tr = (key: string) => tSync(currentLang, key);
  document.getElementById('permissionTitle')!.textContent = tr('permissionTitle');
  document.getElementById('permissionDesc')!.textContent = tr('permissionDesc');
  document.getElementById('permissionBtnText')!.textContent = tr('permissionGrant');
  btnLang.textContent = tr('langSwitch');
}

btnLang.onclick = async () => {
  const newLang = currentLang === 'zh_CN' ? 'en' : 'zh_CN';
  await setLang(newLang);
  await applyLang();
};

btn.onclick = async () => {
  btn.disabled = true;
  const tr = (key: string) => tSync(currentLang, key);
  setStatusLine(tr('permissionRequesting'), '');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    setStatusLine(tr('permissionGranted'), 'ok');
    chrome.storage.local.set({ micGranted: true });
    btn.disabled = false;
  } catch (e: any) {
    setStatusLine(`✗ ${tr('permissionFailed')}: ${e?.message || e}`, 'err');
    btn.disabled = false;
  }
};

applyLang();

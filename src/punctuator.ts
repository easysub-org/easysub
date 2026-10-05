// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 hcz1017
const CJK = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/
const LATIN = /[a-zA-Z]/

function hasCJK(s: string) { return CJK.test(s) }
function hasLatin(s: string) { return LATIN.test(s) }

const CN_QUEST_START = /^(为什么|怎么|如何|哪里|谁|什么|啥|岂|难道|何不|何必|何苦|是否|是不是|能不能|要不要|有没有|可不可以|敢不敢|应不应该|会不会|好不好|行不行|对不对|值不值得)/
const EN_QUEST_START = /^(WH(O|OSE|OM|ICH|AT|Y|EN|ERE|ETHER)|HOW|DO(ES)?|DID|IS|ARE|WAS|WERE|WILL|WOULD|CAN|COULD|SHALL|SHOULD|MAY|MIGHT|HAS|HAVE|HAD|AM|AIN'T|DON'T|DOESN'T|DIDN'T|ISN'T|AREN'T|WASN'T|WEREN'T|WON'T|WOULDN'T|CAN'T|COULDN'T|SHAN'T|SHOULDN'T|MAY NOT|MIGHT NOT|HASN'T|HAVEN'T|HADN'T)\b/i

const CN_QUEST_END = /(吗|呢|么|啥|不成|没有|吗你|吧你)$/
const CN_QUEST_PATTERN = /(是.+(还是|or)|有.+(没有|吗)|(是不是|能不能|要不要|有没有)\s+\w|\w不\w$|多(少|大|长|久|高|远|重)|几[天岁个次回])/

const CN_EXCL_START = /^(真|太|好|多么|非常|极|简直|居然|竟然|果然|幸亏|幸好|好在|实在|可|真是)/
const CN_EXCL_SHORT = /^(好|对|是|不|行|可以|当然|没错|对了|糟糕|完了|天哪|天啊|妈呀|哎呀|哎哟|哇|切|呸|哼|哈|哇哦|不是吧|不会吧|真的假的|不是吧你)$/
const CN_EXCL_END = /(啊|呀|哇|哦|噢|啦|嘛|呵|哈|哟|呐|哪|咧)$/

const EN_EXCL_START = /^(WHAT\s+A|HOW\s+(A|MANY|MUCH|LONG|FAR|TALL|DEEP|WIDE)|OH|WOW|AH|OOH|YAY|YEAH|NAH|NOPE|YES|NO|GREAT|AWESOME|EXCELLENT|PERFECT|WONDERFUL|AMAZING|INCREDIBLE|TERRIBLE|HORRIBLE|AWFUL|STOP|GO|LOOK|LISTEN|WATCH|COME|RUN|HELP|DANG|DARN|CRAP|SHIT)\b/i

// 坑：同 CN_CONJ_MID，尾部 \b 在纯中文后永远不成立（"所以我们…"全不命中）。
// 且去掉边界约束后暴露第二个坑：备选词表里有重叠词（还有/还有呢、首先/首先呢、
// 所以/所以说/所以说呢、一来/一来呢…），正则交替取"最左候选"，短词会抢先命中，
// 把逗号插错位置——如"然后呢我们就走了"会变成"然后，呢我们就走了"。
// 修复：由词表动态构建正则并按长度降序排列，保证最长词优先匹配；
// 句首锚定 ^ 不需要尾部边界：所有候选都是完整连接词，其后无论是汉字还是
// 英文/数字（如"因此AI很火"）都应紧跟逗号。
const CN_COMMA_WORDS = [
  '不过', '但是', '然而', '因此', '所以', '因为', '虽然', '尽管', '如果', '要是',
  '假如', '倘若', '而且', '并且', '况且', '何况', '此外', '另外', '特别是', '尤其是',
  '首先', '其次', '然后', '最后', '最终', '例如', '比如', '譬如', '换句话说',
  '也就是说', '换言之', '总的来说', '总而言之', '事实上', '其实', '当然', '确实',
  '的确', '显然', '一般说来', '一般情况下', '一般来说', '通常来说', '严格来说',
  '具体来说', '简单来说', '相对而言', '相比之下', '与此相反', '反过来',
  '反过来说', '另一方面', '一方面', '这样的话', '于是乎', '于是',
  // 带"呢"的长变体必须参与长度排序，否则会被对应短词抢先遮蔽
  '还有', '还有呢', '首先呢', '其次呢', '然后呢', '不过呢', '但是呢',
  '所以说', '所以说呢', '一来', '一来呢', '二来', '二来呢',
]
const CN_COMMA_AFTER = new RegExp(
  '^(' + [...new Set(CN_COMMA_WORDS)].sort((a, b) => b.length - a.length).join('|') + ')'
)

const EN_COMMA_AFTER = /^(HOWEVER|THEREFORE|FURTHERMORE|MOREOVER|NEVERTHELESS|NONETHELESS|MEANWHILE|BESIDES|ADDITIONALLY|ALSO|FIRST(LY)?|SECOND(LY)?|THIRD(LY)?|FINALLY|NEXT|THEN|LAST(LY)?|LIKEWISE|SIMILARLY|CONVERSELY|INSTEAD|OTHERWISE|SPECIFICALLY|PARTICULARLY|NOTABLY|INDEED|CERTAINLY|SURELY|UNDOUBTEDLY|ADMITTEDLY|HONESTLY|FRANKLY|ACTUALLY|BASICALLY|ESSENTIALLY|TYPICALLY|NORMALLY|USUALLY|TRADITIONALLY|ULTIMATELY|EVENTUALLY|RECENTLY|CURRENTLY|INITIALLY|ORIGINALLY|BRIEFLY|IN SHORT|IN BRIEF|IN SUMMARY|TO SUMMARIZE|IN CONCLUSION|IN OTHER WORDS|IN PARTICULAR|IN GENERAL|IN FACT|AS A RESULT|AS A CONSEQUENCE|FOR EXAMPLE|FOR INSTANCE|ON THE CONTRARY|ON THE OTHER HAND|AS A MATTER OF FACT|IN ADDITION|IN THE SAME WAY|IN THE MEANTIME|AT FIRST|AT LAST|AT LEAST|AFTER ALL|ABOVE ALL|ALL IN ALL|MOST IMPORTANTLY)\b/i

// 坑：JS 正则的 \b 是 ASCII 词界（\w 仅含 [A-Za-z0-9_]），汉字与汉字之间不存在词界，
// 导致 /\b(但是|…)\b/ 这类写法在纯中文文本里永远匹配不到（实测"我很好但是现在没空"
// 不命中），回退标点模式下中文逗号功能整体失效。
// 修复：改用 ASCII 字母数字的前置/后置断言（lookbehind 需 Chrome 62+/MV3 88+，可用）：
// 两侧允许是汉字（兼容纯中文与中英混排），同时保证不会切进英文单词内部。
const CN_CONJ_MID = /(?<![A-Za-z0-9])(但是|然而|不过|可是|只是|因此|所以|因为|虽然|尽管|如果|要是|假如|倘若|而且|并且|况且|何况|否则|不然|要不|要不然|于是|从而|进而|以致|以便|以免|免得)(?![A-Za-z0-9])/
const EN_CONJ_MID = /\b(HOWEVER|THEREFORE|FURTHERMORE|MOREOVER|NEVERTHELESS|MEANWHILE|BESIDES|ADDITIONALLY|ALSO|CONVERSELY|INSTEAD|OTHERWISE|THUS|HENCE)\b/i

function insertComma(s: string): string {
  let r = s

  const afterMatch = r.match(CN_COMMA_AFTER)
  if (afterMatch && afterMatch.index === 0) {
    const m = afterMatch[0]
    if (r.length > m.length) {
      const rest = r.slice(m.length)
      if (!rest.startsWith('，') && !rest.startsWith(',')) {
        r = m + '，' + rest.trimStart()
      }
    }
  }

  const enAfterMatch = r.match(EN_COMMA_AFTER)
  if (enAfterMatch && enAfterMatch.index === 0) {
    const m = enAfterMatch[0]
    if (r.length > m.length) {
      const rest = r.slice(m.length)
      if (!rest.startsWith(',') && !rest.startsWith('，')) {
        r = m + ', ' + rest.trimStart()
      }
    }
  }

  const cnMid = r.match(CN_CONJ_MID)
  if (cnMid && cnMid.index && cnMid.index > 0) {
    const pre = r[cnMid.index - 1]
    if (pre !== '，' && pre !== '、') {
      r = r.slice(0, cnMid.index) + '，' + r.slice(cnMid.index)
    }
  }

  const enMid = r.match(EN_CONJ_MID)
  if (enMid && enMid.index && enMid.index > 0) {
    const pre = r[enMid.index - 1]
    if (pre !== ',' && pre !== '，') {
      r = r.slice(0, enMid.index) + ',' + r.slice(enMid.index)
    }
  }

  return r
}

function isQuestion(s: string): boolean {
  const t = s.trim()
  if (!t) return false

  const firstWord = t.split(/\s+/)[0] || t[0]

  if (hasCJK(t)) {
    if (CN_QUEST_START.test(t)) return true
    if (CN_QUEST_END.test(t)) return true
    if (CN_QUEST_PATTERN.test(t)) return true
  }

  if (hasLatin(t)) {
    if (EN_QUEST_START.test(t)) return true
  }

  return false
}

function isExclamation(s: string): boolean {
  const t = s.trim()
  if (!t) return false

  if (hasCJK(t)) {
    if (CN_EXCL_SHORT.test(t)) return true
    if (CN_EXCL_START.test(t)) return true
    if (t.length <= 8 && CN_EXCL_END.test(t)) return true
  }

  if (hasLatin(t)) {
    if (EN_EXCL_START.test(t)) return true
    if (t.length <= 10 && /^(YES|NO|OK|OKAY|YEAH|NAH|NOPE|WOW|HEY|HI|OH|AH|OOH|BYE|GOOD|GREAT|NICE|FINE|SURE|RIGHT|WRONG|TRUE|FALSE|DONE|STOP|GO|RUN|JUMP|SIT|STAND|HELP|FIRE|FREEZE|WAIT|QUIET|LISTEN|LOOK|WATCH)\b/i.test(t)) return true
  }

  return false
}

function lowercased(text: string): string {
  return text.replace(/[A-Za-z]+/g, w => {
    if (w.length <= 2) return w.toLowerCase()
    if (/^[A-Z]{2,}$/.test(w) && w.length > 3) return w.toLowerCase()
    return w[0].toUpperCase() + w.slice(1).toLowerCase()
  })
}

export function addPunctuation(text: string): string {
  const p = (window as any).__punctuator
  if (p) return p.addPunct(text.trim())

  const t = text.trim()
  if (!t) return t

  const last = t[t.length - 1]
  if (/[。！？，、；：\.,!?;:」』\)】]/.test(last)) return t

  let r = insertComma(t)

  if (isQuestion(r)) {
    return lowercased(r) + (hasCJK(r) ? '？' : '?')
  }

  if (isExclamation(r)) {
    return lowercased(r) + (hasCJK(r) ? '！' : '!')
  }

  if (hasCJK(r)) return lowercased(r) + '。'
  if (hasLatin(r)) return lowercased(r) + '.'

  return lowercased(r) + '。'
}

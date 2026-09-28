/**
 * 条款文本:风险揭示、使用条款、隐私说明。正文在仓库的 docs/legal/ 下,这里原样引进来(Vite 的 ?raw),
 * 界面上摆的和文档里写的是同一份——不手抄第二份。
 *
 * 三份文本开头都写着 `版本:YYYY-MM-DD`。用户同意的是这一版:同意时把这个版本号交给主进程,
 * 它和自己认的现行版本(desktop/consent.js 的 TERMS_VERSION)对不上就不作数。
 */
import risk from '../../../../docs/legal/risk-disclosure.md?raw';
import terms from '../../../../docs/legal/terms.md?raw';
import privacy from '../../../../docs/legal/privacy.md?raw';

export interface LegalDoc {
  key: 'risk' | 'terms' | 'privacy';
  title: string;
  text: string;
}

export const LEGAL_DOCS: LegalDoc[] = [
  { key: 'risk', title: '风险揭示', text: risk },
  { key: 'terms', title: '使用条款', text: terms },
  { key: 'privacy', title: '隐私说明', text: privacy },
];

/** 文本里写的版本号;三份不一致(或读不出来)时是空串——那样的构建谁也同意不了,问题会当场暴露。 */
export function legalVersion(docs: LegalDoc[] = LEGAL_DOCS): string {
  const versions = docs.map((d) => /^版本[::]\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(d.text)?.[1] ?? '');
  return versions.every((v) => v && v === versions[0]) ? (versions[0] ?? '') : '';
}

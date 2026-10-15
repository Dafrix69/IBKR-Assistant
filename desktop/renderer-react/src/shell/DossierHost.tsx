/**
 * 全站共用的两样:标的档案的抽屉、⌘K「查标的」。挂在壳上,哪一页都能开。
 * ⌘K(Windows 上 Ctrl+K)在输入框里也生效:这组键在这个软件里没有别的含义。
 */
import { useEffect, useRef, useState } from 'react';
import { Input, Modal, Tag, type InputRef } from 'antd';
import { lookupSymbol } from '../lib/intelRules';
import { SymbolDossier } from '../lib/SymbolDossier';
import { openDossier, setLookupOpen, useIntel } from '../store/intel';
import { MOD_KEY } from '../store/appearance';

function Lookup() {
  const { lookupOpen, recent, feed } = useIntel();
  const [text, setText] = useState('');
  const ref = useRef<InputRef>(null);
  useEffect(() => {
    if (lookupOpen) {
      setText('');
      setTimeout(() => ref.current?.focus(), 30);
    }
  }, [lookupOpen]);
  const symbol = lookupSymbol(text);
  const held = feed?.held ?? [];
  return (
    <Modal open={lookupOpen} onCancel={() => setLookupOpen(false)} footer={null} title="查标的" width={420} destroyOnHidden>
      <Input
        ref={ref}
        size="large"
        placeholder="代码,如 NVDA、SPX、$TSLA"
        value={text}
        status={text.trim() && !symbol ? 'warning' : undefined}
        onChange={(e) => setText(e.target.value)}
        onPressEnter={() => symbol && openDossier(symbol)}
      />
      <p className="lookup-hint">{text.trim() && !symbol ? '写代码(字母开头,最多 10 位);中文名在消息里会自动认出来。' : `回车打开档案:持仓、追踪、价位、异动、事件、提到它的消息,一页看完。${MOD_KEY}K 随时打开。`}</p>
      {held.length ? (
        <div className="lookup-row"><span>持仓</span>{held.map((s) => <Tag key={s} bordered={false} className="chip-tag" onClick={() => openDossier(s)}>{s}</Tag>)}</div>
      ) : null}
      {recent.length ? (
        <div className="lookup-row"><span>最近</span>{recent.map((s) => <Tag key={s} bordered={false} className="chip-tag" onClick={() => openDossier(s)}>{s}</Tag>)}</div>
      ) : null}
    </Modal>
  );
}

export function DossierHost() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      setLookupOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      <Lookup />
      <SymbolDossier />
    </>
  );
}

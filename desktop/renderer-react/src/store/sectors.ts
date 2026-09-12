/**
 * 自定义板块(股票池)+ 成分股行情。扫描页的三个子页与板块页共用这一份。
 *
 * 增删改在引擎侧都是本地库操作,走"本地道"即来即答;界面用回执里的板块直接覆盖本地那一份,
 * 不再多拉一次列表。移除先改本地再等回执:等回执的那几百毫秒里再点一次会得到"不在该板块中"。
 *
 * 成员身份 = 两个开关:进池子的股默认「盯价位」「盯异动」都开,出池子(且不在任何板块里了)就连带撤掉。
 * 这两件事在引擎里跟着 sectors.* 一起做,回执带 `watch` / `skipped` / `dropped`——
 * 上限吃满、指数不能盯异动这些都要如实说出来(store/pool.ts),不能让人以为都开上了。
 */
import { useSyncExternalStore } from 'react';
import { dafri, errorMessage } from '../bridge';
import { loadAlerts } from './alerts';
import { showBanner } from './banner';
import { reportDropped, reportPoolWatch, reportSkipped } from './pool';
import { loadQuality } from './quality';
import { getStatus } from './status';

export interface SectorStock {
  symbol: string;
  company?: string;
  reason?: string;
  tag?: string;
}

export interface Sector {
  id: string;
  name: string;
  stocks: SectorStock[];
  updated_at?: string;
  [key: string]: unknown;
}

export interface Quote {
  last?: number | null;
  close?: number | null;
  change_pct?: number | null;
}

type Listener = () => void;
let sectors: Sector[] = [];
let quotes: Record<string, Quote> = {};
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((l) => l());
}

function subscribe(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export async function loadSectors(): Promise<Sector[]> {
  try {
    const res = await dafri.listSectors();
    sectors = Array.isArray(res?.sectors) ? res.sectors : [];
    emit();
  } catch (err) {
    showBanner(`读取板块失败:${errorMessage(err)}`, false);
  }
  return sectors;
}

function brokerPanel(): string {
  return getStatus()?.broker_provider === 'futu' ? '「富途 OpenD」' : '「TWS 连接」';
}

export async function refreshQuotes(): Promise<void> {
  try {
    const res = await dafri.sectorQuotes();
    quotes = res?.quotes || {};
    emit();
    if (!res?.connected && sectors.some((s) => s.stocks.length)) {
      showBanner(`行情需要先在${brokerPanel()}面板连接引擎`, true);
    }
  } catch (err) {
    showBanner(`刷新板块行情失败:${errorMessage(err)}`, false);
  }
}

/** 用 RPC 回来的板块覆盖本地那一份;回执没带板块就退回拉列表。 */
async function replaceSector(fresh: Sector | undefined): Promise<void> {
  if (!fresh || !fresh.id) {
    await loadSectors();
    return;
  }
  const i = sectors.findIndex((s) => s.id === fresh.id);
  sectors = i >= 0 ? sectors.map((s, k) => (k === i ? fresh : s)) : [...sectors, fresh];
  emit();
}

export async function addSector(name: string): Promise<boolean> {
  try {
    const { sector } = await dafri.addSector(name);
    await replaceSector(sector);
    return true;
  } catch (err) {
    showBanner(`新建板块失败:${errorMessage(err)}`, false);
    return false;
  }
}

export async function deleteSector(id: string, name: string): Promise<void> {
  const ok = await dafri.confirm({
    title: '删除板块',
    message: `删除板块「${name}」?`,
    detail: '只删除这个板块及其 AI 选股结果,不影响任何交易数据。里面的股如果不在别的板块里,连带停止盯价位与盯异动。',
    confirmLabel: '删除',
  });
  if (ok !== true) return;
  try {
    const res = await dafri.deleteSector(id);
    sectors = sectors.filter((s) => s.id !== id);
    emit();
    reportDropped(res?.dropped);
    await Promise.all([loadAlerts(), loadQuality()]);
  } catch (err) {
    showBanner(`删除板块失败:${errorMessage(err)}`, false);
    await loadSectors();
  }
}

export async function addStock(sectorId: string, symbol: string, tag: string): Promise<boolean> {
  try {
    const res = await dafri.addSectorStock(sectorId, symbol, tag);
    await replaceSector(res?.sector);
    reportPoolWatch(res?.watch); // 默认两个开关都开,开不上的照引擎的原话说
    void refreshQuotes(); // 新加那只的行情后台补
    await Promise.all([loadAlerts(), loadQuality()]); // 新建的 watch / quality 行要出现在行上
    return true;
  } catch (err) {
    showBanner(`添加股票失败:${errorMessage(err)}`, false);
    return false;
  }
}

export async function removeStock(sectorId: string, symbol: string): Promise<void> {
  const before = sectors;
  sectors = sectors.map((s) => (s.id === sectorId ? { ...s, stocks: s.stocks.filter((x) => x.symbol !== symbol) } : s));
  emit();
  try {
    const res = await dafri.removeSectorStock(sectorId, symbol);
    await replaceSector(res?.sector);
    reportDropped(res?.dropped); // 它不在任何板块里了:两个开关连带撤掉,说一声
    await Promise.all([loadAlerts(), loadQuality()]);
  } catch (err) {
    sectors = before;
    emit();
    showBanner(`移除股票失败:${errorMessage(err)}`, false);
    await loadSectors(); // 以引擎为准
  }
}

export async function setTag(sectorId: string, symbol: string, tag: string): Promise<boolean> {
  try {
    const { sector } = await dafri.setSectorTag(sectorId, symbol, tag);
    await replaceSector(sector);
    return true;
  } catch (err) {
    showBanner(`改标签失败:${errorMessage(err)}`, false);
    return false;
  }
}

export async function pickSector(id: string): Promise<void> {
  try {
    const res = await dafri.pickSector(id);
    await loadSectors();
    await refreshQuotes();
    // 一次十几只很容易吃满 30 只上限:哪几只没开上,照原话说
    reportSkipped('这一批里有几只没开上监控:', res?.skipped);
    await Promise.all([loadAlerts(), loadQuality()]);
  } catch (err) {
    showBanner(`AI 选股失败:${errorMessage(err)}`, false);
  }
}

export function useSectors(): Sector[] {
  return useSyncExternalStore(subscribe, () => sectors);
}

export function useQuotes(): Record<string, Quote> {
  return useSyncExternalStore(subscribe, () => quotes);
}

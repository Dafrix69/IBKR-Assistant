/** 新建追踪的那张表单:设目标(止盈 / 止损 / 跟踪 / 利润回撤 / 标的目标价)、试算、提交。
 *
 * 2026-09-20 从 pages/Tracker.tsx 搬出来(函数体逐字未改)。搬的是**设置目标 → 授权自动发单**这一半;
 * 页面那头剩下的是「列已有的持仓与追踪」。这张表单提交的是 tracker.add——它设的是「到价自动发单」的授权,
 * 不是一条备忘,所以载荷字面量必须直接标成 TrackerAddSpec(只有标了类型的字面量,TypeScript 才查多余的键)。
 */
import { useEffect, useState } from 'react';
import { Button, InputNumber, Select, Switch } from 'antd';
import { dafri, errorMessage, type TrackerAddSpec } from '../bridge';
import { fmtMoney, fmtNum } from './format';
import { showBanner } from '../store/banner';
import { pickableAccounts, useStatus } from '../store/status';
import { loadTracker, type Position, type SpotTargetRow } from '../store/tracker';
import { Meta } from '../ui/kit';
/** σ 是从哪来的,用人话说一遍。clock 那一档必须显眼——它是模型默认值,不是市场价。 */
const SIGMA_SOURCE_HINT: Record<string, string> = {
  none: '正股:目标价就是价格,不用波动率',
  smile: '每条腿按各自当前的报价反解波动率,在目标价处各自重估',
  net: '按这份持仓当前的报价反解波动率',
  leg: '有腿缺报价,按最贴近平值那条腿的波动率给所有腿用',
  clock: '拿不到市场报价,用的是模型默认波动率(EM×√剩余方差)——不是市场价,只当个参考',
};

export function TrackForm({ p, onCreated }: { p: Position; onCreated: (id: string | null) => void }) {
  const status = useStatus();
  const long = p.quantity > 0;
  const isCombo = p.sec_type === 'BAG';
  const [tp, setTp] = useState<number | null>(null);
  const [sl, setSl] = useState<number | null>(null);
  const [trail, setTrail] = useState<number | null>(null);
  const [profitDd, setProfitDd] = useState<number | null>(null);
  const [tiers, setTiers] = useState(false);
  const [spotTarget, setSpotTarget] = useState<number | null>(null);
  // 试算结果和它算的那个目标价绑在一起:改了目标价、防抖还没跑完的那几百毫秒里,
  // 旧结果必须立刻失效——否则用户同意的是上一个目标价的数,发出去的是新的。
  const [preview, setPreview] = useState<{ target: number; row: SpotTargetRow } | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [fraction, setFraction] = useState<number | null>(null);
  // 追价平仓最多让到自然价的百分之几(期权 / 组合);空 = 引擎默认 10%
  const [chaseMax, setChaseMax] = useState<number | null>(null);
  const [auto, setAuto] = useState(false);
  const [orderType, setOrderType] = useState<'MKT' | 'LMT'>(isCombo ? 'LMT' : 'MKT');
  const [host, setHost] = useState(false);
  const [saving, setSaving] = useState(false);

  const acct = pickableAccounts(status).find((a) => a.alias === p.account);
  const isPaper = acct ? acct.is_paper : true;
  const hasSpotTarget = spotTarget !== null && spotTarget > 0;
  // 只认算的就是当前这个目标价的那一份;对不上就当没有
  const priced = hasSpotTarget && preview?.target === spotTarget ? preview.row : null;
  // 组合在券商那边只托管一张限价止盈单,价由标的目标价现算——没填目标价就开不了(引擎 checkTargets
  // 同一条规矩)。止损、利润回撤照样能设:软件盯着,触发时把那张托管单改到立刻成交的价
  const hostAllowed = !isCombo || hasSpotTarget;
  const hostOn = host && hostAllowed;
  const derivative = isCombo || p.sec_type === 'OPT' || p.sec_type === 'FOP';
  const str = (v: number | null) => (v === null || v === undefined ? '' : String(v));

  // 填标的目标价的时候就把「那时值多少、赚多少」摆出来:这个数就是将要挂出去的限价,
  // 得让人在按下按钮之前看见它。防抖 400ms——每敲一个字符打一次行情请求没必要。
  useEffect(() => {
    if (spotTarget === null || !(spotTarget > 0)) {
      setPreview(null);
      setPreviewErr(null);
      return;
    }
    let alive = true;
    const target = spotTarget;
    setPreview(null);          // 目标价一变,旧的数当场作废,不给"看着还在"的错觉
    setPreviewErr(null);
    const t = setTimeout(async () => {
      try {
        const res = await dafri.previewSpotTarget(p.key, target, chaseMax);
        if (!alive) return;
        const row = res?.spot_target || null;
        setPreview(row?.price != null ? { target, row } : null);
        setPreviewErr(row?.price != null ? null : row?.reason || '这一刻算不出这个点位的价格。');
      } catch (err) {
        if (!alive) return;
        setPreview(null);
        setPreviewErr(errorMessage(err));
      }
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [p.key, spotTarget, chaseMax]);

  async function start() {
    // 标上契约类型:这个字面量里写错一个键名(或引擎契约改了键名)就编译不过,而不是追踪建成了、那道保护没设上
    const spec: TrackerAddSpec = {
      key: p.key,
      take_profit: hasSpotTarget ? '' : str(tp),
      stop_loss: str(sl),
      trail_pct: str(trail),
      profit_drawdown_pct: tiers ? '' : str(profitDd),
      profit_drawdown_preset: tiers ? 'fly' : undefined,
      spot_target: str(spotTarget),
      close_fraction_pct: str(fraction) || undefined,
      chase_max_pct: str(chaseMax) || undefined,
      auto_close: auto,
      order_type: orderType,
      host_at_broker: hostOn,
    };
    if (spec.host_at_broker && !spec.auto_close) {
      // 托管单就是授权发单——没有总开关的托管是自相矛盾的设置
      showBanner('托管到券商需先打开「到价自动平仓」:挂托管单即发单授权。', false);
      return;
    }
    // 「同意价格后发单」:同意的那一刻现取一次价,不拿几秒前那份凑数。
    // 算不出来就不往下走——盲签一张会真发出去的单,比不发危险得多。
    let quoted: SpotTargetRow | null = null;
    if (hasSpotTarget && (spec.auto_close || spec.host_at_broker)) {
      setSaving(true);
      try {
        const res = await dafri.previewSpotTarget(p.key, spotTarget!, chaseMax);
        quoted = res?.spot_target || null;
      } catch (err) {
        showBanner(errorMessage(err), false);
        setSaving(false);
        return;
      } finally {
        setSaving(false);
      }
      if (quoted?.price == null) {
        showBanner(quoted?.reason || `这一刻算不出 ${p.symbol} 到 ${spotTarget} 的价格,先别发单。`, false);
        return;
      }
      if (quoted.sigma_source === 'clock') {
        // 能同意的只有市场价算出来的数;模型默认波动率算的参考价没有人能替你担保
        showBanner('现在拿不到市场报价,这个价是按模型默认波动率算的参考值,不能拿它发单。等行情来了再设。', false);
        return;
      }
      if (quoted.warning) {
        showBanner(quoted.warning, false);
        return;
      }
    }
    // 要同意的那句话:先说价,再说它之后会怎么动
    const priceLine = quoted
      ? (quoted.spot_note ? `现价 ${quoted.spot != null ? fmtNum(quoted.spot) : '—'}:${quoted.spot_note}\n` : '') +
        `${p.symbol} 到 ${fmtNum(spotTarget)} → ${isCombo ? '组合净价' : '价格'}约 ${fmtMoney(quoted.price)}` +
        `,预估收益 ${fmtMoney(quoted.pnl)}\n` +
        `这个价按当前波动率算出来,软件开着时每秒重算并改单——标的真走到 ${fmtNum(spotTarget)} 时\n` +
        `挂的就是那一刻的价,不是现在这个数。\n` +
        (derivative
          ? `标的真到了 ${fmtNum(spotTarget)}(软件开着时按秒盯),不等${isCombo ? '组合' : '期权'}价追上来,` +
            '直接按各腿当时的买卖价挂立刻成交的价平掉,没成交就每秒再追。\n'
          : '')
      : '';
    if (spec.host_at_broker) {
      const ok = await dafri.confirm({
        title: quoted ? '确认这个止盈价位,并挂到券商' : '托管到券商服务器',
        message: quoted
          ? `${p.symbol} 到 ${fmtNum(spotTarget)} 就走,现在算下来约 ${fmtMoney(quoted.price)}。`
          : `${p.symbol} 的止盈/止损将作为 GTC 单挂在券商服务器上。`,
        detail:
          priceLine +
          `数量 ${Math.abs(p.quantity)} · 账户 ${p.account}\n` +
          '这张 GTC 限价单会立刻挂到券商服务器上;软件关闭后它仍然有效,价格停在最后一次调整的位置。\n' +
          '触发由券商实时行情决定,一张成交其余自动撤销(OCA)。',
        confirmLabel: quoted ? '同意这个价,挂单' : '我确认',
      });
      if (!ok) return;
    } else if (spec.auto_close) {
      // 这一步是在授权软件替你发单,值得一次明确的确认
      const ok = await dafri.confirm({
        title: quoted ? '确认这个止盈价位,并开启自动平仓' : '开启到价自动平仓',
        message: quoted
          ? `${p.symbol} 到 ${fmtNum(spotTarget)} 就走,现在算下来约 ${fmtMoney(quoted.price)}。`
          : `${p.symbol} 到价后会自动发出平仓单,不再询问。`,
        detail: priceLine +
          `数量 ${Math.abs(p.quantity)} · 账户 ${p.account} · ${orderType === 'MKT' ? '市价平仓' : '限价平仓'}\n软件关闭后不再盯盘。`,
        confirmLabel: quoted ? '同意这个价,开始追踪' : '我确认',
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      const created = await dafri.addTracker(spec);
      showBanner(`已开始追踪 ${p.symbol},下面「正在追踪」里可以看盯盘进度。`, true);
      await loadTracker(true);
      onCreated(created?.track?.id || null);
    } catch (err) {
      showBanner(errorMessage(err), false);
    } finally {
      setSaving(false);
    }
  }

  const num = (props: { label: string; hint: string; value: number | null; onChange: (v: number | null) => void; disabled?: boolean; autoFocus?: boolean }) => (
    <label className="track-field">
      <span>{props.label}</span>
      <InputNumber
        min={0}
        step={0.01}
        placeholder={props.hint}
        value={props.value}
        disabled={props.disabled}
        autoFocus={props.autoFocus}
        onChange={(v) => props.onChange(v === null || v === undefined ? null : Number(v))}
      />
    </label>
  );

  return (
    <div className="track-form">
      {/* 标的目标价:人心里想的止盈位是**标的**走到哪儿,不是这份持仓值多少。
          换算成价格由引擎每轮现算——同一个目标位,上午和尾盘对应的期权价差着一倍。 */}
      <label className="track-field">
        <span>
          标的目标价({p.symbol})
          <span className="sub">填标的走到哪儿就走;止盈价按当前波动率每秒现算,不用自己估</span>
        </span>
        <InputNumber
          min={0}
          step={1}
          placeholder={`${p.symbol} 走到多少`}
          value={spotTarget}
          onChange={(v) => setSpotTarget(v === null || v === undefined ? null : Number(v))}
        />
      </label>
      {spotTarget !== null && spotTarget > 0 ? (
        <div className="track-preview">
          {priced ? (
            <>
              <Meta
                items={[
                  `${p.symbol} 到 ${fmtNum(spotTarget)}`,
                  <span className="strong">{`${isCombo ? '组合净价' : '约值'} ${fmtMoney(priced.price)}`}</span>,
                  <span className={(priced.pnl ?? 0) >= 0 ? 'pnl-up' : 'pnl-down'}>
                    {`预估收益 ${(priced.pnl ?? 0) >= 0 ? '+' : ''}${fmtMoney(priced.pnl)}`}
                    {priced.pnl_pct != null ? ` (${Number(priced.pnl_pct).toFixed(1)}%)` : ''}
                  </span>,
                ]}
              />
              {priced.warning ? <div className="hint warn-text">{priced.warning}</div> : null}
              {priced.natural != null ? (
                <div className="hint">
                  {`现在立刻平掉约 ${fmtMoney(priced.natural)}(按各腿当前买卖价;标的到了目标价、或止损类目标触发时,平仓单会改到这个口径的价追着平)`}
                  {priced.chase_floor != null
                    ? `;追价先在这个价上等两秒,之后每秒再让一跳,最多让到 ${fmtMoney(priced.chase_floor)}(${priced.chase_max_pct ?? 10}%)`
                    : ''}
                </div>
              ) : null}
              <div className={priced.sigma_source === 'clock' ? 'hint warn-text' : 'hint'}>
                {SIGMA_SOURCE_HINT[priced.sigma_source || ''] || ''}
                {priced.leg_sigmas
                  ? ` · σ_剩余 ${Object.entries(priced.leg_sigmas).map(([k, v]) => `${k} ${fmtNum(v)}`).join(' / ')} 点`
                  : priced.sigma != null ? ` · σ_剩余 ${fmtNum(priced.sigma)} 点` : ''}
              </div>
              {priced.spot_note ? (
                <div className="hint">{`${p.symbol} 现价 ${priced.spot != null ? fmtNum(priced.spot) : '—'}:${priced.spot_note}`}</div>
              ) : null}
              {priced.sigma_source === 'clock' ? (
                <div className="hint warn-text">这个价只能参考:拿不到市场报价,不能拿它开自动平仓或挂单。</div>
              ) : null}
            </>
          ) : (
            <div className="hint">{previewErr || '正在按当前行情试算…'}</div>
          )}
        </div>
      ) : null}
      {/* 填了标的目标价,止盈价就由引擎每轮现算——把它禁掉,免得人以为自己填的那个数说了算 */}
      {num({
        label: '止盈价',
        hint: hasSpotTarget ? '由上面的标的目标价现算' : long ? '高于现价' : '低于现价',
        value: hasSpotTarget ? null : tp,
        onChange: setTp,
        disabled: hasSpotTarget,
        autoFocus: true,
      })}
      {num({ label: '止损价', hint: long ? '低于现价' : '高于现价', value: sl, onChange: setSl })}
      {/* 两个"追踪"是不同刻度,标签必须自解释:价格回撤 5% 在利润口径上会被成本杠杆放大 */}
      {num({ label: '跟踪止损 %(按价格)', hint: '价格从峰值回落 N%,全平', value: trail, onChange: setTrail })}
      {num({ label: '利润回撤 %(按利润)', hint: '利润从峰值缩水 N%', value: profitDd, onChange: setProfitDd, disabled: tiers })}
      <label className="switch-row">
        <span className="group-label">
          分档利润回撤(蝶式 40/30/20)
          <span className="sub">按浮盈相对成本的倍数换档:&lt;1× 让 40%、1–3× 让 30%、≥3× 让 20%,15:00 后一律减半。勾上就不看上面那个固定百分比</span>
        </span>
        <Switch
          checked={tiers}
          onChange={(v) => {
            setTiers(v);
            if (v) setProfitDd(null);
          }}
        />
      </label>
      {/* 触发后平掉多少仓位:100 = 全平,50 = 卖一半锁利。向下取整,绝不超过持仓 */}
      {num({ label: '触发后平仓比例 %', hint: '默认 100 全平,50=卖一半', value: fraction, onChange: setFraction })}
      {/* 追价平仓的让价上限:触发后平仓单先挂在立刻成交价上等两秒,之后每秒再让一跳,让到这个比例为止 */}
      {p.sec_type !== 'STK'
        ? num({ label: '追价最多让价 %', hint: '默认 10;触发后先挂立刻成交价等两秒,之后每秒再让一跳,让到这里为止(至少两跳)', value: chaseMax, onChange: setChaseMax })
        : null}
      <label className="switch-row">
        <span className="group-label">
          到价自动平仓
          <span className="sub">到价即自动发平仓单,不再询问;仍受自动执行、实盘开关、熔断三道闸门约束</span>
        </span>
        <Switch checked={auto} onChange={setAuto} />
      </label>
      <label className="track-field">
        <span>平仓方式</span>
        <Select
          value={orderType}
          disabled={isCombo}
          onChange={(v) => setOrderType(v)}
          options={[
            { value: 'MKT', label: '市价(一定成交)' },
            { value: 'LMT', label: '限价(控价,可能不成交)' },
          ]}
        />
      </label>
      {/* 托管到券商:GTC+OCA 挂在 IBKR 服务器,关机也生效;富途账户引擎会当场拒绝 */}
      <label className="switch-row">
        <span className="group-label">
          止盈/止损托管到券商(IBKR)
          <span className="sub">
            {isCombo
              ? hasSpotTarget
                ? '券商那边挂一张限价止盈单,价按上面的标的目标价每秒现算、原地改;GTC,关机也有效。止损、利润回撤由软件盯着——它们触发,或标的真到了目标价,软件把这张单改到立刻成交的价平掉(软件开着时)'
                : '组合要先填上面的「标的目标价」才能托管:托管的就是按它算出来的那张限价止盈单'
              : 'GTC 单挂在券商服务器,关机也触发,不受本机轮询与行情延迟影响。利润回撤为动态停损,软件开着时按秒调整,关掉则停在最后价位'}
          </span>
        </span>
        <Switch checked={hostOn} disabled={!hostAllowed} onChange={setHost} />
      </label>
      {isCombo ? (
        <div className="muted combo-note">
          <div>
            组合按整组净价触发。平仓会发一张腿方向全部反转的 BAG 限价单,价按各腿当前买卖价算的立刻成交价(组合不发市价单:每条腿各吃一次价差)。托管到券商:挂一张按标的目标价算出的限价止盈单,止损类目标由软件盯,触发时把这张单改到立刻成交的价。
          </div>
          <div>
            {isPaper ? (
              <>
                <span className="tag paper">模拟账户</span> 组合追踪与到价自动平仓已完全开放,不需要任何额外开关——就在这里测。
              </>
            ) : (
              <>
                <span className="tag live">实盘账户</span> 组合平仓单还没在实盘核对过:到价会算、会提醒,但不会发单,除非在配置里打开
                policies.allow_combo_live。建议先在模拟账户跑通。
              </>
            )}
          </div>
        </div>
      ) : null}
      {/* 设了目标价却算不出价钱,就不给点:那一步下去要么被引擎拒、要么是盲签一张真单 */}
      <Button
        type="primary"
        size="small"
        loading={saving}
        disabled={hasSpotTarget && !priced}
        title={hasSpotTarget && !priced ? '这个点位的价格还没算出来' : undefined}
        onClick={() => void start()}
      >
        开始追踪
      </Button>
    </div>
  );
}

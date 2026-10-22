# Qt 重写 · TS → C++ 覆盖表

由 `native/tools/port_status.py` 生成,不手改。"已搬"= C++ 有对应文件(头注释点名了这个 TS 文件),不等于已验收。

行数:已搬 35648 / 应搬 54103(66%)。

| TS 文件 | 行数 | 状态 | C++ |
|---|---:|---|---|
| accountFeeds.ts | 27 | 待搬 |  |
| alerts.ts | 461 | 已搬 | analysis/alerts |
| anomaly.ts | 730 | 已搬 | analysis/anomaly |
| assignmentRisk.ts | 117 | 已搬 | analysis/assignment_risk |
| autoMid.ts | 51 | 待搬 |  |
| backtest.ts | 982 | 已搬 | analysis/backtest |
| backtestLab.ts | 446 | 已搬 | analysis/backtest_lab |
| broker.ts | 2319 | 待搬 |  |
| cli.ts | 365 | 待搬 |  |
| combos.ts | 242 | 已搬 | domain/positions |
| config.ts | 1060 | 已搬 | contract/config_types, domain/config, util/exit_codes |
| contract/alerts.ts | 188 | 已搬 | analysis/alerts |
| contract/backtest.ts | 345 | 已搬 | analysis/backtest |
| contract/book.ts | 57 | 待搬 |  |
| contract/connection.ts | 215 | 待搬 |  |
| contract/events.ts | 147 | 待搬 |  |
| contract/follow.ts | 187 | 已搬 | contract/config_types |
| contract/ideas.ts | 286 | 待搬 |  |
| contract/index.ts | 280 | 跳过 | 契约登记表:C++ 侧在 transport 的方法表里体现 |
| contract/instruction.ts | 114 | 待搬 |  |
| contract/intel.ts | 151 | 待搬 |  |
| contract/llm.ts | 102 | 已搬 | contract/config_types |
| contract/macro.ts | 53 | 已搬 | analysis/macro |
| contract/options.ts | 476 | 待搬 |  |
| contract/performance.ts | 340 | 已搬 | analysis/performance |
| contract/pool.ts | 22 | 待搬 |  |
| contract/positions.ts | 57 | 已搬 | domain/positions |
| contract/priceaction.ts | 341 | 已搬 | analysis/priceaction |
| contract/quality.ts | 177 | 待搬 |  |
| contract/records.ts | 163 | 待搬 |  |
| contract/review.ts | 449 | 待搬 |  |
| contract/schema/alerts.ts | 37 | 已搬 | analysis/alerts |
| contract/schema/backtest.ts | 38 | 已搬 | analysis/backtest |
| contract/schema/connection.ts | 41 | 待搬 |  |
| contract/schema/events.ts | 27 | 待搬 |  |
| contract/schema/follow.ts | 9 | 已搬 | parsing/follow |
| contract/schema/ideas.ts | 70 | 待搬 |  |
| contract/schema/index.ts | 188 | 待搬 |  |
| contract/schema/instruction.ts | 23 | 待搬 |  |
| contract/schema/intel.ts | 21 | 待搬 |  |
| contract/schema/kit.ts | 64 | 待搬 |  |
| contract/schema/llm.ts | 24 | 已搬 | parsing/llm |
| contract/schema/market.ts | 18 | 已搬 | analysis/market |
| contract/schema/options.ts | 44 | 待搬 |  |
| contract/schema/pool.ts | 12 | 待搬 |  |
| contract/schema/priceaction.ts | 14 | 已搬 | analysis/priceaction |
| contract/schema/quality.ts | 32 | 待搬 |  |
| contract/schema/records.ts | 16 | 待搬 |  |
| contract/schema/review.ts | 34 | 待搬 |  |
| contract/schema/screener.ts | 39 | 已搬 | analysis/screener |
| contract/schema/sectors.ts | 34 | 待搬 |  |
| contract/schema/settings.ts | 24 | 待搬 |  |
| contract/schema/system.ts | 12 | 待搬 |  |
| contract/schema/tracker.ts | 99 | 已搬 | orchestrate/tracker |
| contract/screener.ts | 329 | 已搬 | analysis/screener |
| contract/sectors.ts | 86 | 待搬 |  |
| contract/settings.ts | 206 | 已搬 | contract/settings |
| contract/signals.ts | 93 | 待搬 |  |
| contract/system.ts | 147 | 已搬 | transport/handlers/system |
| contract/tracker.ts | 272 | 已搬 | orchestrate/tracker |
| contract/trackerloop.ts | 159 | 待搬 |  |
| crossMarket.ts | 144 | 已搬 | analysis/cross_market |
| discordGateway.ts | 352 | 待搬 |  |
| econCalendar.ts | 423 | 已搬 | analysis/econ_calendar |
| embeddings.ts | 88 | 已搬 | parsing/embeddings, parsing/whatwg_url |
| engine.ts | 1659 | 待搬 |  |
| engine/accountGuard.ts | 173 | 待搬 |  |
| engine/callbacks.ts | 359 | 待搬 |  |
| engine/clock.ts | 21 | 待搬 |  |
| engine/closing.ts | 85 | 待搬 |  |
| engine/exits.ts | 210 | 待搬 |  |
| engine/heartbeat.ts | 61 | 待搬 |  |
| engine/hosted.ts | 760 | 待搬 |  |
| engine/localShorthand.ts | 86 | 待搬 |  |
| engine/reconcile.ts | 349 | 待搬 |  |
| engine/sessionEm.ts | 32 | 已搬 | analysis/playbook |
| engine/sessionHours.ts | 145 | 待搬 |  |
| engine/spotStop.ts | 66 | 待搬 |  |
| engine/wakeGuard.ts | 285 | 待搬 |  |
| execQuality.ts | 166 | 已搬 | analysis/exec_quality |
| fillsCsv.ts | 154 | 已搬 | analysis/fills_csv |
| flyCalibration.ts | 596 | 已搬 | analysis/fly_model |
| flyExitSweep.ts | 511 | 待搬 |  |
| flyExitSweepReport.ts | 252 | 待搬 |  |
| flyExitSweepSpec.ts | 480 | 待搬 |  |
| flyExitSweepStats.ts | 446 | 待搬 |  |
| flyIvModel.ts | 68 | 已搬 | analysis/fly_model |
| flyPlan.ts | 633 | 已搬 | analysis/fly_plan |
| flyexit.ts | 593 | 已搬 | analysis/flyexit |
| follow.ts | 463 | 已搬 | parsing/follow |
| followInbox.ts | 192 | 已搬 | domain/follow_inbox |
| followLog.ts | 173 | 已搬 | domain/log_stores |
| followReader.ts | 209 | 已搬 | domain/follow_reader |
| futu.ts | 468 | 跳过 | 富途不移植(用户 2026-10-20) |
| futuBridge.ts | 128 | 跳过 | 同上 |
| futuBroker.ts | 1739 | 跳过 | 同上 |
| heldStreams.ts | 191 | 待搬 |  |
| ibBars.ts | 370 | 待搬 |  |
| ibContracts.ts | 186 | 已搬 | execution/ib_contracts |
| ibExecHistory.ts | 238 | 已搬 | execution/ib_exec_history |
| ibLink.ts | 99 | 待搬 |  |
| ibSession.ts | 946 | 已搬 | execution/ib_api_next, execution/ib_session |
| ibTypes.ts | 227 | 已搬 | execution/ib_types.h |
| ibtrades.ts | 189 | 已搬 | analysis/ibtrades |
| ideaRetrieval.ts | 181 | 已搬 | analysis/idea_retrieval |
| ideaVectors.ts | 58 | 待搬 |  |
| importedTrades.ts | 227 | 已搬 | domain/imported_trades |
| inference.ts | 287 | 已搬 | analysis/inference |
| intelItems.ts | 163 | 已搬 | analysis/intel_items |
| ivPricing.ts | 120 | 已搬 | analysis/fly_model |
| ivSamples.ts | 134 | 已搬 | domain/day_logs |
| keychain.ts | 248 | 已搬 | util/keychain |
| keychainChild.ts | 50 | 已搬 | util/secrets (+ ibkr-engine --keychain-child) |
| killswitch.ts | 149 | 已搬 | util/killswitch |
| leaders.ts | 446 | 已搬 | analysis/leaders |
| llm.ts | 20 | 已搬 | parsing/llm |
| maTouch.ts | 333 | 已搬 | analysis/ma_touch |
| macro.ts | 331 | 已搬 | analysis/macro |
| market.ts | 112 | 已搬 | analysis/market |
| marketCalendar.ts | 155 | 已搬 | util/market_calendar |
| marketdata.ts | 74 | 已搬 | analysis/anomaly, analysis/priceaction, domain/positions |
| messageLog.ts | 156 | 待搬 |  |
| models.ts | 434 | 已搬 | domain/models, util/zod |
| notify.ts | 55 | 已搬 | util/notify |
| openRisk.ts | 125 | 已搬 | analysis/open_risk |
| optionMarks.ts | 215 | 待搬 |  |
| optionPositionsCsv.ts | 116 | 已搬 | analysis/option_positions_csv |
| optionTradesCsv.ts | 112 | 已搬 | analysis/option_trades_csv |
| optionwall.ts | 512 | 已搬 | analysis/optionwall |
| performance.ts | 1160 | 已搬 | analysis/performance |
| playbook.ts | 245 | 已搬 | analysis/playbook |
| playbookLog.ts | 134 | 已搬 | domain/day_logs |
| positions.ts | 56 | 已搬 | domain/positions |
| priceaction.ts | 1290 | 已搬 | analysis/priceaction |
| prompts.ts | 174 | 已搬 | parsing/prompts |
| protections.ts | 292 | 已搬 | util/protections |
| providers.ts | 658 | 已搬 | parsing/providers, parsing/sdk_http, parsing/whatwg_url |
| py.ts | 137 | 已搬 | util/py |
| pyjson.ts | 237 | 已搬 | util/pyjson |
| qualifyGate.ts | 85 | 待搬 |  |
| research.ts | 145 | 已搬 | analysis/research |
| riskBudget.ts | 39 | 已搬 | util/risk_budget |
| riskQueries.ts | 196 | 已搬 | domain/risk_queries |
| rpc.ts | 15 | 跳过 | 只是转出的壳 |
| rpc/context.ts | 116 | 待搬 |  |
| rpc/contractMethods.ts | 32 | 待搬 |  |
| rpc/handlers/alerts.ts | 86 | 已搬 | analysis/alerts |
| rpc/handlers/backtest.ts | 201 | 已搬 | analysis/backtest |
| rpc/handlers/connection.ts | 300 | 待搬 |  |
| rpc/handlers/events.ts | 41 | 待搬 |  |
| rpc/handlers/follow.ts | 41 | 已搬 | parsing/follow |
| rpc/handlers/ideas.ts | 397 | 待搬 |  |
| rpc/handlers/intel.ts | 22 | 待搬 |  |
| rpc/handlers/market.ts | 255 | 已搬 | analysis/market |
| rpc/handlers/quality.ts | 121 | 待搬 |  |
| rpc/handlers/review.ts | 389 | 待搬 |  |
| rpc/handlers/screener.ts | 213 | 已搬 | analysis/screener |
| rpc/handlers/sectors.ts | 216 | 待搬 |  |
| rpc/handlers/settings.ts | 238 | 待搬 |  |
| rpc/handlers/system.ts | 84 | 已搬 | transport/handlers/system |
| rpc/handlers/tracker.ts | 660 | 已搬 | orchestrate/tracker |
| rpc/handlers/trading.ts | 195 | 待搬 |  |
| rpc/params.ts | 177 | 待搬 |  |
| rpc/perfLog.ts | 102 | 待搬 |  |
| rpc/server.ts | 555 | 已搬 | transport/rpc_server |
| rpcError.ts | 19 | 已搬 | util/rpc_error.h |
| screener.ts | 566 | 已搬 | analysis/screener |
| secrets.ts | 261 | 已搬 | util/secrets |
| services/alerts.ts | 505 | 已搬 | analysis/alerts |
| services/anomaly.ts | 490 | 已搬 | analysis/anomaly |
| services/assignmentWatch.ts | 111 | 待搬 |  |
| services/brokerLink.ts | 294 | 待搬 |  |
| services/events.ts | 270 | 待搬 |  |
| services/fillSync.ts | 252 | 待搬 |  |
| services/flyPlanner.ts | 185 | 待搬 |  |
| services/follow.ts | 898 | 已搬 | parsing/follow |
| services/host.ts | 71 | 待搬 |  |
| services/ideaSemantic.ts | 165 | 待搬 |  |
| services/intel.ts | 316 | 待搬 |  |
| services/ivRecorder.ts | 266 | 待搬 |  |
| services/marketData.ts | 223 | 待搬 |  |
| services/playbook.ts | 520 | 已搬 | analysis/playbook |
| services/pool.ts | 175 | 待搬 |  |
| services/similarContext.ts | 145 | 待搬 |  |
| services/stockTrips.ts | 47 | 待搬 |  |
| services/tradeHistory.ts | 116 | 待搬 |  |
| sessionEm.ts | 54 | 已搬 | analysis/playbook |
| shorthand.ts | 576 | 已搬 | parsing/shorthand |
| signalLog.ts | 124 | 已搬 | domain/log_stores |
| signalOutcomes.ts | 547 | 已搬 | analysis/signal_outcomes |
| stockreview.ts | 679 | 已搬 | analysis/stockreview |
| store.ts | 1430 | 已搬 | domain/store |
| storeSafety.ts | 209 | 已搬 | domain/store_safety, util/exit_codes |
| symbolMentions.ts | 171 | 已搬 | analysis/symbol_mentions |
| tracker.ts | 1367 | 已搬 | orchestrate/tracker |
| trackerDrawdown.ts | 80 | 已搬 | analysis/tracker_rules |
| trackerExits.ts | 267 | 已搬 | analysis/tracker_rules |
| trackerSpotStop.ts | 77 | 已搬 | analysis/tracker_rules |
| tradeOutcomes.ts | 350 | 已搬 | analysis/trade_outcomes |
| tradeSimilar.ts | 366 | 已搬 | analysis/trade_similar |
| tradereview.ts | 621 | 已搬 | analysis/tradereview |
| tws.ts | 524 | 已搬 | execution/tws_detect |
| types/futu-api.d.ts | 2 | 跳过 | 同上 |
| tz.ts | 163 | 已搬 | util/tz |
| validator.ts | 939 | 已搬 | parsing/validator |

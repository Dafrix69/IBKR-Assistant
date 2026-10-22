# review 组:交易复盘、券商成交合成、股票复盘、导出文件导入、交易结果与相似交易
target_sources(ibkr_analysis PRIVATE
    analysis/tradereview.h analysis/tradereview.cpp
    analysis/ibtrades.h analysis/ibtrades.cpp
    analysis/stockreview.h analysis/stockreview.cpp
    analysis/fills_csv.h analysis/fills_csv.cpp
    analysis/option_trades_csv.h analysis/option_trades_csv.cpp
    analysis/option_positions_csv.h analysis/option_positions_csv.cpp
    analysis/trade_outcomes.h analysis/trade_outcomes.cpp
    analysis/trade_similar.h analysis/trade_similar.cpp
)

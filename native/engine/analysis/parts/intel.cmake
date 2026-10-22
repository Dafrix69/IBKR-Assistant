# intel 组:情报、重要事件、期权墙、在手风险(analysis 层逐句搬)
target_sources(ibkr_util PRIVATE util/intel_text.h)
target_sources(ibkr_analysis PRIVATE
    analysis/symbol_mentions.h analysis/symbol_mentions.cpp
    analysis/econ_calendar.h analysis/econ_calendar.cpp
    analysis/cross_market.h analysis/cross_market.cpp
    analysis/intel_items.h analysis/intel_items.cpp
    analysis/idea_retrieval.h analysis/idea_retrieval.cpp
    analysis/open_risk.h analysis/open_risk.cpp
    analysis/assignment_risk.h analysis/assignment_risk.cpp
    analysis/optionwall.h analysis/optionwall.cpp)

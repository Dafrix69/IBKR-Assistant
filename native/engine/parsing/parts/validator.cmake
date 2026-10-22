# validator 组:软件层硬校验(validator.ts,parsing 层)与绩效体检的计算(performance.ts,analysis 层)
target_sources(ibkr_parsing PRIVATE
    parsing/validator.h parsing/validator.cpp
)
target_sources(ibkr_analysis PRIVATE
    analysis/performance.h analysis/performance.cpp
)

// 引擎用专门的退出码说"别重启我,去问用户"。两头(界面与引擎)各认这一份,数同 TS 版:
// engine-ts/src/config.ts 的 EXIT_CONFIG、storeSafety.ts 的 EXIT_STORE,desktop/config-guard.js / store-guard.js。
#pragma once

namespace ibkr::util {

/// 配置读不进来(EX_CONFIG):重启一万次也是同一个错
inline constexpr int kExitConfig = 78;
/// 交易库打不开(EX_IOERR):同样不是重启能解决的
inline constexpr int kExitStore = 74;

}  // namespace ibkr::util

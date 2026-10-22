// rpc/handlers/settings.ts:llm.* / settings.* / keychain.set / data.*——大模型接入、设置、导出与备份。**普通模块**(settings.patch 能改限额与开关,
// 但「放宽限额」的确认由桌面端 confirm-grants 管,引擎这边只做结构与范围校验)。
//
// llm.test 直接 buildParser(不走 parserFactory):测试经 buildParserHook 换成假的;真的会发网络请求,所以对拍只覆盖发请求之前的那几道检查。
// 与 TS 不同、有意的:llm.test 失败时 TS 的 `${exc.constructor.name}: ${msg}` 在 C++ 里认不出 JS 的类名,LLMError / KeychainError 之外的一律「Error: <话>」。
#pragma once

#include "parsing/providers.h"
#include "transport/context.h"
#include "transport/handlers/handler_ports.h"

namespace ibkr::rpc {

class SettingsHandlers : public HandlerBase {
public:
    SettingsHandlers(RpcContext& ctx, Handlers1Ports& ports) : HandlerBase(ctx), ports_(ports) {}

    MethodTable methods() override;

    /// buildParser(cfg, explicitKey);测试换掉
    std::function<std::shared_ptr<parsing::providers::Parser>(const contract::LLMConfig&, const std::optional<QString>&)> buildParserHook;

private:
    using OJson = util::OJson;
    template <class T = void>
    using Task = util::Task<T>;

    Task<OJson> llmCatalog();
    Task<OJson> llmPatch(OJson params);
    Task<OJson> llmTest(OJson params);
    OJson settingsGet();
    OJson settingsPatch(const OJson& params);
    Task<OJson> keychainSet(OJson params);
    OJson dataExport(const OJson& params);
    OJson dataBackups();
    OJson dataBackup();

    Handlers1Ports& ports_;
};

}  // namespace ibkr::rpc

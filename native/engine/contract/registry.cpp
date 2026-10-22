#include "contract/registry.h"

#include "contract/schemas.h"
#include "util/error.h"

#include <algorithm>

using namespace Qt::StringLiterals;

namespace ibkr::contract {

const QStringList& sensitiveMethods() {
    static const QStringList list{
        u"broker.connect"_s, u"broker.select"_s,    u"follow.set_token"_s,  u"futu.launch"_s,       u"futu.set_password"_s,
        u"futu.unlock"_s,    u"instruction.submit"_s, u"keychain.set"_s,    u"llm.patch"_s,
        u"settings.patch"_s, u"tracker.add"_s,      u"tracker.close_now"_s, u"tracker.update"_s,    u"tws.launch"_s,
    };
    return list;
}

const std::vector<MethodSpec>& methodSpecs() {
    static const std::vector<MethodSpec> specs = [] {
        std::vector<MethodSpec> out;
        for (const NamedSchema& n : paramsSchemas()) {
            const auto* object = dynamic_cast<const ObjectSchema*>(n.schema.get());
            out.push_back({n.method, n.schema, object && object->isStrict(), sensitiveMethods().contains(n.method)});
        }
        return out;
    }();
    return specs;
}

const MethodSpec* findMethod(const QString& name) {
    for (const MethodSpec& s : methodSpecs())
        if (s.name == name) return &s;
    return nullptr;
}

QStringList contractMethodNames() {
    QStringList names;
    for (const MethodSpec& s : methodSpecs()) names << s.name;
    std::sort(names.begin(), names.end());
    return names;
}

zod::SafeParse parseParams(const QString& method, const util::OJson* raw) {
    const MethodSpec* spec = findMethod(method);
    if (!spec) throw util::JsError(u"Cannot read properties of undefined (reading 'safeParse')"_s);
    return zod::safeParse(*spec->schema, raw);
}

}  // namespace ibkr::contract

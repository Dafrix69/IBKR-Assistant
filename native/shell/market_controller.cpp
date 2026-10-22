#include "shell/market_controller.h"

#include "shell/bridge.h"
#include "shell/chart_source.h"
#include "shell/jsvalue.h"
#include "shell/market_rules.h"
#include "shell/pa_spec.h"
#include "shell/status_store.h"

#include <QJsonDocument>
#include <QPointer>
#include <QSettings>

namespace ibkr::shell {

using namespace Qt::StringLiterals;

MarketController::MarketController(Bridge* bridge, StatusStore* status, QString settingsPath, QObject* parent)
    : QObject(parent), bridge_(bridge), status_(status), chart_(new ChartSource(this)), settingsPath_(std::move(settingsPath)) {
    // 已连券商时 20 秒一轮(没连的那几轮什么也不做,同原版 setInterval 里判断 connected)
    connect(&paTimer_, &QTimer::timeout, this, [this] {
        if (connected()) fetchPa(false);
    });
    connect(&bookTimer_, &QTimer::timeout, this, [this] {
        if (connected()) refreshAllBooks();
    });
    reset();
}

QObject* MarketController::chart() const { return chart_; }

bool MarketController::connected() const { return status_ && jsTruthy(status_->status().value("broker_connected"_L1)); }

void MarketController::reset() {
    const QSettings s(settingsPath_, QSettings::IniFormat);
    symbol_ = s.value(u"market/symbol"_s).toString();
    timeframe_ = s.value(u"market/timeframe"_s).toString();
    if (timeframe_.isEmpty()) timeframe_ = u"5m"_s;
    rth_ = s.value(u"market/rth"_s).toString() == u"1";
    spec_ = {symbol_, timeframe_, rth_};
    books_ = market::readSymbols(s.value(u"market/books"_s).toString());
    timeframes_ = {};
    data_ = QJsonValue::Null;
    comment_ = QJsonValue::Null;
    error_.clear();
    loading_ = commenting_ = inFlight_ = refreshing_ = false;
    bookData_ = {};
    bookLoading_.clear();
    refreshQueue_.clear();
    focused_.clear();
    chart_->setSpec(pa::spec(QJsonValue::Null));
    rebuild();
}

void MarketController::setVisible(bool on) {
    if (on == visible_) return;
    visible_ = on;
    ++generation_;
    if (!on) {
        paTimer_.stop();
        bookTimer_.stop();
        reset();
        return;
    }
    reset();
    paTimer_.start(refreshMs);
    bookTimer_.start(refreshMs);
    const int gen = generation_;
    QPointer<MarketController> self(this);
    bridge_->rpc(this, u"pa.timeframes"_s, QJsonObject{}, [self, gen](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        if (!r.ok) {
            if (self->status_) self->status_->showError(u"K 线周期表读取失败:"_s + r.error);
            return;
        }
        self->timeframes_ = r.result.toObject().value("timeframes"_L1).toArray();
        self->rebuild();
    });
}

void MarketController::setSymbolText(const QString& text) {
    if (text == symbol_) return;
    symbol_ = text;
    rebuild();
}

void MarketController::analyze() { run(std::nullopt, std::nullopt, std::nullopt); }

void MarketController::setTimeframe(const QString& key) {
    timeframe_ = key;
    run(std::nullopt, key, std::nullopt);
}

void MarketController::setRth(bool on) {
    rth_ = on;
    run(std::nullopt, std::nullopt, on);
}

void MarketController::pick(const QString& symbol) {
    run(symbol, std::nullopt, std::nullopt);
    emit scrollTop();
}

// 手动触发:先把输入同步进 spec,再走同一条取数路径
void MarketController::run(std::optional<QString> symbol, std::optional<QString> timeframe, std::optional<bool> rth) {
    const QString sym = jsTrim(symbol.value_or(symbol_)).toUpper();
    if (sym.isEmpty()) {
        if (status_) status_->showInfo(u"先填一个标的代码"_s);
        return;
    }
    const QString tf = timeframe.value_or(timeframe_);
    const bool r = rth.value_or(rth_);
    symbol_ = sym;
    spec_ = {sym, tf, r};
    QSettings s(settingsPath_, QSettings::IniFormat);
    s.setValue(u"market/symbol"_s, sym);
    s.setValue(u"market/timeframe"_s, tf);
    s.setValue(u"market/rth"_s, r ? u"1"_s : u"0"_s);
    comment_ = QJsonValue::Null;
    rebuild();
    fetchPa(true);
}

void MarketController::fetchPa(bool force) {
    // 上一轮还没回来就跳过这一轮:引擎侧是串行的,叠加请求只会在管道里排队
    if (spec_.symbol.isEmpty() || inFlight_) return;
    inFlight_ = true;
    loading_ = true;
    rebuild();
    const int gen = generation_;
    QPointer<MarketController> self(this);
    bridge_->rpc(this, u"pa.analyze"_s, QJsonObject{{u"symbol"_s, spec_.symbol}, {u"timeframe"_s, spec_.timeframe}, {u"rth"_s, spec_.rth}, {u"force"_s, force}},
                 [self, gen](const EngineReply& r) {
                     if (!self || gen != self->generation_) return;
                     self->inFlight_ = false;
                     self->loading_ = false;
                     if (r.ok) {
                         const QJsonObject next = r.result.toObject();
                         // 换了标的或周期就丢掉上一次的 AI 解读,免得张冠李戴
                         const QJsonObject prev = self->data_.toObject();
                         if (self->data_.isNull() || prev.value("symbol"_L1) != next.value("symbol"_L1) || prev.value("timeframe"_L1) != next.value("timeframe"_L1))
                             self->comment_ = QJsonValue::Null;
                         self->data_ = next;
                         self->error_.clear();
                     } else {
                         self->data_ = QJsonValue::Null;
                         self->comment_ = QJsonValue::Null;
                         self->error_ = r.error;
                     }
                     self->chart_->setSpec(pa::spec(self->data_));
                     // 图出来了就跟着读它的盘口
                     self->focusBook(jsTruthy(self->data_[u"symbol"_s]) ? jsString(self->data_[u"symbol"_s]) : QString());
                     self->rebuild();
                 });
}

void MarketController::comment() {
    if (spec_.symbol.isEmpty()) return;
    commenting_ = true;
    rebuild();
    const int gen = generation_;
    QPointer<MarketController> self(this);
    bridge_->rpc(this, u"pa.comment"_s, QJsonObject{{u"symbol"_s, spec_.symbol}, {u"timeframe"_s, spec_.timeframe}, {u"rth"_s, spec_.rth}, {u"force"_s, false}},
                 [self, gen](const EngineReply& r) {
                     if (!self || gen != self->generation_) return;
                     self->commenting_ = false;
                     if (r.ok) {
                         const QJsonObject res = r.result.toObject();
                         self->data_ = res.value("analysis"_L1);
                         QJsonObject c = res.value("comment"_L1).toObject();
                         c[u"model"_s] = res.value("model"_L1);
                         self->comment_ = c;
                         self->chart_->setSpec(pa::spec(self->data_));
                         self->focusBook(jsTruthy(self->data_[u"symbol"_s]) ? jsString(self->data_[u"symbol"_s]) : QString());
                     } else if (self->status_) {
                         // 前缀只出现一次(errorWithPrefix)
                         self->status_->showError(r.error.startsWith(u"AI 解读失败:"_s) ? r.error : u"AI 解读失败:"_s + r.error);
                     }
                     self->rebuild();
                 });
}

// ---- 盘口 ----------------------------------------------------------------------------------

void MarketController::loadBook(const QString& symbol) {
    if (symbol.isEmpty()) return;
    bookLoading_.insert(symbol);
    rebuild();
    const int gen = generation_;
    QPointer<MarketController> self(this);
    bridge_->rpc(this, u"book.snapshot"_s, QJsonObject{{u"symbol"_s, symbol}}, [self, gen, symbol](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        self->bookData_[symbol] = r.ok ? r.result : QJsonValue(QJsonObject{{u"error"_s, r.error}});
        self->bookLoading_.remove(symbol);
        self->rebuild();
    });
}

// 逐个刷:十几个盘口同时压给引擎只会在读通道里排队;正在看的那个排最前
void MarketController::refreshAllBooks() {
    QStringList all;
    for (const QString& s : QStringList{focused_} + books_)
        if (!s.isEmpty() && !all.contains(s)) all << s;
    // 上一轮还在逐只取:并进同一条队列(不另起一条,两条交错只会在读通道里排队)
    for (const QString& s : all)
        if (!refreshQueue_.contains(s)) refreshQueue_ << s;
    if (!refreshing_) pumpBooks();
}

void MarketController::pumpBooks() {
    if (refreshQueue_.isEmpty()) {
        refreshing_ = false;
        return;
    }
    refreshing_ = true;
    const QString symbol = refreshQueue_.takeFirst();
    bookLoading_.insert(symbol);
    rebuild();
    const int gen = generation_;
    QPointer<MarketController> self(this);
    bridge_->rpc(this, u"book.snapshot"_s, QJsonObject{{u"symbol"_s, symbol}}, [self, gen, symbol](const EngineReply& r) {
        if (!self || gen != self->generation_) return;
        self->bookData_[symbol] = r.ok ? r.result : QJsonValue(QJsonObject{{u"error"_s, r.error}});
        self->bookLoading_.remove(symbol);
        self->rebuild();
        self->pumpBooks();
    });
}

void MarketController::focusBook(const QString& symbol) {
    if (focused_ == symbol) return;
    focused_ = symbol;
    if (!symbol.isEmpty()) loadBook(symbol);
}

void MarketController::persistBooks() {
    QSettings(settingsPath_, QSettings::IniFormat).setValue(u"market/books"_s, QString::fromUtf8(QJsonDocument(QJsonArray::fromStringList(books_)).toJson(QJsonDocument::Compact)));
}

bool MarketController::addBook(const QString& raw) {
    const QString symbol = jsTrim(raw).toUpper();
    if (symbol.isEmpty()) return false;
    if (books_.contains(symbol)) return true;
    if (books_.size() >= market::kMaxBooks) {
        if (status_) status_->showInfo(u"盘口最多同时关注 12 个标的"_s);
        return false;
    }
    books_ << symbol;
    persistBooks();
    // 上面正在看的就是它:快照已经有了,不用再取一遍
    const QJsonValue cell = bookData_.value(symbol);
    if (!jsTruthy(cell) || cell.toObject().contains(u"error"_s)) loadBook(symbol);
    rebuild();
    return true;
}

void MarketController::removeBook(const QString& symbol) {
    books_.removeAll(symbol);
    persistBooks();
    // 上面那张盘口还在用这份快照
    if (symbol != focused_) bookData_.remove(symbol);
    rebuild();
}

void MarketController::rebuild() {
    market::PageInput in;
    in.symbol = symbol_;
    in.timeframe = timeframe_;
    in.rth = rth_;
    in.timeframes = timeframes_;
    in.data = data_;
    in.error = error_;
    in.loading = loading_;
    in.comment = comment_;
    in.commenting = commenting_;
    in.books = books_;
    in.bookData = bookData_;
    in.bookLoading = bookLoading_;
    page_ = market::pageModel(in);
    emit pageChanged();
}

}  // namespace ibkr::shell

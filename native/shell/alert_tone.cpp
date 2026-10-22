#include "shell/alert_tone.h"

#include <QtEndian>

#include <cmath>
#include <numbers>

namespace ibkr::shell::tone {

namespace {

constexpr double kNoteGap = 0.24;
constexpr double kAttack = 0.02;
constexpr double kHold = 0.1;
constexpr double kRelease = 0.22;
constexpr double kStop = 0.23;
constexpr double kFloor = 0.0001;

/// Web Audio 的 exponentialRampToValueAtTime:v0 · (v1 / v0)^((t − t0) / (t1 − t0))
double ramp(double v0, double v1, double t0, double t1, double t) { return v0 * std::pow(v1 / v0, (t - t0) / (t1 - t0)); }

double envelope(double t) {
    if (t < 0 || t >= kStop) return 0;
    if (t < kAttack) return ramp(kFloor, kPeak, 0, kAttack, t);
    if (t < kHold) return kPeak;
    if (t < kRelease) return ramp(kPeak, kFloor, kHold, kRelease, t);
    return kFloor;
}

/// 三角波,相位 0 从 0 起往上(同 OscillatorNode 的 triangle)
double triangle(double phase) {
    const double x = phase - std::floor(phase);
    return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
}

}  // namespace

QList<double> notesFor(const QString& direction) {
    if (direction == QLatin1StringView("up")) return {587.33, 880.0};
    if (direction == QLatin1StringView("down")) return {880.0, 587.33};
    return {739.99, 739.99};
}

QList<qint16> samples(const QString& direction) {
    const QList<double> notes = notesFor(direction);
    const int total = int(std::ceil((kNoteGap * (notes.size() - 1) + kStop) * kSampleRate));
    QList<qint16> out(total, 0);
    for (qsizetype n = 0; n < notes.size(); ++n) {
        const double start = n * kNoteGap;
        for (int i = int(start * kSampleRate); i < total; ++i) {
            const double t = double(i) / kSampleRate - start;
            if (t >= kStop) break;
            const double v = envelope(t) * triangle(notes[n] * t);
            const int mixed = out[i] + int(std::lround(v * 32767));
            out[i] = qint16(std::clamp(mixed, -32768, 32767));
        }
    }
    return out;
}

QByteArray wav(const QString& direction) {
    const QList<qint16> pcm = samples(direction);
    const quint32 dataBytes = quint32(pcm.size() * 2);
    QByteArray out;
    out.reserve(44 + int(dataBytes));
    const auto u32 = [&out](quint32 v) { char b[4]; qToLittleEndian(v, b); out.append(b, 4); };
    const auto u16 = [&out](quint16 v) { char b[2]; qToLittleEndian(v, b); out.append(b, 2); };
    out.append("RIFF", 4); u32(36 + dataBytes); out.append("WAVE", 4);
    out.append("fmt ", 4); u32(16); u16(1); u16(1); u32(kSampleRate); u32(kSampleRate * 2); u16(2); u16(16);
    out.append("data", 4); u32(dataBytes);
    for (qint16 s : pcm) u16(quint16(s));
    return out;
}

}  // namespace ibkr::shell::tone

// 给 C++ 的 TWS 编解码(native/engine/execution/tws/codec.*)出一份对拍用的期望值:
// 同样的字节,TS 引擎此刻真的在用的那个库(@stoqey/ib,MIT)发出去的是什么、读出来的是什么。
//
//   node native/tests/fixtures/gen_stoqey_v193.mjs
//   ENGINE_TS=/tmp/claude-501/ibkr-perf/engine-ts node native/tests/fixtures/gen_stoqey_v193.mjs   # 库从别处的 node_modules 读
//
// 输出 native/tests/fixtures/stoqey-v193.json。只能重生成、不手改(同黄金基线):C++ 那边红了,先看是不是库升级了。
// 报文全是合成的:账号是 U1234567 / DU7654321 这种样子的假号。真机上录下来的报文含真实账号,不进仓库。
//
// 谈下来的接口版本钉在 193:平时那条连接(ibSession.ts)握手报的上限就是它,各条消息的字段次序以这一版为准。
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const engineDir = process.env.ENGINE_TS ? path.resolve(process.env.ENGINE_TS) : path.join(repo, "engine-ts");
const require = createRequire(path.join(engineDir, "package.json"));
const { Decoder } = require("@stoqey/ib/dist/core/io/decoder.js");
const { Encoder } = require("@stoqey/ib/dist/core/io/encoder.js");
const libVersion = require("@stoqey/ib/package.json").version;

const SERVER_VERSION = 193;
const MIN_VERSION_V100 = 100;

// ---- 发出去的字节:照 socket.js 的 send() 拼(展平、布尔变 0/1、\0 连起来、长度 = 字节数 + 1、末尾补一个 0) ----
function flattenDeep(arr, out = []) {
  for (const v of arr) Array.isArray(v) ? flattenDeep(v, out) : out.push(v);
  return out;
}
function sendBytes(tokens) {
  tokens = flattenDeep(tokens).map((v) => (v === true || v === false ? (v ? 1 : 0) : v));
  if (tokens[0] === "API\0") {
    // 握手那一条是特例:'API\0' + 4 字节长度 + 版本串,不带长度前缀
    return Buffer.concat([Buffer.from(tokens[0], "utf-8"), Buffer.from(tokens.slice(1, 5)), Buffer.from(tokens[5], "utf-8")]);
  }
  const data = Buffer.from(tokens.join("\0"), "utf-8");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length + 1, 0);
  return Buffer.concat([size, data, Buffer.from([0])]);
}
function be32(n) {
  return [0xff & (n >> 24), 0xff & (n >> 16), 0xff & (n >> 8), 0xff & n];
}
function handshake(min, max) {
  const config = "v" + (min < max ? `${min}..${max}` : `${min}`);
  return sendBytes(["API\0", ...be32(config.length), config]);
}
function encoded(call) {
  let tokens = null;
  const encoder = new Encoder({
    serverVersion: SERVER_VERSION,
    sendMsg: (t) => { tokens = t; },
    emitError: (msg) => { throw new Error(msg); },
  });
  call(encoder);
  return sendBytes(tokens);
}

const out = [
  { name: "handshake v100..193", hex: handshake(MIN_VERSION_V100, SERVER_VERSION).toString("hex") },
  { name: "handshake v100..200", hex: handshake(MIN_VERSION_V100, 200).toString("hex") },
  // 报到:socket.js 的 startAPI(),版本 2、client id、可选能力(空串)
  { name: "startApi 0", hex: sendBytes([71, 2, 0, ""]).toString("hex") },
  { name: "startApi 9012", hex: sendBytes([71, 2, 9012, ""]).toString("hex") },
  { name: "reqPositions", hex: encoded((e) => e.reqPositions()).toString("hex") },
  { name: "cancelPositions", hex: encoded((e) => e.cancelPositions()).toString("hex") },
  { name: "reqCurrentTime", hex: encoded((e) => e.reqCurrentTime()).toString("hex") },
];

// ---- 读进来的消息:每条单独喂给库的解码器,记下它发了哪些事件 ----
function decode(tokens) {
  const events = [];
  const errors = [];
  const infos = [];
  const flags = { underrun: false, leftover: false, unknown: false };
  const decoder = new Decoder({
    serverVersion: SERVER_VERSION,
    emitEvent: (name, ...args) => events.push({ name, args }),
    emitInfo: (message, code) => infos.push({ message, code }),
    emitError: (message, code, reqId, advanced) => {
      // 库自己的三种报错(读不够、读完还剩、不认识的消息号)只记成一个标志:它们的原话是库的,C++ 不照抄
      if (message.startsWith("Underrun error on")) flags.underrun = true;
      else if (message.startsWith("Decoding error on")) flags.leftover = true;
      else if (message.startsWith("No parser implementation found")) flags.unknown = true;
      else errors.push({ message, code, reqId, advanced });
    },
  });
  decoder.enqueueMessage(tokens);
  decoder.process();
  // 过一遍 JSON:undefined 的键去掉、数组里的 undefined 与 NaN / ±Infinity 变 null——C++ 那边按同样的规矩出 JSON
  return JSON.parse(JSON.stringify({ events, errors, infos, ...flags }));
}

const opt = ["920693462", "SPX", "OPT", "20261007", "7790.0", "P", "100", "", "USD", "SPXW  261007P07790000", "SPXW"];
const stk = ["265598", "AAPL", "STK", "", "0.0", "", "", "NASDAQ", "USD", "AAPL", "NMS"];
const inCases = [
  ["managed accounts", ["15", "1", "U1234567,DU7654321"]],
  ["next valid id", ["9", "1", "42"]],
  ["current time", ["49", "1", "1791500000"]],
  ["error: farm notice (id -1 = info)", ["4", "2", "-1", "2104", "Market data farm connection is OK:usfarm", ""]],
  ["error: for a request", ["4", "2", "7", "200", "No security definition has been found for the request", ""]],
  ["error: unicode escapes", ["4", "2", "3", "201", "\\u8ba2\\u5355\\u88ab\\u62d2 Order rejected", ""]],
  ["error: escape that builds another escape", ["4", "2", "3", "201", "a\\u005cu0041b", ""]],
  ["error: bad hex escape", ["4", "2", "3", "201", "x\\uzzzzy", ""]],
  ["error: advanced reject json", ["4", "2", "5", "201", "rejected", "{\"rejectReason\":\"\\u4f59\\u989d\\u4e0d\\u8db3\",\"code\":7}"]],
  ["error: version 1", ["4", "1", "an old style error"]],
  ["error: truncated (no advanced field)", ["4", "2", "-1", "2104", "farm ok"]],
  ["position: option", ["61", "3", "U1234567", ...opt, "2", "1234.56"]],
  ["position: stock (empty right and multiplier)", ["61", "3", "DU7654321", ...stk, "100", "187.25"]],
  ["position: short with thousands separator", ["61", "3", "U1234567", ...stk, "-1,000", "187.25"]],
  ["position: empty size", ["61", "3", "U1234567", ...stk, "", ""]],
  ["position: MAX_VALUE strike and cost", ["61", "3", "U1234567", "1", "X", "OPT", "", "1.7976931348623157E308", "C", "100", "", "USD", "X", "X", "1", "1.7976931348623157E308"]],
  ["position: infinities", ["61", "3", "U1234567", "1", "X", "STK", "", "-Infinity", "", "", "", "USD", "X", "X", "Infinity", "-Infinity"]],
  ["position: version 1 (no trading class, no cost)", ["61", "1", "U1234567", "1", "X", "STK", "", "0", "", "", "", "USD", "X", "5"]],
  ["position: version 2 (no cost)", ["61", "2", "U1234567", "1", "X", "STK", "", "0", "", "", "", "USD", "X", "X", "5"]],
  ["position: extra trailing fields", ["61", "3", "U1234567", ...opt, "2", "1234.56", "future", "fields"]],
  ["position: truncated", ["61", "3", "U1234567", "920693462", "SPX", "OPT"]],
  ["position: right spelled out", ["61", "3", "U1234567", "1", "X", "OPT", "20261007", "10", "CALL", "100", "", "USD", "X", "X", "1", "2"]],
  ["position: lenient numbers", ["61", "3", "U1234567", " 12abc", "X", "OPT", "", " 7.5x", "P", "1e2", "", "USD", "X", "X", "+.5e1", "-.25"]],
  ["position: unparseable numbers", ["61", "3", "U1234567", "abc", "X", "OPT", "", "x7", "P", "-", "", "USD", "X", "X", "e5", "."]],
  ["position: overflowing number", ["61", "3", "U1234567", "1", "X", "STK", "", "1e400", "", "", "", "USD", "X", "X", "-1e400", "1e-400"]],
  ["position end", ["62", "1"]],
  ["unknown message id", ["999", "1", "x"]],
  ["empty message id", ["", "1"]],
];
const inMessages = inCases.map(([name, tokens]) => ({ name, tokens, ...decode(tokens) }));

// 握手的回话不走解码器:socket.js 的 onServerVersion() 直接 parseInt 第一格、第二格原样当连接时刻
const serverVersionReply = { tokens: ["193", "20261018 10:05:01 Asia/Shanghai"] };
serverVersionReply.version = parseInt(serverVersionReply.tokens[0], 10);
serverVersionReply.connection_time = serverVersionReply.tokens[1];

// ---- JS 的 parseInt / parseFloat:库读数全靠这两个,C++ 的 jsnum 要和它们逐个一样 ----
const numberInputs = [
  "", "0", "42", "-7", "+3", " 12", "\t\n12", " 12", "﻿12", " " + "5", "\u0085" + "5", "12abc", "abc", "-", "+", "1.9", "-0",
  "0x1A", "1e3", "007", "9007199254740993", "123456789012345678901234567890",
  "1.5", ".5", "5.", "-.25", "+.5e1", "1e", "1e+", "1e-2", "1E308", "1.7976931348623157E308", "1e400", "-1e400", "1e-400",
  "Infinity", "-Infinity", "+Infinity", "infinity", "Inf", " 7.5x", "x7", ".", "e5", "1,000", "0.1", "123.456e-7", "4.9e-324",
];
const hexInputs = ["8ba2", "005c", "zzzz", "12zz", "0x1f", "FFFF", "-1", ""];
const enc = (v) => (Number.isNaN(v) ? "NaN" : v === Infinity ? "Infinity" : v === -Infinity ? "-Infinity" : Object.is(v, -0) ? "-0" : v);
const jsnum = {
  parseInt10: numberInputs.map((s) => [s, enc(parseInt(s, 10))]),
  parseInt16: hexInputs.map((s) => [s, enc(parseInt(s, 16))]),
  parseFloat: numberInputs.map((s) => [s, enc(parseFloat(s))]),
};

const fixture = {
  generator: "native/tests/fixtures/gen_stoqey_v193.mjs",
  library: `@stoqey/ib ${libVersion}`,
  server_version: SERVER_VERSION,
  server_version_reply: serverVersionReply,
  out,
  in: inMessages,
  jsnum,
};
const target = path.join(here, "stoqey-v193.json");
fs.writeFileSync(target, JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${path.relative(repo, target)}: ${out.length} out, ${inMessages.length} in, @stoqey/ib ${libVersion}`);

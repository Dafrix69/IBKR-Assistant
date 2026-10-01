/** 凭证子进程:`secrets.ts` 为每次要解密或写入的凭证起一个,引擎进程自己从不碰原生凭证库。
 *
 * 读一行请求(stdin)→ 交给 worker 线程做(`keychain.ts` 的同步调用,可能停在系统弹窗前)→ 答一行结果(stdout)→ 退出。
 * 主线程只盯着 stdin:引擎退出、被结束、或放弃这次请求,管道一断就 SIGKILL 自己,系统弹窗随之消失。
 * 用 SIGKILL 是因为 worker 正停在原生调用里时,正常退出要等它(process.exit 会 join 线程),弹窗就一直留在屏幕上。
 *
 * 结果只写给引擎,不写日志;`keychain.ts` 往 stderr 写的几句(迁移旧凭证)由引擎转进它自己的日志。
 */
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

import { runKeychainRequest } from "./keychain.js";
import type { KeychainReply } from "./keychain.js";

if (isMainThread) serve();
else parentPort?.postMessage(runKeychainRequest(workerData));

function serve(): void {
  let buffered = "";
  let started = false;
  let answered = false;
  const reply = (result: KeychainReply): void => {
    if (answered) return;
    answered = true;
    process.stdout.write(JSON.stringify(result) + "\n", () => process.exit(0));
  };
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    if (started) return;
    buffered += chunk;
    const nl = buffered.indexOf("\n");
    if (nl < 0) return;
    started = true;
    let request: unknown;
    try {
      request = JSON.parse(buffered.slice(0, nl));
    } catch {
      reply({ ok: false, error: "凭证请求不是合法 JSON" });
      return;
    }
    buffered = "";
    const worker = new Worker(new URL(import.meta.url), { workerData: request });
    worker.once("message", (result: KeychainReply) => reply(result));
    worker.once("error", (err) => reply({ ok: false, error: `凭证子进程出错:${err.message}` }));
    worker.once("exit", (code) => reply({ ok: false, error: `凭证子进程的线程没有给出结果就退出了(${code})` }));
  });
  // 引擎没了(或不要这个结果了):不等 worker,连同它正等着的系统弹窗一起结束
  process.stdin.on("end", () => {
    if (!answered) process.kill(process.pid, "SIGKILL");
  });
}

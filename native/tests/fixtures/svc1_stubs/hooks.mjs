// follow.ts 里有几处静态 import 的是还没搬的引擎模块 / 会碰外界的模块(engine.js 的 resolveFanoutAccounts、engine/localShorthand.js、engine/closing.js、
// discordGateway.js、followInbox.js、followReader.js、secrets.js):只在 services/follow.js 这一个文件里把它们换成垫片(同目录的 *.mjs),
// 垫片把调用转给 globalThis.__svc1(世界,按脚本答、记日志)。别的文件(包括这些模块的真身被别处 import)不受影响。
const SHIMS = new Map([
  ['../engine.js', 'engine.mjs'],
  ['../engine/localShorthand.js', 'localShorthand.mjs'],
  ['../engine/closing.js', 'closing.mjs'],
  ['../discordGateway.js', 'discordGateway.mjs'],
  ['../followInbox.js', 'followInbox.mjs'],
  ['../followReader.js', 'followReader.mjs'],
  ['../secrets.js', 'secrets.mjs'],
]);

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL && context.parentURL.endsWith('/dist/src/services/follow.js') && SHIMS.has(specifier)) {
    return { url: new URL(SHIMS.get(specifier), import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

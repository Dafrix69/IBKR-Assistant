// SSR 里 zustand 的钩子读的是 React 的"服务端快照"——建 store 时的初值,之后 setState 的都看不见。
// 对拍要按场景先灌数据再渲染,所以打包时把 'zustand' 换成这个:钩子直接读此刻的状态(SSR 不需要订阅)。只用于对拍。
import { createStore } from 'zustand/vanilla';

export function create(init) {
  const make = (initializer) => {
    const api = createStore(initializer);
    // 生成器要看 store 里每一步的变化(比如提交时 busy / working 先后怎么变):每个 store 都登记在这里
    (globalThis.__zustandStores ||= []).push(api);
    const hook = (selector = (s) => s) => selector(api.getState());
    Object.assign(hook, api);
    return hook;
  };
  return init ? make(init) : make;
}

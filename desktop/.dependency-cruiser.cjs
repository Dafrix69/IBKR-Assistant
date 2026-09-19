/** 界面的模块边界(renderer-react/src)。分层见 docs/features/ui.md:
 *    shell → pages → lib(共享组件与纯函数) → store(跨页状态) → bridge(preload 契约)
 *    ui / theme 是最底下的视觉层,不认识业务。
 */
const S = "renderer-react/src/";
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    { name: "pages-dont-import-pages", severity: "error",
      comment: "页面之间不互相引用;要共享的东西下沉到 lib/ 或 store/",
      from: { path: S + "pages/(?!index)" }, to: { path: S + "pages/" } },
    { name: "store-is-headless", severity: "error",
      comment: "store 不 import 组件:轮询循环不挂在页面上,必须能在没有 React 树的时候跑",
      from: { path: S + "store/" }, to: { path: [S + "pages/", S + "shell/.*\\.tsx$", S + "lib/.*\\.tsx$", S + "ui/"] } },
    { name: "ui-knows-no-business", severity: "error",
      comment: "ui/ 与 theme/ 只做视觉,不认识 bridge / store / pages",
      from: { path: [S + "ui/", S + "theme/"] }, to: { path: [S + "pages/", S + "lib/", S + "store/", S + "bridge\\.ts$"] } },
    { name: "only-store-and-lib-touch-bridge", severity: "warn",
      comment: "页面直接调 window.dafri 是可以的,但一个 RPC 被三个页面各调一遍就该进 store 了",
      from: { path: S + "shell/" }, to: { path: S + "bridge\\.ts$" } },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    exclude: { path: "\\.css$" },
  },
};

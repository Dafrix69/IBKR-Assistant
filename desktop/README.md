# desktop

Electron 桌面端:`main.js`(窗口、IPC 白名单、引擎进程)、`preload.js`(contextBridge,只暴露具名方法)、
`rpc-client.js`(stdio 上的 JSON-RPC,拉起 `../engine-ts/dist`)、`renderer-react/`(界面:React + Ant Design 5,
Vite 构建,TypeScript;壳在 `src/shell/`,页面在 `src/pages/`,跨页状态与轮询在 `src/store/`)。
界面的说明在 `docs/features/ui.md`,安全边界见仓库根 `README.md`「它怎么工作」一节:
`window.dafri` 的契约在 `preload.js`,React 侧的类型在 `renderer-react/src/bridge.ts`。

```bash
npm install && npm start          # 开发态;先确保 ../engine-ts/dist 新鲜并构建界面(prestart),首启从 ../config/settings.example.json 生成 settings.json
npm run ui:watch                  # 改 renderer-react/ 时增量重建(产物在 renderer-react/dist,重开应用即生效)
npm run ui:typecheck              # tsc
npm run dist:win / dist:mac       # 构建界面 → 暂存 TS 引擎 → 冒烟 → electron-builder
```

`tools/` 是预览数据源(`mock-bridge*.js`,配 `npm run ui:preview`)、截图与渲染层 smoke(`capture_pages.js`)、
解析链路压测(`latency_bench.js`)与打包暂存(`stage_engine_ts.js` / `smoke_engine_ts.js`),全部是 Node 脚本,用法见 `tools/README.md`。

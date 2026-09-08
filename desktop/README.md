# desktop

Electron 桌面端:`main.js`(窗口、IPC 白名单、引擎进程)、`preload.js`(contextBridge,只暴露具名方法)、
`rpc-client.js`(stdio 上的 JSON-RPC,拉起 `../engine-ts/dist`)、`renderer/`(无框架、无打包器、无运行时依赖,
界面逻辑按页面拆在 `renderer/app/*.js`)。界面的说明在 `docs/features/ui.md`,安全边界在仓库根 `README.md`「桌面端架构与安全边界」。

```bash
npm install && npm start          # 开发态;先自动确保 ../engine-ts/dist 新鲜(tools/ensure_engine_ts.js),首启从 ../config/settings.example.json 生成 settings.json
npm run dist:win / dist:mac       # 暂存 TS 引擎 → 冒烟 → electron-builder
```

`tools/` 是预览台(`build_preview.js` + mock-bridge)、截图与 renderer smoke(`capture_pages.js`)、可用性审计(`audit_ui.js`)、
解析链路压测(`latency_bench.js`)与打包暂存(`stage_engine_ts.js` / `smoke_engine_ts.js`),全部是 Node 脚本,用法见 `tools/README.md`。

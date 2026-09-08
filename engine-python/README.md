# engine-python

Python 版交易引擎,也是两套引擎的**行为规格**:pydantic 模型是结构化输出 schema 的唯一事实源,
`scripts/gen_golden.py`、`gen_rpc_samples.py`、`gen_store_fixture.py` 从这里生成 `../engine-ts/baseline/` 的对拍基线。
桌面端默认加载 TS 引擎,`DAFRI_ENGINE=python` 时回退到这里。产品级说明见仓库根 `README.md`。

```bash
python3 -m venv .venv && .venv/bin/pip install -e ".[dev,broker]"   # 富途通道再加 ,futu
.venv/bin/python -m pytest -q                                        # 全部离线
.venv/bin/python -m ibkr_agent selftest                              # 渲染提示词、检查配置,不联网
```

默认读仓库根的 `config/settings.json` 与 `prompts/`;`DAFRI_CONFIG`、`DAFRI_PROMPT_DIR` 可覆盖。
`src/ibkr_agent/` 是实现,`tests/` 是离线测试,`examples/` 是校验样例,`baseline/` 是 `scripts/verify_baseline.py` 的验收基线。

# SDD ledger — plan: (inline brief) aulos 连接指示器改造——反映与大模型服务的连接状况

## Pre-flight
- 共享接口: Task1 probe_provider ← Task2 lazy import; Task3 词条 ← Task2 t() 引用; Task7 词条 ← Task4 renderConn t() 引用; helpers.js ws_connect 消费快照 ← Task2 新增快照（须同步改 helper）
- Ruling(预检): 前端新词条不用 app.060（已被「模型」占用）, 顺延 app.160; 服务端顺延 server.053
- Ruling(预检): probe_provider 保持与设置页测试按钮逐行为一致（不加 max_retries 等调参）, 满足「端点行为不变」约束
- 基线: pytest tests/test_server.py 74 passed; TestClient 用例不触发 startup 钩子（startup 探测安全）
Task 1: complete — probe_provider(async, to_thread 包同步 SDK)+_probe_provider_sync; 端点行为不变; 测试 asyncio.run 桩 SDK; pytest test_providers+test_server 91 passed
Ruling: probe_provider 落成 async（计划签名如此）且用 asyncio.to_thread 防 30s 阻塞事件循环 — cost if wrong: 极低
Ruling: probe_provider 内不再做空 key/model 的 400 校验（留在端点）, 连接指示器路径已由 _provider_ready 前置把关 — cost if wrong: 无
Task 2: complete — server.py: _llm_status/_set_llm_status(广播)/_llm_error_status(分类)/_probe_active_provider(守护线程+asyncio.run, 启动startup钩子+配置变更(有running loop才触发)); ws_endpoint busy_sync后推快照; worker except分类置红/成功置绿。Ruling: 配置变更探测用 get_running_loop 守卫而非计划原文的 create_task——探测函数自身已起线程, 循环外调用安全且装载期/测试导入不打网
Task 3: complete — zh.py/en.py server.053-057（认证失败/无法连接/限流/请求失败/未配置）
Ruling: WS 快照只带 ok/detail（不带 ts）, 与广播消息字段一致 — cost if wrong: 无
Ruling: conftest.ws_connect 顺延为消费两条快照; test_session_archive 一处读序同步 — cost if wrong: 无（helper 语义即"吃掉快照"）
全量 pytest: 1349 passed

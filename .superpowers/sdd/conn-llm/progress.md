# SDD ledger — plan: (inline brief) aulos 连接指示器改造——反映与大模型服务的连接状况

## Pre-flight
- 共享接口: Task1 probe_provider ← Task2 lazy import; Task3 词条 ← Task2 t() 引用; Task7 词条 ← Task4 renderConn t() 引用; helpers.js ws_connect 消费快照 ← Task2 新增快照（须同步改 helper）
- Ruling(预检): 前端新词条不用 app.060（已被「模型」占用）, 顺延 app.160; 服务端顺延 server.053
- Ruling(预检): probe_provider 保持与设置页测试按钮逐行为一致（不加 max_retries 等调参）, 满足「端点行为不变」约束
- 基线: pytest tests/test_server.py 74 passed; TestClient 用例不触发 startup 钩子（startup 探测安全）

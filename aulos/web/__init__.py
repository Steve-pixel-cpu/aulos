"""Web 后端功能域包: server_common 基座 + music/bilibili/pets/stats/settings/policy REST 域。

只放路由模块, 不 re-export——import 本包不应触发路由注册副作用;
各域模块由 server.py 显式 import 挂载。"""

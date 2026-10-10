"""config.py 模型配置冻结回归。

背景: ConfigEntry.model_config 曾写成 {"Frozen": True}——pydantic v2 的
配置键是小写 "frozen", 大写键被静默忽略, 「配置条目防运行期篡改」的
意图从未生效。本文件钉住: 大小写正确 + 冻结真实生效。
"""
import pytest
from pydantic import ValidationError

from config import ConfigEntry, ConfigSource


def test_config_entry_model_config_uses_lowercase_frozen():
    # 防止再次手滑: 键名必须是小写 frozen（pydantic 忽略未知键, 不报错）
    assert "frozen" in ConfigEntry.model_config
    assert "Frozen" not in ConfigEntry.model_config


def test_config_entry_is_actually_frozen():
    entry = ConfigEntry(source=ConfigSource.USER, path="/tmp/x.json")
    with pytest.raises(ValidationError):
        entry.path = "/tmp/y.json"

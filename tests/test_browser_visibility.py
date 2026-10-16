"""浏览器可见性开关（headed 模式 / slowMo）的单元测试。

launch_options() 是纯函数: (feature_config, environ) -> 启动选项 dict。
优先级: 环境变量 AULOS_BROWSER_HEADED / AULOS_BROWSER_SLOWMO（演示时不想
改配置文件）> 配置键 browserHeadless / browserSlowMo > 默认（headless, 0ms）。
非法值兜底: 环境变量配错格式时忽略该变量并继续解析下一个, 不启动失败——
可见性是锦上添花的功能, 配置写错不该把浏览器整残。
"""

import pytest

from aulos.browser_tools import launch_options
from aulos.config import RuntimeFeatureConfig


def _cfg(**kw) -> RuntimeFeatureConfig:
    return RuntimeFeatureConfig(**kw)


class TestDefaults:
    def test_defaults_headless_and_no_slowmo(self):
        opts = launch_options(_cfg(), {})
        assert opts == {"headless": True, "slow_mo": 0, "channel": None}

    def test_channel_passthrough_from_config(self):
        opts = launch_options(_cfg(), {"AULOS_BROWSER_CHANNEL": "msedge"})
        assert opts["channel"] == "msedge"


class TestConfigKeys:
    def test_browser_headless_false_gives_headed(self):
        opts = launch_options(_cfg(browser_headless=False), {})
        assert opts["headless"] is False

    def test_browser_headless_true_keeps_headless(self):
        opts = launch_options(_cfg(browser_headless=True), {})
        assert opts["headless"] is True

    def test_slow_mo_from_config(self):
        opts = launch_options(_cfg(browser_slow_mo=300), {})
        assert opts["slow_mo"] == 300


class TestEnvOverride:
    def test_headed_env_beats_headless_config(self):
        opts = launch_options(_cfg(browser_headless=True),
                              {"AULOS_BROWSER_HEADED": "1"})
        assert opts["headless"] is False

    def test_headed_env_accepts_common_truthy_spellings(self):
        for v in ("1", "true", "TRUE", "yes", "on"):
            opts = launch_options(_cfg(), {"AULOS_BROWSER_HEADED": v})
            assert opts["headless"] is False, v

    def test_headed_env_falsy_values_treated_as_unset(self):
        # "0"/"false" 等 = 想关掉这个覆盖 = 视同未设置, 回退配置
        for v in ("0", "false", "off", "no", ""):
            opts = launch_options(_cfg(browser_headless=True),
                                  {"AULOS_BROWSER_HEADED": v})
            assert opts["headless"] is True, v

    def test_slowmo_env(self):
        opts = launch_options(_cfg(), {"AULOS_BROWSER_SLOWMO": "250"})
        assert opts["slow_mo"] == 250

    def test_slowmo_env_beats_config(self):
        opts = launch_options(_cfg(browser_slow_mo=100),
                              {"AULOS_BROWSER_SLOWMO": "500"})
        assert opts["slow_mo"] == 500

    def test_slowmo_env_zero_disables_config_slowmo(self):
        opts = launch_options(_cfg(browser_slow_mo=300),
                              {"AULOS_BROWSER_SLOWMO": "0"})
        assert opts["slow_mo"] == 0


class TestBadValues:
    def test_bad_headed_env_ignored_falls_back_to_config(self):
        # "0"/"false" 等都算显式要求可见? 不: 非空即开。这里测解析不崩。
        opts = launch_options(_cfg(browser_headless=True),
                              {"AULOS_BROWSER_HEADED": "not-a-flag"})
        assert opts["headless"] is False

    def test_bad_slowmo_env_ignored(self):
        opts = launch_options(_cfg(), {"AULOS_BROWSER_SLOWMO": "abc"})
        assert opts["slow_mo"] == 0

    def test_negative_slowmo_config_raises(self):
        with pytest.raises(ValueError):
            launch_options(_cfg(browser_slow_mo=-5), {})


class TestPydanticValidation:
    def test_negative_browser_slow_mo_rejected_at_config_layer(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            RuntimeFeatureConfig(browser_slow_mo=-1)

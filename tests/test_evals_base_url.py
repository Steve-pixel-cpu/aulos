"""测试: ANTHROPIC_BASE_URL 环境变量贯通（evals nightly 的依赖契约）。

背景: .github/workflows/evals.yml 往仓库根 .env 写
  API_KEY=... / ANTHROPIC_BASE_URL=...（可选）
但 CLI 装配（main.py）与 evals 判分 client（evals/harness.py）此前都不读
这个变量——非官方端点的 Secret 是死配置, 配了也照样打官方端点。
修复: 两处装配读 ANTHROPIC_BASE_URL, 经 normalize_base_url 规范化后传入
make_api_client。未设置时行为不变（base_url=None → SDK 默认端点）。
"""
import pytest

import main
import evals.harness as harness
from api_client import normalize_base_url


def test_main_cli_helper_reads_and_normalizes_env(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://gw.example.com/v1/")
    # anthropic 协议剥掉字面 /v1 段（SDK 自动拼 /v1/messages）
    assert main.env_base_url() == "https://gw.example.com"


def test_main_cli_helper_unset_returns_none(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
    assert main.env_base_url() is None


def test_main_cli_helper_blank_returns_none(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "   ")
    assert main.env_base_url() is None


def test_judge_client_honors_base_url_env(monkeypatch):
    monkeypatch.setenv("API_KEY", "sk-test")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://gw.example.com/v1")
    cli = harness.make_judge_client()
    assert cli._base_url == "https://gw.example.com"


def test_judge_client_default_endpoint_when_unset(monkeypatch, tmp_path):
    # 无 .env 的 ROOT 下（且 env 未设）才回默认端点; 真实仓库 .env 配有
    # ANTHROPIC_BASE_URL, 会被 make_judge_client 内的 load_dotenv 载入,
    # 那是正确行为（.env 是配置源）, 不能作为"默认端点"的测试前提。
    monkeypatch.setenv("API_KEY", "sk-test")
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
    monkeypatch.setattr(harness, "ROOT", tmp_path)
    cli = harness.make_judge_client()
    assert cli._base_url in (None, "")


def test_normalize_roundtrip_official_helper():
    """文档性钉子: normalize 对官方风格地址的行为（剥 /v1 尾段）。"""
    assert normalize_base_url("https://api.example.com/v1/") == "https://api.example.com"

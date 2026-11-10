"""离线/CI 环境的模块桩：只在本机缺真实库时顶位，保证测试可导入。

CI（GitHub Actions ubuntu）安装 aiohttp（库测试会真实调用 web.json_response 等），
但不含 numpy / torch / PIL；而 image_tools.py、generate_node.py 顶层导入科学栈。
真实库存在时（本机 / ComfyUI 环境）完全不干预。

强制本地模拟 CI：设 ALLBUY_FORCE_STUBS=1（只强制科学栈，aiohttp 永不强制）。
"""
import importlib.util
import os
import sys
import types

_FORCE = os.environ.get("ALLBUY_FORCE_STUBS") == "1"


def _missing(name):
    """科学栈桩判定：ALLBUY_FORCE_STUBS=1 时强制视为缺失（本地模拟 CI）。"""
    if _FORCE:
        return True
    try:
        return importlib.util.find_spec(name) is None
    except (ImportError, AttributeError, ValueError):
        return True


def _missing_real(name):
    """永不强制替换：功能测试会真正调用其成员，桩顶不住，需真库（CI pip 安装）。"""
    try:
        return importlib.util.find_spec(name) is None
    except (ImportError, AttributeError, ValueError):
        return True


def _put(name, mod):
    mod.__path__ = []  # 允许作为包挂子模块
    sys.modules[name] = mod


def install():
    """幂等安装缺失模块的最小桩（仅服务 import；桩上运行真实计算无意义）。"""
    if _missing("numpy"):
        _put("numpy", types.ModuleType("numpy"))
    if _missing("torch"):
        _put("torch", types.ModuleType("torch"))
        _put("torch.nn.functional", types.ModuleType("torch.nn.functional"))
    if _missing("PIL"):
        pil = types.ModuleType("PIL")
        for sub in ("Image", "ImageColor", "ImageDraw", "ImageFont",
                    "ImageOps", "ImageFilter"):
            child = types.ModuleType(f"PIL.{sub}")
            setattr(pil, sub, child)
            _put(f"PIL.{sub}", child)
        _put("PIL", pil)
    if _missing_real("aiohttp"):
        # 兜底导入桩（CI 已 pip install aiohttp，正常不会走到）：
        # api.py 顶层 `from aiohttp import web`；离线无 server 时注册整体跳过
        aio = types.ModuleType("aiohttp")
        _put("aiohttp.web", types.ModuleType("aiohttp.web"))
        aio.web = sys.modules["aiohttp.web"]
        _put("aiohttp", aio)


install()

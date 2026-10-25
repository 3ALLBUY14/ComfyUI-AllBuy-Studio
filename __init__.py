"""AllBuy Studio｜AllBuy 创作套件入口。"""
import importlib
import traceback

from . import constants, library_store  # noqa: F401  各节点模块的公共依赖

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# 逐个加载节点模块：某个模块出错只跳过该模块并记录日志，其余节点照常可用
for _module_name in (
    "nodes",
    "batch_image_node",
    "media_asset",
    "lora_stack_node",
    "image_compare_node",
    "textbox_node",
    "image_tools",
    "generate_node",
):
    try:
        _module = importlib.import_module("." + _module_name, __name__)
        NODE_CLASS_MAPPINGS.update(_module.NODE_CLASS_MAPPINGS)
        NODE_DISPLAY_NAME_MAPPINGS.update(_module.NODE_DISPLAY_NAME_MAPPINGS)
    except Exception:
        print(f"[AllBuy Studio] 节点模块 {_module_name} 加载失败，已跳过：")
        traceback.print_exc()

# 导入 api 即注册 HTTP 路由；单独兜底，路由问题不影响节点加载
try:
    from . import api  # noqa: F401
except Exception:
    print("[AllBuy Studio] HTTP 路由注册失败：")
    traceback.print_exc()

WEB_DIRECTORY = "./web"

# 启动时确保用户库目录存在，并在首次启动时复制内置示例库到用户目录
try:
    library_store.get_user_libraries_folder()
    library_store.ensure_default_library()
    print("[AllBuy Studio] 已加载，用户库目录："
          + library_store.get_user_libraries_folder())
except Exception as e:  # noqa: BLE001
    print(f"[AllBuy Studio] 初始化用户库失败：{e}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

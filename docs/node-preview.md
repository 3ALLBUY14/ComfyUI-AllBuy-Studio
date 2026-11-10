# MOSS 节点交互预览

本地预览使用插件真实的 MOSS 编辑器，可检查自适应高度、深浅主题定位网格、外部分辨率覆盖、官方像素档位及 MP 显示。

```powershell
python tests/preview_node_tools.py --port 8199
```

打开 `http://127.0.0.1:8199`。勾选「外部宽高输入」可模拟分辨率连线，工作台尺寸区会显示来源并锁定内部尺寸控件；断开后可恢复手动调整。右侧保留现有的 A/B 分割对比。

预览页面的保存仅作用于临时示例数据，图片上传写入独立临时目录；实际插件中，布局随 ComfyUI 工作流保存。页面不加载模型，也不进行采样。

桌面交互检查：先启动预览，再运行 `python tests/browser_moss_resolution.py --headed --artifacts <截图目录>`。完整工作台回归为 `python tests/browser_moss_layout.py --headed --artifacts <截图目录>`。

功能使用见 [MOSS 布局工作台](moss-layout.md)。

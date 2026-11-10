# 功能截图

配图使用当前插件界面和虚构示例数据，不读取个人模型或用户库。

使用 `tests/capture_readme.py` 在桌面 Chrome 中加载当前源码并截图，接口返回隔离的虚构数据，不读取本机模型或用户库。MOSS 与 A/B 使用本地临时预览宿主，图像标题和网格预览由插件自身的图像处理函数生成；未进行模型采样。截图使用虚构的提示词库、模型名、标签、目录和文本，图片为自制的几何风景插画，视频和波形也使用演示内容。

所有示例模型只用于说明界面功能，不代表真实可下载的模型。截图不包含个人邮箱、账号、密钥、真实模型清单、用户工作流内容或本机绝对路径。

- `manager-*.png`：全屏管理面板、堆栈、组合、右键和标签管理。
- `preview-*.png`：图片 / 视频放大预览与缩放控制。
- `node-*.png`：各节点的主要操作界面。
- `lora-picker-batch.png`：LoRA 跨搜索勾选与批量加入。
- `prompt-hover.png`：提示词组悬浮信息卡，按已填写字段显示。
- `media-*-editor.png`：图片、视频和音频素材编辑窗口。
- `library-picker.png`：提示词库选择器。
- `moss-layout-dark.png` / `moss-layout-light.png`：MOSS 深浅主题定位网格、分辨率预设与 MP 显示。

图片与仓库采用相同的 MIT 许可。更新附图时应继续使用虚构演示数据，并检查图片元数据和可见文字。

重新截取全部视图：使用含 Pillow、NumPy、PyTorch 的 ComfyUI Python 环境，另需安装 Playwright、Chrome 和 PATH 中可用的 FFmpeg。

```powershell
python tests/capture_readme.py docs/images --headed
```

脚本从 README 提取图片清单，检查全部配图均在本次运行中重新生成，并验证图片尺寸、元数据和浏览器错误，避免只更新部分截图。

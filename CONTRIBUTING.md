# 参与开发

## 环境

- ComfyUI（能正常加载自定义节点）
- Python 3.10+
- 跑 JS 用例时需要本机可执行的 `node`

把本仓库放进 `ComfyUI/custom_nodes/`，重启 ComfyUI 即可加载。

## 目录与版本

- `backend/` 存放 Python 实现，根目录 `__init__.py` 是 ComfyUI 加载入口；前端保留在 `web/`。
- 版本按 `V1.0 → V1.1 → … → V1.9 → V2.0` 递增，次版本只使用 0～9。
- 发布时同步更新 `backend/constants.py`、`web/version.js`、`pyproject.toml` 和 README 徽章；内部版本用于缓存与前后端校验，节点界面不显示版本数字。

## 测试

在插件根目录执行：

```bash
pytest tests/
```

说明：

- Python 用例覆盖库管理、LoRA 分组、媒体资源、合并、随机抽卡等。
- `*.mjs` 前端用例由 `tests/test_web_js.py` 调用 `node` 执行。
- `tests/test_examples.py` 会校验 `examples/*.json`，改了示例请一并跑。

## PR 约定

- 一个 PR 只做一件事。
- 说明复现步骤、修复前后行为、验证方式。
- 行为变更必须补对应测试；修 bug 优先补一条能复现的用例。
- 新增或修改功能时同步更新 `README.md` 与 `examples/`。
- 不提交用户库数据、上传的媒体、个人绝对路径或缓存。
- 贡献默认采用本仓库的 MIT 许可。

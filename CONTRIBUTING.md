# 参与开发

## 环境

- ComfyUI（能正常加载自定义节点）
- Python 3.10+
- 跑 JS 用例时需要本机可执行的 `node`

把本仓库放进 `ComfyUI/custom_nodes/`，重启 ComfyUI 即可加载。

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

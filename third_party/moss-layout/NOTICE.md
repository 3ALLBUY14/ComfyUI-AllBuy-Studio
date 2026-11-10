# MOSS layout integration

The draft vocabulary, coordinate compilation and legacy scene adaptation in
`moss_layout.py` are adapted from:

- LinXce / Comfyui-Moss-LayoutPrompt, commit
  `326ad58e3e5055cc59b90fe5b5d2bcddf3698a4d`, `layout.py`.
  https://github.com/LinXce/Comfyui-Moss-LayoutPrompt
- OpenMOSS / MOSS-Image prompt-enhancer `compile_prompt.py`, as referenced by
  moss-image-community / moss-image-layout-editor at commit
  `a67b5af7cfcae93fe54675f570af3aa4cd0c7784`.
  https://github.com/OpenMOSS/MOSS-Image
  https://github.com/moss-image-community/moss-image-layout-editor
- Resolution pixel budgets and 16-pixel dimension rounding follow OpenMOSS /
  MOSS-Image `gradio_presets.py`, commit
  `6be4453024c5acae9dcd0a191e26ee524e743310`.
  https://github.com/OpenMOSS/MOSS-Image/blob/6be4453024c5acae9dcd0a191e26ee524e743310/gradio_presets.py

These upstream projects use Apache License 2.0. A copy is included in LICENSE.

AllBuy modifications: bounded and shared import/preview/execution validation,
an independent node identifier, workflow serialization and a new locally served
editor using AllBuy's existing theme and controls. No upstream visual styles or
fonts are bundled. The rest of AllBuy Studio retains its existing license.

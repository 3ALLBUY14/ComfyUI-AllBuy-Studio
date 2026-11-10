"""Desktop verification of MOSS presets, theme colours and wired dimensions."""
import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright, expect


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--artifacts", type=Path, required=True); parser.add_argument("--headed", action="store_true"); args = parser.parse_args()
    args.artifacts.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=not args.headed)
        page = browser.new_page(viewport={"width": 1680, "height": 1050}, device_scale_factor=1)
        errors = []; page.on("pageerror", lambda error: errors.append(str(error))); page.on("dialog", lambda d: d.accept())
        page.goto("http://127.0.0.1:8199"); page.wait_for_function("window.previewReady")
        assert page.evaluate("mossNode.inputs.map(i=>i.name)") == ["width", "height"]
        assert page.evaluate("mossNode.outputs.map(o=>o.name)") == ["提示词", "宽度", "高度", "布局草稿"]
        assert page.evaluate("compareNode.outputs.map(o=>o.name)") == ["图片A", "图片B"]
        opener = page.get_by_role("button", name="打开布局工作台", exact=True)
        opener.click(); dlg = page.get_by_role("dialog", name="布局工作台", exact=True)
        save = dlg.get_by_role("button", name="保存并应用", exact=True)
        expect(save).to_be_enabled()
        expect(dlg.get_by_role("button", name="预览遮罩", exact=True)).to_have_count(0)
        page.wait_for_function("getComputedStyle(document.querySelector('.aml-sheet')).backgroundColor==='rgb(32, 44, 56)'")
        dlg.get_by_label("像素档位", exact=True).select_option("1572864")
        dlg.get_by_label("画布比例", exact=True).select_option("3:2")
        expect(dlg.get_by_label("宽度", exact=True)).to_have_value("1536")
        expect(dlg.get_by_label("高度", exact=True)).to_have_value("1024")
        expect(dlg.locator(".aml-size-metric")).to_have_text("1536 × 1024 · 1.57 MP")
        expect(save).to_be_enabled()
        page.screenshot(path=str(args.artifacts / "moss-resolution-dark.png"))
        page.evaluate("document.documentElement.dataset.theme='light'")
        page.wait_for_function("getComputedStyle(document.querySelector('.aml-sheet')).backgroundColor==='rgb(245, 243, 237)'")
        page.wait_for_function("getComputedStyle(document.querySelector('.aml-box')).color==='rgb(44, 60, 80)'")
        page.wait_for_function("getComputedStyle(document.querySelector('.aml-inspector .ait-input')).backgroundColor==='rgb(228, 233, 236)'")
        page.screenshot(path=str(args.artifacts / "moss-resolution-light.png"))
        save.click(); expect(dlg).to_have_count(0)
        saved = page.evaluate("JSON.parse(mossNode.widgets[0].value)")
        assert (saved["width"], saved["height"]) == (1536, 1024)
        page.evaluate("document.documentElement.dataset.theme='dark'")
        page.get_by_label("外部宽度", exact=True).fill("2048")
        page.get_by_label("使用外部分辨率", exact=True).check()
        expect(page.locator(".aml-node-summary")).to_contain_text("2048 × 1024 · 2.10 MP")
        opener.click()
        expect(dlg.get_by_label("宽度", exact=True)).to_have_value("2048")
        for name in ["宽度", "高度", "像素档位", "画布比例"]:
            expect(dlg.get_by_label(name, exact=True)).to_be_disabled()
        expect(dlg.locator(".aml-size-source")).to_contain_text("外部分辨率优先")
        assert page.evaluate("JSON.parse(mossNode.widgets[0].value).width") == 1536, "Preview must not silently rewrite saved drafts"
        # An upstream change updates an open editor, including its coordinates.
        page.evaluate("resolutionSource.widgets[0].value=1024;resolutionSource.widgets[1].value=1536;mossNode.onDrawBackground()")
        expect(dlg.get_by_label("宽度", exact=True)).to_have_value("1024")
        expect(dlg.get_by_label("高度", exact=True)).to_have_value("1536")
        expect(dlg.locator(".aml-metric")).to_contain_text("1024 × 1536 · 1.57 MP")
        expect(save).to_be_enabled()
        page.screenshot(path=str(args.artifacts / "moss-resolution-wired.png"))
        save.click(); expect(dlg).to_have_count(0)
        saved = page.evaluate("JSON.parse(mossNode.widgets[0].value)")
        assert saved["width"] == 1024 and saved["height"] == 1536
        # Dynamic outputs cannot be guessed from a local widget with another name.
        page.evaluate("resolutionSource.outputs[0].name='computed_width';mossNode.onConnectionsChange()")
        opener.click()
        expect(dlg.locator(".aml-size-source")).to_contain_text("等待上游执行")
        page.evaluate("mossNode.onExecuted({allbuy_moss_dimensions:[1536,1024]})")
        expect(dlg.get_by_label("宽度", exact=True)).to_have_value("1536")
        expect(dlg.locator(".aml-size-source")).to_contain_text("上次执行值")
        # Disconnecting restores editable controls without replacing the saved layout.
        page.evaluate("for(const input of mossNode.inputs)input.link=null;mossNode.onConnectionsChange()")
        expect(dlg.get_by_label("宽度", exact=True)).to_be_enabled()
        expect(dlg.locator(".aml-size-source")).to_have_text("使用工作台尺寸")
        dlg.get_by_label("宽度", exact=True).fill("768"); dlg.get_by_label("高度", exact=True).fill("1024")
        dlg.get_by_role("button", name="应用尺寸", exact=True).click()
        expect(dlg.locator(".aml-metric")).to_contain_text("768 × 1024 · 0.79 MP")
        assert not dlg.evaluate("el=>el.scrollWidth>el.clientWidth")
        dlg.get_by_role("button", name="关闭 ×", exact=True).click()
        assert not errors, errors
        browser.close()
    print("PASS: desktop themes, MOSS official pixel presets, MP display, input priority, live connected updates, dynamic execution, disconnect and manual fallback")


if __name__ == "__main__":
    main()

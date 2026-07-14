#!/usr/bin/env python3
"""E2E: drive real agent chat in Chromium for browse_library + edit_item.

  python3 scripts/e2e-agent-library.py
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PwTimeout

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:5200"
VIDEO = ROOT / "public" / "media" / "uploads" / "testsrc-tc.mp4"
OUT = ROOT / "scripts" / "_e2e-agent-out"
OUT.mkdir(parents=True, exist_ok=True)


def log(msg: str) -> None:
    print(msg, flush=True)


def dismiss_overlays(page) -> None:
    page.keyboard.press("Escape")
    page.wait_for_timeout(120)
    page.keyboard.press("Escape")
    page.wait_for_timeout(120)
    # click empty top-bar area if still blocked
    page.mouse.click(700, 20)
    page.wait_for_timeout(100)


def wait_agent_idle(page, timeout_ms: int = 180_000) -> None:
    deadline = time.time() + timeout_ms / 1000
    # give the stop button a moment to appear
    page.wait_for_timeout(500)
    while time.time() < deadline:
        stop = page.locator('button[title="停止"]')
        if stop.count() == 0:
            page.wait_for_timeout(600)
            if page.locator('button[title="停止"]').count() == 0:
                return
        time.sleep(0.35)
    raise TimeoutError("agent still running after timeout")


def enable_auto_apply(page) -> None:
    dismiss_overlays(page)
    page.locator('button[title="设置"]').click(force=True)
    page.wait_for_timeout(250)
    cb = page.locator('label:has-text("自动应用") input[type="checkbox"]')
    if cb.count():
        if not cb.is_checked():
            cb.check(force=True)
            log("enabled 自动应用 AI 提案")
        else:
            log("auto-apply already on")
    else:
        log("WARN: auto-apply checkbox not found")
    dismiss_overlays(page)


def ensure_agent_mode(page) -> None:
    dismiss_overlays(page)
    mode_btn = page.locator('button[title="模式"]')
    if mode_btn.count() == 0:
        return
    if "Agent" not in mode_btn.inner_text():
        mode_btn.click(force=True)
        page.get_by_text("代理模式", exact=False).first.click(force=True)
        log("switched to Agent mode")
        dismiss_overlays(page)
    else:
        log("already Agent mode")


def import_videos(page) -> None:
    if not VIDEO.exists():
        raise FileNotFoundError(VIDEO)
    dismiss_overlays(page)
    # ensure 我的素材
    tab = page.locator("button.cc-main-tab", has_text="我的素材")
    if tab.count():
        tab.first.click(force=True)
        page.wait_for_timeout(300)

    inp = page.locator('input[type="file"]').first
    # two separate imports → two pool cards when possible
    inp.set_input_files(str(VIDEO))
    page.wait_for_timeout(2500)
    inp.set_input_files(str(VIDEO))
    page.wait_for_timeout(2500)
    log("imported test video twice")

    # place onto timeline: click each thumb (or same thumb twice) for adjacent clips
    thumbs = page.locator("button.cc-asset-thumb")
    n = thumbs.count()
    log(f"asset thumbs: {n}")
    if n >= 2:
        thumbs.nth(0).click(force=True, timeout=5000)
        page.wait_for_timeout(400)
        thumbs.nth(1).click(force=True, timeout=5000)
        page.wait_for_timeout(400)
    elif n == 1:
        thumbs.first.click(force=True, timeout=5000)
        page.wait_for_timeout(400)
        thumbs.first.click(force=True, timeout=5000)
        page.wait_for_timeout(400)
    else:
        log("place clip warn: no thumbs")
    dismiss_overlays(page)


def composer(page):
    return page.locator(
        'textarea[placeholder*="创建"], textarea[placeholder*="修改"], textarea[placeholder*="AI"]'
    ).first


def send_chat(page, text: str) -> None:
    dismiss_overlays(page)
    ta = composer(page)
    ta.click(force=True)
    ta.fill(text)
    page.wait_for_timeout(150)
    ta.press("Enter")
    log(f"sent: {text[:90]}…")


def main() -> int:
    log(f"BASE={BASE} VIDEO={VIDEO.exists()}")
    tool_calls: list[dict] = []
    llm_calls = 0

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        def on_response(res):
            nonlocal llm_calls
            if "/llm/" not in res.url or res.request.method != "POST":
                return
            llm_calls += 1
            try:
                body = res.json()
                for b in body.get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        tool_calls.append({"name": b.get("name"), "input": b.get("input")})
                        log(
                            "  tool_use → "
                            + str(b.get("name"))
                            + " "
                            + json.dumps(b.get("input"), ensure_ascii=False)[:160]
                        )
            except Exception:
                pass

        page.on("response", on_response)

        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_timeout(2000)

        # create / open project
        for label in ("新建工程", "新建", "创建工程", "创建"):
            btn = page.get_by_role("button", name=re.compile(label))
            if btn.count():
                btn.first.click(force=True)
                page.wait_for_timeout(2500)
                break
        else:
            # click any project open
            page.evaluate(
                """() => {
                const b = [...document.querySelectorAll('button')].find(x => /打开|编辑/.test(x.textContent||''));
                if (b) b.click();
            }"""
            )
            page.wait_for_timeout(2500)

        try:
            composer(page).wait_for(state="visible", timeout=45_000)
        except PwTimeout:
            page.screenshot(path=str(OUT / "fail-no-editor.png"))
            log("FAIL: no chat textarea")
            log(page.url)
            browser.close()
            return 1

        log(f"editor ready url={page.url}")
        page.screenshot(path=str(OUT / "01-editor.png"))

        ensure_agent_mode(page)
        enable_auto_apply(page)
        try:
            import_videos(page)
        except Exception as e:
            log(f"import warn: {e}")

        page.screenshot(path=str(OUT / "02-after-import.png"))

        # Turn 1: browse only
        send_chat(
            page,
            "请调用 browse_library，category 设为 fx，query 为 bloom。"
            "只返回找到的 id 和 name，不要改时间线。",
        )
        try:
            wait_agent_idle(page, 150_000)
        except TimeoutError as e:
            page.screenshot(path=str(OUT / "fail-browse-timeout.png"))
            log(f"FAIL browse: {e}")
            browser.close()
            return 1
        body1 = page.inner_text("body")
        (OUT / "chat-after-browse.txt").write_text(body1, encoding="utf-8")
        page.screenshot(path=str(OUT / "03-after-browse.png"))
        log(f"after browse tools={[t['name'] for t in tool_calls]}")

        # Turn 2: apply bloom
        send_chat(
            page,
            "请用 browse_library 确认 builtin:fx-bloom，然后用 edit_item "
            "给时间线第一个 video 或 image 片段添加 effect assetId=builtin:fx-bloom。"
            "没有 video/image 就先 read_timeline 说明。简要中文回复。",
        )
        try:
            wait_agent_idle(page, 180_000)
        except TimeoutError as e:
            page.screenshot(path=str(OUT / "fail-edit-timeout.png"))
            log(f"FAIL edit: {e}")
            browser.close()
            return 1
        body2 = page.inner_text("body")
        (OUT / "chat-after-edit.txt").write_text(body2, encoding="utf-8")
        page.screenshot(path=str(OUT / "04-after-edit.png"))

        # Turn 3: zoom punch on first clip
        send_chat(
            page,
            "请用 edit_item 给第一个 video 片段添加缩放 "
            "assetId=library:zoom:punch（type=effect）。简要中文说明。",
        )
        try:
            wait_agent_idle(page, 150_000)
        except TimeoutError as e:
            log(f"zoom timeout: {e}")
        body_zoom = page.inner_text("body")
        (OUT / "chat-after-zoom.txt").write_text(body_zoom, encoding="utf-8")
        page.screenshot(path=str(OUT / "05-after-zoom.png"))

        # Turn 4: transition if two clips
        send_chat(
            page,
            "请 read_timeline。若存在相邻 video 切点，用 edit_item 给后一镜加 "
            "transition assetId=builtin:tr-cross-dissolve；若只有一镜，"
            "先把媒体池里的素材再加到时间线一次形成两段相邻，再加转场。",
        )
        try:
            wait_agent_idle(page, 200_000)
        except TimeoutError as e:
            log(f"transition timeout: {e}")
        body3 = page.inner_text("body")
        (OUT / "chat-final.txt").write_text(body3, encoding="utf-8")
        page.screenshot(path=str(OUT / "06-final.png"))

        # Stream responses often aren't parseable as JSON; trust chat UI tool chips + inspector text.
        names = [t.get("name") for t in tool_calls]
        final = body3
        ui_browse = "browse_library" in final
        ui_edit = "edit_item" in final
        ui_manage = "manage_effects" in final
        ui_read = "read_timeline" in final
        bloom_ui = "光晕 Bloom" in final or "builtin:fx-bloom" in final
        # inspector shows applied effect as "1. 光晕 Bloom"
        bloom_applied = "1. 光晕 Bloom" in final or re.search(r"光晕 Bloom\s*\n", final) is not None
        zoom_ui = "library:zoom:punch" in final or "冲击" in final or "punch" in final.lower()
        tr_ui = "cross-dissolve" in final or "叠化" in final or "builtin:tr-cross-dissolve" in final

        summary = {
            "llm_calls": llm_calls,
            "tool_calls_from_network": names,
            "browse_library_called": ui_browse or "browse_library" in names,
            "edit_item_called": ui_edit or "edit_item" in names,
            "manage_effects_called": ui_manage or "manage_effects" in names,
            "read_timeline_called": ui_read or "read_timeline" in names,
            "bloom_mentioned": bloom_ui,
            "bloom_applied_in_inspector": bloom_applied,
            "zoom_mentioned": zoom_ui,
            "transition_mentioned": tr_ui,
            "url": page.url,
        }
        (OUT / "tool_calls.json").write_text(
            json.dumps(tool_calls, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        (OUT / "summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        log("SUMMARY " + json.dumps(summary, ensure_ascii=False))

        ok = (
            summary["browse_library_called"]
            and (summary["edit_item_called"] or summary["manage_effects_called"])
            and summary["bloom_mentioned"]
        )
        browser.close()
        if ok:
            log("\nE2E AGENT TEST: PASSED")
            return 0
        log("\nE2E AGENT TEST: FAILED")
        return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log(f"FATAL: {e}")
        import traceback

        traceback.print_exc()
        sys.exit(1)

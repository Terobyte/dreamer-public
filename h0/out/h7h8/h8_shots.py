import time
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=False, args=["--ignore-certificate-errors"])
    page = b.new_context(ignore_https_errors=True, viewport={"width": 1280, "height": 800}).new_page()
    errs = []
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto("https://localhost:8081/")
    page.wait_for_function("window.__splats && window.__splats.loaded >= 4", timeout=120000)
    time.sleep(3)
    page.screenshot(path="h8_0.png")
    page.evaluate("window.__dissolve(1)")
    for i, dt in enumerate([0.9, 0.9, 1.5]):
        time.sleep(dt); page.screenshot(path=f"h8_{i+1}.png"); print("fps", page.evaluate("window.__splats.fps"))
    page.evaluate("window.__dissolve(0)")
    time.sleep(1.2); page.screenshot(path="h8_4.png")
    time.sleep(2); page.screenshot(path="h8_5.png")
    print("errors", errs[:5])
    b.close()

/* Optional development QA. No test dependency is used by the published site. */
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { existsSync } = require("node:fs");
const { chromium } = require(
  process.env.PLAYWRIGHT_CORE_PATH || "playwright-core",
);

const root = path.resolve(__dirname, "..");
const mount = "/school-website/";
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf",
};
const heads = new Map();
const documents = new Map();

function samplePdf() {
  const stream = "BT /F1 20 Tf 72 750 Td (School portal - test document) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
documents.set("0123456789.pdf", samplePdf());
documents.set("1234567890.pdf", samplePdf());

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (!pathname.startsWith(mount)) {
    res.writeHead(404).end();
    return;
  }
  const relative =
    decodeURIComponent(pathname.slice(mount.length)) || "index.html";
  const filename = path.resolve(root, relative);
  if (!filename.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  if (req.method === "HEAD" && relative.startsWith("pdfs/"))
    heads.set(relative, (heads.get(relative) || 0) + 1);
  try {
    const body =
      relative.startsWith("pdfs/") && documents.has(path.basename(relative))
        ? documents.get(path.basename(relative))
        : await fs.readFile(filename);
    res.writeHead(200, {
      "Content-Type":
        types[path.extname(filename)] || "application/octet-stream",
      "Content-Length": body.length,
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/html" }).end("Not found");
  }
});

async function main() {
  const executablePath =
    process.env.BROWSER_PATH ||
    [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "/usr/bin/chromium",
      "/usr/bin/google-chrome",
    ].find(existsSync);
  if (!executablePath)
    throw new Error("Set BROWSER_PATH to an installed Chromium browser.");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const exceptions = [];
  const externalRequests = [];
  page.on("pageerror", (error) => exceptions.push(error.message));
  // Chromium's PDF viewer loads chrome:// and chrome-extension:// resources.
  // Those are browser internals, not third-party network connections.
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin)
      externalRequests.push(url.href);
  });
  let passed = 0;
  async function test(name, action) {
    await action();
    passed += 1;
    console.log(`PASS ${name}`);
  }
  const field = page.locator("#national-id");
  const submit = () => page.locator("#search-button").click();
  const search = async (id) => {
    await field.fill(id);
    await submit();
    await page.waitForFunction(
      () => !document.getElementById("result-panel").hidden,
    );
  };
  const expectState = async (state) =>
    assert.equal(
      await page.locator("#result-panel").getAttribute("data-state"),
      state,
    );
  const routePattern = "**/pdfs/*.pdf";
  await fs.mkdir(path.join(root, "test-results"), { recursive: true });

  try {
    await page.goto(origin + mount);
    await page.evaluate(() => document.fonts.ready);
    await test("Arabic, RTL, local assets and initial layout", async () => {
      assert.equal(await page.locator("html").getAttribute("lang"), "ar");
      assert.equal(await page.locator("html").getAttribute("dir"), "rtl");
      assert.equal(await field.getAttribute("type"), "text");
      assert.equal(await field.getAttribute("inputmode"), "numeric");
      assert.equal(
        await field.evaluate((el) => getComputedStyle(el).direction),
        "ltr",
      );
      assert.equal(
        await page.locator("#current-year").innerText(),
        String(new Date().getFullYear()),
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.screenshot({
        path: path.join(root, "test-results/desktop.png"),
        fullPage: true,
      });
    });
    if (process.env.AXE_CORE_PATH) {
      await test("WCAG accessibility audit", async () => {
        await page.addScriptTag({ path: process.env.AXE_CORE_PATH });
        const violations = await page.evaluate(async () => {
          const results = await axe.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
          });
          return results.violations.map(({ id, nodes }) => ({
            id,
            elements: nodes.map(({ target }) => target),
          }));
        });
        assert.deepEqual(violations, []);
      });
    }
    await test("Empty and wrong-length validation sends no lookup", async () => {
      const count = heads.size;
      await submit();
      assert.equal(
        await page.locator("#input-error").innerText(),
        "يرجى إدخال الرقم الوطني أولاً",
      );
      await field.fill("123");
      await submit();
      assert.equal(
        await page.locator("#input-error").innerText(),
        "يرجى إدخال رقم وطني صحيح",
      );
      assert.equal(heads.size, count);
    });
    await test("Letters, symbols, whitespace and non-English digits are rejected", async () => {
      for (const character of ["a", "-", ".", " ", "١"]) {
        await field.fill("");
        await field.pressSequentially(character);
        assert.equal(await field.inputValue(), "");
        assert.equal(
          await page.locator("#input-error").innerText(),
          "يرجى إدخال أرقام إنجليزية فقط",
        );
      }
      const pastePrevented = await field.evaluate((el) => {
        const data = new DataTransfer();
        data.setData("text/plain", "123 456");
        const event = new ClipboardEvent("paste", {
          clipboardData: data,
          cancelable: true,
          bubbles: true,
        });
        return !el.dispatchEvent(event);
      });
      assert.equal(pastePrevented, true);
      assert.equal(await field.inputValue(), "");
    });
    await test("Numeric paste is accepted and leading zeros survive Enter submission", async () => {
      const accepted = await field.evaluate((el) => {
        const data = new DataTransfer();
        data.setData("text/plain", "0123456789");
        return el.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: data,
            cancelable: true,
            bubbles: true,
          }),
        );
      });
      assert.equal(accepted, true);
      // Synthetic paste has no default editing action; insert its text explicitly.
      await page.keyboard.insertText("0123456789");
      await field.press("Enter");
      await page.waitForFunction(
        () => !document.getElementById("success-actions").hidden,
      );
      await expectState("success");
      assert.equal(await field.inputValue(), "0123456789");
      assert.equal(
        await page.locator("#download-link").getAttribute("download"),
        "0123456789.pdf",
      );
      assert.equal(
        await page.locator("#download-link").getAttribute("href"),
        origin + mount + "pdfs/0123456789.pdf",
      );
      assert.equal(heads.get("pdfs/0123456789.pdf"), 1);
    });
    await test("View uses the verified document; close restores focus", async () => {
      await page.locator("#view-button").click();
      assert.equal(await page.locator("#pdf-viewer").isVisible(), true);
      assert.match(
        await page.locator("#pdf-frame").getAttribute("src"),
        /\/school-website\/pdfs\/0123456789\.pdf#view=FitH$/,
      );
      assert.equal(
        await page.locator("#open-pdf-link").getAttribute("rel"),
        "noopener noreferrer",
      );
      await page.locator("#close-viewer").click();
      assert.equal(await page.locator("#pdf-viewer").isVisible(), false);
      assert.equal(await page.locator("#pdf-frame").getAttribute("src"), null);
      assert.equal(
        await page
          .locator("#view-button")
          .evaluate((el) => document.activeElement === el),
        true,
      );
    });
    await test("Download preserves the exact filename and PDF content", async () => {
      const downloadEvent = page.waitForEvent("download");
      await page.locator("#download-link").click();
      const download = await downloadEvent;
      assert.equal(download.suggestedFilename(), "0123456789.pdf");
      const buffer = await fs.readFile(await download.path());
      assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
    });
    await test("Editing clears previous result, viewer and links immediately", async () => {
      await page.locator("#view-button").click();
      await field.fill("9876543210");
      assert.equal(await page.locator("#result-panel").isVisible(), false);
      assert.equal(await page.locator("#pdf-viewer").isVisible(), false);
      assert.equal(
        await page.locator("#download-link").getAttribute("href"),
        null,
      );
      assert.equal(
        await page.locator("#open-pdf-link").getAttribute("href"),
        null,
      );
    });
    await test("Missing PDF and retry", async () => {
      await search("9876543210");
      await expectState("not-found");
      assert.match(
        await page.locator("#result-description").innerText(),
        /يرجى التأكد من صحة الرقم/,
      );
      assert.equal(await page.locator("#success-actions").isVisible(), false);
      await page.locator("#retry-button").click();
      assert.equal(
        await field.evaluate((el) => document.activeElement === el),
        true,
      );
      assert.equal(await page.locator("#result-panel").isVisible(), false);
    });
    await test("A new PDF is searchable without changing JavaScript", async () => {
      documents.set("1122334455.pdf", samplePdf());
      await search("1122334455");
      await expectState("success");
    });
    await test("HTTP errors, redirects and HTML fallback pages never expose links", async () => {
      for (const [status, contentType, body] of [
        [403, "text/plain", "Denied"],
        [405, "text/plain", "No HEAD"],
        [500, "text/plain", "Error"],
        [200, "text/html", "<html>fallback</html>"],
        [204, "application/pdf", ""],
        [302, "text/plain", "redirect"],
      ]) {
        await page.route(routePattern, (route) =>
          route.fulfill({
            status,
            contentType,
            body,
            headers:
              status === 302
                ? { location: origin + mount + "pdfs/1234567890.pdf" }
                : {},
          }),
        );
        await search("5555555555");
        await expectState("error");
        assert.match(
          await page.locator("#result-description").innerText(),
          /حدث خطأ أثناء التحقق/,
        );
        assert.equal(
          await page.locator("#download-link").getAttribute("href"),
          null,
        );
        assert.equal(await page.locator("#search-button").isEnabled(), true);
        await page.unroute(routePattern);
      }
    });
    await test("Network failure is distinct from a missing PDF", async () => {
      await page.route(routePattern, (route) => route.abort("failed"));
      await search("5555555555");
      await expectState("error");
      assert.match(
        await page.locator("#result-description").innerText(),
        /تعذر الاتصال حالياً/,
      );
      assert.equal(await page.locator("#search-button").isEnabled(), true);
      await page.unroute(routePattern);
    });
    await test("Duplicate requests prevented; a changed input cancels stale results", async () => {
      let requestCount = 0;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      await page.route("**/pdfs/1234567890.pdf", async (route) => {
        requestCount += 1;
        await gate;
        await route
          .fulfill({
            status: 200,
            contentType: "application/pdf",
            body: samplePdf(),
          })
          .catch(() => {});
      });
      await field.fill("1234567890");
      await submit();
      await page.waitForFunction(
        () => document.getElementById("search-button").disabled,
      );
      await page.evaluate(() => {
        const form = document.getElementById("search-form");
        form.requestSubmit();
        form.requestSubmit();
      });
      assert.equal(requestCount, 1);
      assert.equal(await page.locator("#loading-state").isVisible(), true);
      await field.fill("9876543210");
      assert.equal(await page.locator("#search-button").isEnabled(), true);
      await submit();
      await page.waitForFunction(
        () =>
          document.getElementById("result-panel").dataset.state ===
            "not-found" && !document.getElementById("result-panel").hidden,
      );
      release();
      await page.unroute("**/pdfs/1234567890.pdf", { behavior: "wait" });
      await expectState("not-found");
      assert.equal(
        await page.locator("#download-link").getAttribute("href"),
        null,
      );
    });
    await test("Timeout restores controls and reports a connection error", async () => {
      const timeoutPage = await context.newPage();
      await timeoutPage.addInitScript(() => {
        const nativeTimeout = window.setTimeout;
        window.setTimeout = (callback, duration, ...args) =>
          nativeTimeout(callback, duration === 15000 ? 50 : duration, ...args);
      });
      await timeoutPage.route(routePattern, (route) =>
        new Promise((resolve) => setTimeout(resolve, 200))
          .then(() => route.abort())
          .catch(() => {}),
      );
      await timeoutPage.goto(origin + mount);
      await timeoutPage.locator("#national-id").fill("5555555555");
      await timeoutPage.locator("#search-button").click();
      await timeoutPage.waitForFunction(
        () => !document.getElementById("result-panel").hidden,
      );
      assert.match(
        await timeoutPage.locator("#result-description").innerText(),
        /تعذر الاتصال حالياً/,
      );
      assert.equal(
        await timeoutPage.locator("#search-button").isEnabled(),
        true,
      );
      await timeoutPage.close();
    });
    await test("Unsupported inline PDF has an accessible new-tab fallback", async () => {
      const mobile = await context.newPage();
      await mobile.addInitScript(() =>
        Object.defineProperty(navigator, "pdfViewerEnabled", { value: false }),
      );
      await mobile.goto(origin + mount);
      await mobile.locator("#national-id").fill("0123456789");
      await mobile.locator("#search-button").click();
      await mobile.locator("#view-button").click();
      assert.equal(await mobile.locator("#pdf-frame").isVisible(), false);
      assert.match(
        await mobile.locator("#viewer-message").innerText(),
        /تعذر عرض الشهادة داخل المتصفح/,
      );
      const popupEvent = mobile.waitForEvent("popup");
      await mobile.locator("#open-pdf-link").click();
      const popup = await popupEvent;
      assert.ok(popup.url().includes("/pdfs/0123456789.pdf"));
      await popup.close();
      await mobile.close();
    });
    await test("Mobile, tablet, desktop and reduced-motion layouts", async () => {
      await page.goto(origin + mount);
      for (const width of [320, 375, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
          `Overflow at ${width}px`,
        );
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: path.join(root, "test-results/mobile.png"),
        fullPage: true,
      });
      await page.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(
        await page.evaluate(
          () => getComputedStyle(document.documentElement).scrollBehavior,
        ),
        "auto",
      );
      await page.locator("summary").first().click();
      assert.equal(
        await page.locator("details").first().getAttribute("open"),
        "",
      );
    });
    await test("No personal-data persistence, query strings, external requests or JS exceptions", async () => {
      assert.equal(
        await page.evaluate(() => localStorage.length + sessionStorage.length),
        0,
      );
      assert.equal((await context.cookies()).length, 0);
      assert.equal(new URL(page.url()).search, "");
      assert.deepEqual(externalRequests, []);
      assert.deepEqual(exceptions, []);
    });
    console.log(
      `\n${passed} browser checks passed. Screenshots: test-results/`,
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});

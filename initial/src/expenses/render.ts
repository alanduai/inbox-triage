import type { Browser } from "playwright";
import type { Renderer } from "./types.js";

/**
 * Prints HTML (a receipt email, an invoice web page) to PDF in headless Chromium. Scripts are off
 * and every network request is refused, so a receipt email cannot run code or report that it was
 * opened; remote images simply stay blank.
 */
export class PdfRenderer implements Renderer {
  private browser: Browser | null = null;

  constructor(private readonly opts: { executablePath?: string } = {}) {}

  async htmlToPdf(html: string): Promise<Buffer> {
    if (!this.browser) {
      const { chromium } = await import("playwright");
      this.browser = await chromium.launch({ headless: true, executablePath: this.opts.executablePath });
    }
    const context = await this.browser.newContext({ javaScriptEnabled: false, offline: true });
    try {
      await context.route("**/*", (route) => (route.request().url().startsWith("data:") ? route.continue() : route.abort("blockedbyclient")));
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 20_000 });
      return await page.pdf({ format: "A4", printBackground: true, margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" } });
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (b) await b.close().catch(() => undefined);
  }
}

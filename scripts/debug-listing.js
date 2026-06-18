/**
 * scripts/debug-listing.js
 * インデックスページの生HTMLをファイルに保存するデバッグ用スクリプト。
 * GitHub Actions の artifact で確認する。
 */

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");

puppeteer.use(StealthPlugin());

const LISTING_URL = "https://ana-slo.com/ホールデータ/東京都/楽園アメ横店-データ一覧/";
const OUT_DIR = path.join(__dirname, "../debug-output");

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8" });

  console.log("Navigating to:", LISTING_URL);
  const response = await page.goto(LISTING_URL, { waitUntil: "networkidle2", timeout: 30000 });
  console.log("HTTP status:", response.status());

  // Cloudflare チャレンジ通過を最大 15 秒待機
  await page
    .waitForFunction(() => !document.title.includes("Just a moment"), { timeout: 15000 })
    .catch(() => console.warn("[CF] challenge may not have passed"));

  const title   = await page.title();
  const html    = await page.content();
  const bodyTxt = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || "");

  console.log("Page title:", title);
  console.log("HTML length:", html.length);
  console.log("--- body text (first 2000 chars) ---");
  console.log(bodyTxt);
  console.log("------------------------------------");

  // .date-table セレクタの有無を確認
  const rowCount = await page.evaluate(() =>
    document.querySelectorAll(".date-table .table-row").length
  );
  console.log(".date-table .table-row count:", rowCount);

  // リンク付き日付行を確認
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".date-table .table-row"))
      .map(row => {
        const cells = row.querySelectorAll(".table-data-cell");
        if (cells.length < 3) return null;
        const link = cells[0].querySelector("a");
        if (!link) return null;
        const avgDiff = cells[2]?.textContent?.trim();
        return { href: link.href, avgDiff };
      })
      .filter(Boolean)
      .slice(0, 10)
  );
  console.log("Sample day links (first 10):", JSON.stringify(links, null, 2));

  // HTML を artifact 用に保存
  fs.writeFileSync(path.join(OUT_DIR, "listing.html"), html, "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "body-text.txt"), bodyTxt, "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "links.json"), JSON.stringify(links, null, 2), "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "meta.json"), JSON.stringify({
    url: LISTING_URL,
    status: response.status(),
    title,
    htmlLength: html.length,
    rowCount,
    timestamp: new Date().toISOString(),
  }, null, 2), "utf8");

  console.log("Saved to debug-output/");
  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });

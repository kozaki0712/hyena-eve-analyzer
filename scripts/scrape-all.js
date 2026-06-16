/**
 * scripts/scrape-all.js
 * data/halls-config.json に記載されたホールを全てスクレイピングし、
 * data/halls/{key}.json として保存する。
 * GitHub Actions から呼ばれる。
 */

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");

puppeteer.use(StealthPlugin());

const CONFIG_PATH = path.join(__dirname, "../data/halls-config.json");
const OUTPUT_DIR  = path.join(__dirname, "../data/halls");
const MAX_DAYS    = 365;

// ── Cloudflareチャレンジ通過待機 ───────────────────────────────
async function waitForCF(page, ms = 12000) {
  await page
    .waitForFunction(() => !document.title.includes("Just a moment"), { timeout: ms })
    .catch(() => console.warn("  [CF] challenge may not have passed, proceeding..."));
}

// ── ページ設定 ─────────────────────────────────────────────────
async function setupPage(page, referer = null) {
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  const headers = { "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8" };
  if (referer) headers["Referer"] = referer;
  await page.setExtraHTTPHeaders(headers);
}

// ── 1ホールのスクレイピング ────────────────────────────────────
async function scrapeHall(browser, slug, maxDays) {
  const listingUrl = `https://ana-slo.com/${slug}/`;
  console.log(`  Listing: ${listingUrl}`);

  const page = await browser.newPage();
  try {
    // Step1: インデックスページ（CFクッキー取得）
    await setupPage(page);
    await page.goto(listingUrl, { waitUntil: "networkidle2", timeout: 30000 });
    await waitForCF(page);

    // Step2: データあり日付リンクを収集
    const dayLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".date-table .table-row"))
        .map(row => {
          const cells = row.querySelectorAll(".table-data-cell");
          if (cells.length < 3) return null;
          const link = cells[0].querySelector("a");
          if (!link) return null;
          const avgDiff = cells[2]?.textContent?.trim();
          const hasData = avgDiff && avgDiff !== "–" && avgDiff !== "-";
          return hasData ? { href: link.href } : null;
        })
        .filter(Boolean)
    );

    console.log(`  ${dayLinks.length} days with data, scraping ${Math.min(dayLinks.length, maxDays)}`);

    // Step3: 各日付ページを巡回
    const allRecords = [];
    for (const day of dayLinks.slice(0, maxDays)) {
      const dateMatch = day.href.match(/(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      const date = dateMatch[1];
      const dayOfMonth = parseInt(date.split("-")[2], 10);

      await setupPage(page, listingUrl);
      await page.goto(day.href, { waitUntil: "networkidle2", timeout: 30000 });
      await waitForCF(page, 8000);

      const records = await page.evaluate((date, dayOfMonth) => {
        const rows = Array.from(document.querySelectorAll("#all_data_table tbody tr"));
        if (rows.length === 0) return [];

        return rows.map(row => {
          const machineName = row.querySelector("td.fixed01")?.textContent?.trim();
          const machineId   = row.querySelector("td.table_cells:nth-child(2)")?.textContent?.trim();
          const gamesRaw    = row.querySelector("td.table_cells:nth-child(3)")?.textContent?.trim();
          const diffRaw     = row.querySelector("td.table_cells:nth-child(4)")?.textContent?.trim();
          const bbRaw       = row.querySelector("td.table_cells:nth-child(5)")?.textContent?.trim();
          const rbRaw       = row.querySelector("td.table_cells:nth-child(6)")?.textContent?.trim();

          if (!machineName || !machineId) return null;

          const games = parseInt(gamesRaw?.replace(/[,，]/g, ""), 10) || 0;
          const diff  = parseInt(diffRaw?.replace(/[+,，]/g, ""), 10);
          if (isNaN(diff)) return null;

          return {
            date, dayOfMonth, machineId, machineName,
            diff, games,
            bb: parseInt(bbRaw, 10) || 0,
            rb: parseInt(rbRaw, 10) || 0,
          };
        }).filter(Boolean);
      }, date, dayOfMonth);

      console.log(`    ${date}: ${records.length} records`);
      allRecords.push(...records);
    }

    return allRecords;
  } finally {
    await page.close();
  }
}

// ── メイン ─────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error("data/halls-config.json が見つかりません");
    process.exit(1);
  }

  const halls = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  if (!Array.isArray(halls) || halls.length === 0) {
    console.log("スクレイピング対象がありません");
    return;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  let success = 0, failed = 0;
  for (const hall of halls) {
    if (!hall.key || !hall.slug) {
      console.warn(`スキップ: key または slug が未設定 → ${JSON.stringify(hall)}`);
      continue;
    }
    console.log(`\n[${hall.name}] key=${hall.key}`);
    try {
      const records = await scrapeHall(browser, hall.slug, hall.days || MAX_DAYS);
      const outPath = path.join(OUTPUT_DIR, `${hall.key}.json`);
      fs.writeFileSync(outPath, JSON.stringify(records, null, 2), "utf8");
      console.log(`  ✅ ${records.length} records → ${outPath}`);
      success++;
    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
      failed++;
    }
  }

  await browser.close();
  console.log(`\n完了: ${success} 成功 / ${failed} 失敗`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });

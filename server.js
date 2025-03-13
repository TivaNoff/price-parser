const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { Cluster } = require("puppeteer-cluster");
const stringSimilarity = require("string-similarity");

const app = express();
const upload = multer({ dest: "uploads/" });
app.use(express.static("public"));

app.post("/parse", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.json({ error: "Файл не завантажено" });
  }

  const filePath = path.join(__dirname, req.file.path);
  const components = fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  console.time("Parsing Time");

  try {
    const results = await parseWithCluster(components);
    console.timeEnd("Parsing Time");

    fs.unlinkSync(filePath);
    res.json({ results });
  } catch (err) {
    console.timeEnd("Parsing Time");
    fs.unlinkSync(filePath);
    res.json({ error: err.message || "Помилка при парсингу" });
  }
});

async function parseWithCluster(components) {
  // Описываем список сайтов и селекторы
  const sites = [
    {
      name: "Server-Shop",
      url: (c) => `https://server-shop.ua/search.html?query=${encodeURIComponent(c)}`,
      selectors: {
        container: ".catalog_block",
        item: ".item",
        name: ".title_wrap",
        price: ".price_text",
      },
    },
    {
      name: "Servak",
      url: (c) => `https://servak.com.ua/ua/search/?search=${encodeURIComponent(c)}`,
      selectors: {
        container: ".container",
        item: ".product-thumb",
        name: ".h4",
        price: ".price",
      },
    },
    {
      name: "HWF",
      url: (c) => `https://hwf.com.ua/katalog/search/?q=${encodeURIComponent(c)}`,
      selectors: {
        container: ".catalogGrid",
        item: ".catalog-grid__item",
        name: ".catalogCard-title",
        price: ".catalogCard-price",
      },
    },
    {
      name: "HardKiev",
      url: (c) => `https://hard.kiev.ua/search/?query=${encodeURIComponent(c)}`,
      selectors: {
        container: ".thumbs",
        item: "tr",
        name: "h5",
        price: ".price",
      },
    },
    {
      name: "serverparts",
      url: (c) => `https://serverparts.com.ua/search/?search=${encodeURIComponent(c)}`,
      selectors: {
        container: ".row-flex",
        item: ".product-thumb",
        name: ".product-name",
        price: ".price_value",
      },
    },
  ];

  // Запускаем кластер
  const cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_PAGE, // или CONCURRENCY_CONTEXT – на вкус
    maxConcurrency: 100, // ставьте столько, сколько тянет ваш сервер
    puppeteerOptions: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    },
  });

  // Описываем общую задачу, которая выполняется для каждого { component, site }
  await cluster.task(async ({ page, data }) => {
    const { component, site } = data;

    // Отключаем все ресурсы, кроме главного документа
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.resourceType() === "document") {
        req.continue();
      } else {
        req.abort();
      }
    });

    // Ставим User-Agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/91.0.4472.124 Safari/537.36"
    );

    // Переходим на страницу (минимальное ожидание, чтобы ускориться)
    await page.goto(site.url(component), { waitUntil: "domcontentloaded" });

    // Пытаемся дождаться контейнера 100 мс
    await page.waitForSelector(site.selectors.container, { timeout: 100 }).catch(() => null);

    // Собираем товары
    const productItems = await page.evaluate(({ selectors }) => {
      const items = document.querySelectorAll(selectors.item);
      if (!items.length) return [];

      return Array.from(items).map((item) => {
        const name = item.querySelector(selectors.name)?.innerText.trim() || "";
        const price = item.querySelector(selectors.price)?.innerText.trim() || "Ціна не знайдена";
        const link = item.querySelector("a")?.href || "Посилання не знайдено";
        return { name, price, link };
      });
    }, { selectors: site.selectors });

    // Возвращаем собранные товары
    return { component, siteName: site.name, productItems };
  });

  // Готовим общий список задач
  const tasks = [];
  for (const component of components) {
    for (const site of sites) {
      tasks.push({ component, site });
    }
  }

  // Запускаем все задачи параллельно (сколько позволит maxConcurrency)
  const rawResults = await Promise.all(
    tasks.map(task => cluster.execute(task))
  );

  // После получения всех результатов разбираем их и ищем лучший match
  const groupedResults = {}; 
  for (const item of rawResults) {
    const { component, siteName, productItems } = item;

    if (!groupedResults[component]) {
      groupedResults[component] = [];
    }

    // Если товары не найдены, сразу пушим "Товар не знайдено"
    if (!productItems || !productItems.length) {
      groupedResults[component].push({
        site: siteName,
        name: "Товар не знайдено",
        price: "Ціна не знайдена",
        link: "Посилання не знайдено",
      });
      continue;
    }

    // Ищем максимально похожий вариант
    let bestMatch = null;
    let bestSimilarity = 0;

    productItems.forEach((prod) => {
      const sim = stringSimilarity.compareTwoStrings(
        component.toLowerCase(),
        prod.name.toLowerCase()
      );
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestMatch = prod;
      }
    });

    if (bestMatch && bestSimilarity > 0.35) {
      groupedResults[component].push({
        site: siteName,
        name: bestMatch.name,
        price: bestMatch.price,
        link: bestMatch.link,
      });
    } else {
      groupedResults[component].push({
        site: siteName,
        name: "Товар не знайдено",
        price: "Ціна не знайдена",
        link: "Посилання не знайдено",
      });
    }
  }

  // Приводим к нужному формату: [{ name: '...', results: [...] }, ...]
  const finalResults = Object.entries(groupedResults).map(([component, prices]) => {
    return {
      name: component,
      results: prices
    };
  });

  await cluster.idle();
  await cluster.close();
  return finalResults;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер працює на порту ${PORT}`));

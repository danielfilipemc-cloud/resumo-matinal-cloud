import { writeFile } from "node:fs/promises";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const USE_OPENAI = process.env.USE_OPENAI !== "false";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TIMEZONE = "Europe/Lisbon";
const MAX_TELEGRAM_CHARS = 3500;
const GOOGLE_NEWS_LOCALE = "hl=pt-PT&gl=PT&ceid=PT:pt-150";

const REQUIRED_ENV = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];

for (const name of REQUIRED_ENV) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

if (!shouldRunNow()) {
  console.log("Skipping send because local Lisbon time is not 08:00.");
  process.exit(0);
}

const todayLabel = new Intl.DateTimeFormat("pt-PT", {
  dateStyle: "full",
  timeZone: TIMEZONE,
}).format(new Date());

const feeds = [
  {
    key: "markets_macro",
    title: "Mercados e macro",
    urls: [
      `https://news.google.com/rss/search?q=macroeconomia+mercados+bancos+centrais+inflacao+juros+energia+commodities&${GOOGLE_NEWS_LOCALE}`,
      `https://news.google.com/rss/search?q=Reuters+mercados+Fed+BCE+inflacao+tarifas+petroleo&${GOOGLE_NEWS_LOCALE}`,
    ],
  },
  {
    key: "geopolitics",
    title: "Geopolitica",
    urls: [
      `https://news.google.com/rss/search?q=Reuters+geopolitica+guerra+sancoes+shipping+petroleo+gas+cadeia+abastecimento&${GOOGLE_NEWS_LOCALE}`,
      `https://news.google.com/rss/search?q=Mar+Vermelho+Mar+Negro+Ormuz+shipping+petroleo+Reuters&${GOOGLE_NEWS_LOCALE}`,
    ],
  },
  {
    key: "trump",
    title: "Trump / Truth Social",
    urls: [
      `https://news.google.com/rss/search?q=Donald+Trump+Truth+Social+mercados+tarifas+Reuters&${GOOGLE_NEWS_LOCALE}`,
      `https://news.google.com/rss/search?q=Donald+Trump+politica+mercados+Reuters&${GOOGLE_NEWS_LOCALE}`,
    ],
  },
  {
    key: "crypto",
    title: "Cripto e regulacao",
    urls: [
      `https://news.google.com/rss/search?q=bitcoin+ethereum+solana+regulacao+cripto+SEC+ETF+Reuters&${GOOGLE_NEWS_LOCALE}`,
      `https://news.google.com/rss/search?q=regulacao+criptomoedas+mercados+Reuters&${GOOGLE_NEWS_LOCALE}`,
    ],
  },
];

const coinGeckoIds = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  ADA: "cardano",
  INJ: "injective-protocol",
};

async function main() {
  const [newsBySection, prices] = await Promise.all([
    collectNews(),
    fetchCryptoPrices(),
  ]);

  const payload = {
    generated_at: new Date().toISOString(),
    timezone: TIMEZONE,
    date_label: todayLabel,
    sections: newsBySection,
    prices,
  };

  await writeFile("summary-payload.json", JSON.stringify(payload, null, 2), "utf8");

  const summary = await buildSummary(payload);
  await writeFile("summary-output.txt", summary, "utf8");

  const chunks = splitForTelegram(summary, MAX_TELEGRAM_CHARS);
  const results = [];

  for (const chunk of chunks) {
    const result = await sendTelegramMessage(chunk);
    results.push(result);
  }

  console.log(JSON.stringify({ ok: true, parts: results.length, results }, null, 2));
}

function shouldRunNow() {
  if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    return true;
  }

  const hourText = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hour12: false,
    timeZone: TIMEZONE,
  }).format(new Date());

  return hourText === "08";
}

async function collectNews() {
  const entries = {};

  for (const feed of feeds) {
    const items = [];
    for (const url of feed.urls) {
      try {
        const rss = await fetchText(url);
        const parsed = parseRssItems(rss).slice(0, 5);
        for (const item of parsed) {
          items.push({
            ...item,
            source_feed: url,
          });
        }
      } catch (error) {
        items.push({
          title: `Erro ao recolher feed: ${String(error.message || error)}`,
          link: url,
          pubDate: "",
          source: "local-fetch-error",
        });
      }
    }

    entries[feed.key] = dedupeByTitle(items).slice(0, 8);
  }

  return entries;
}

async function fetchCryptoPrices() {
  const ids = Object.values(coinGeckoIds).join(",");
  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}` +
    "&vs_currencies=usd&include_24hr_change=true";

  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`CoinGecko request failed with ${response.status}`);
  }

  const json = await response.json();

  return Object.entries(coinGeckoIds).map(([symbol, id]) => {
    const price = json[id]?.usd;
    const change = json[id]?.usd_24h_change;
    return {
      symbol,
      price_usd: typeof price === "number" ? price : null,
      change_24h_pct: typeof change === "number" ? change : null,
      direction:
        typeof change === "number"
          ? change > 0
            ? "Subida"
            : change < 0
              ? "Descida"
              : "Estavel"
          : "Indisponivel",
    };
  });
}

async function generateSummary(payload) {
  const system = [
    "Escreve em portugues europeu.",
    "Produz um resumo curto, direto e orientado a mercados.",
    "Prioriza: Acao imediata, Criptomoedas, Mercados e macro, Geopolitica, Trump/Truth Social.",
    "Para cada noticia, explica em uma ou duas frases porque importa.",
    "Assinala incertezas e falta de confirmacao quando aplicavel.",
    "Nao inventes agenda nem emails.",
    "A seccao Criptomoedas deve incluir uma tabela compacta em texto simples.",
    "Nao incluas links no texto final.",
    "Usa portugues europeu natural e conciso.",
  ].join(" ");

  const user = [
    `Data local: ${payload.date_label}.`,
    "Com base nos dados abaixo, prepara o resumo final.",
    "Se houver poucos sinais crediveis sobre Truth Social no proprio dia, diz isso explicitamente.",
    "Termina sem saudacao extra.",
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: [{ type: "input_text", text: system }] },
        { role: "user", content: [{ type: "input_text", text: user }] },
      ],
      text: { format: { type: "text" } },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed with ${response.status}: ${errorText}`);
  }

  const json = await response.json();
  const outputText = extractOutputText(json);

  if (!outputText) {
    throw new Error("OpenAI response did not contain output text.");
  }

  return outputText.trim();
}

async function buildSummary(payload) {
  if (!USE_OPENAI) {
    return buildFallbackSummary(payload, new Error("OpenAI disabled by configuration"));
  }

  if (!OPENAI_API_KEY) {
    return buildFallbackSummary(payload, new Error("OpenAI API key missing"));
  }

  try {
    return await generateSummary(payload);
  } catch (error) {
    console.warn(`OpenAI summary failed, using fallback: ${String(error.message || error)}`);
    return buildFallbackSummary(payload, error);
  }
}

function buildFallbackSummary(payload, cause) {
  const lines = [];
  lines.push(`Resumo matinal | ${payload.date_label}`);
  lines.push("");
  lines.push("Acao imediata");
  lines.push(
    `- A sintese OpenAI falhou nesta execucao (${String(cause.message || cause)}). O resumo abaixo foi gerado em modo de contingencia.`,
  );
  lines.push("- Validar principais temas de macro, geopolitica e cripto antes de decisoes de risco maiores.");
  lines.push("");
  lines.push("Criptomoedas");
  lines.push("Ativo | Preco USD | 24h % | Direcao");
  lines.push("---|---:|---:|---");

  for (const item of payload.prices) {
    const price =
      typeof item.price_usd === "number" ? formatPrice(item.price_usd) : "n/d";
    const change =
      typeof item.change_24h_pct === "number" ? `${item.change_24h_pct.toFixed(2)}%` : "n/d";
    lines.push(`${item.symbol} | ${price} | ${change} | ${item.direction}`);
  }

  lines.push("");
  lines.push("Mercados e macro");
  lines.push(...formatNewsSection(payload.sections.markets_macro));
  lines.push("");
  lines.push("Geopolitica");
  lines.push(...formatNewsSection(payload.sections.geopolitics));
  lines.push("");
  lines.push("Trump / Truth Social");
  lines.push(...formatNewsSection(payload.sections.trump));
  lines.push("");
  lines.push("Cripto e regulacao");
  lines.push(...formatNewsSection(payload.sections.crypto));

  return lines.join("\n").trim();
}

function extractOutputText(json) {
  if (typeof json.output_text === "string" && json.output_text.trim()) {
    return json.output_text;
  }

  if (!Array.isArray(json.output)) {
    return "";
  }

  const texts = [];

  for (const item of json.output) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        texts.push(content.text);
      }
    }
  }

  return texts.join("\n").trim();
}

async function sendTelegramMessage(text) {
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        chat_id: TELEGRAM_CHAT_ID,
        text,
      }),
    },
  );

  const json = await response.json();

  if (!response.ok || !json.ok) {
    throw new Error(`Telegram send failed: ${JSON.stringify(json)}`);
  }

  return {
    message_id: json.result?.message_id,
    date: json.result?.date,
  };
}

function splitForTelegram(text, limit) {
  if (text.length <= limit) {
    return [text];
  }

  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (paragraph.length <= limit) {
      current = paragraph;
      continue;
    }

    let remaining = paragraph;
    while (remaining.length > limit) {
      chunks.push(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
    }
    current = remaining;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.map((chunk, index) =>
    chunks.length === 1 ? chunk : `[Parte ${index + 1}/${chunks.length}]\n${chunk}`,
  );
}

function formatPrice(value) {
  if (value >= 1000) {
    return value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  if (value >= 1) {
    return value.toFixed(2);
  }

  return value.toFixed(4);
}

function formatNewsSection(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return ["- Sem itens disponiveis nesta execucao."];
  }

  return items.slice(0, 4).map((item) => {
    const source = item.source ? ` [${item.source}]` : "";
    return `- ${item.title}${source}`;
  });
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "daily-market-brief/1.0",
      accept: "application/rss+xml, application/xml, text/xml, text/plain",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.text();
}

function parseRssItems(xml) {
  const items = [];
  const matches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);

  for (const match of matches) {
    const block = match[1];
    items.push({
      title: decodeXml(getTag(block, "title")),
      link: decodeXml(getTag(block, "link")),
      pubDate: decodeXml(getTag(block, "pubDate")),
      source: decodeXml(getTag(block, "source")),
    });
  }

  return items.filter((item) => item.title);
}

function getTag(block, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = block.match(regex);
  return match ? stripCdata(match[1].trim()) : "";
}

function stripCdata(value) {
  return value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function dedupeByTitle(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.title.toLowerCase();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

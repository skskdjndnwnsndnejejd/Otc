/**
 * Gift Castle v3 — Luxury Escrow Bot
 * Full file. Place in project root. Requires .env with BOT_TOKEN, OWNER_ID, PHOTO_ID, PORT.
 *
 * Features:
 * - Multilanguage (ru/en/ar)
 * - Single photo used in each message (editMessageMedia)
 * - Animated startup sequence after language choice
 * - Seller flow: choose type, title, description, price by inline keypad (0-9 , ↩️)
 * - Buyer flow: enter deal ID, view card, confirm buy -> escrow internal lock
 * - Escrow internal: balances.json holds free balances; locked funds held in deals
 * - /givebalance [id] [amount] allowed only for OWNER_ID (silently ignored for others)
 * - Logs of completed deals to owner and data/logs.json
 * - All user state and data in data/*.json
 *
 * Ensure data/ and locales/ exist as provided. Deploy on Render with polling.
 */

import fs from "fs-extra";
import express from "express";
import dotenv from "dotenv";
import { Telegraf, Markup } from "telegraf";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = Number(process.env.OWNER_ID || 0);
const PHOTO_ID = process.env.PHOTO_ID;
const PORT = Number(process.env.PORT || 10000);

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN not set in env. Exiting.");
  process.exit(1);
}

const app = express();
app.use(express.json());

const bot = new Telegraf(BOT_TOKEN);

// Data file paths
const DATA_DIR = "./data";
const USERS_FILE = `${DATA_DIR}/users.json`;
const BALANCES_FILE = `${DATA_DIR}/balances.json`;
const DEALS_FILE = `${DATA_DIR}/deals.json`;
const LOGS_FILE = `${DATA_DIR}/logs.json`;

// Ensure data directory and files
await fs.ensureDir(DATA_DIR);
if (!fs.existsSync(USERS_FILE)) await fs.writeJson(USERS_FILE, {});
if (!fs.existsSync(BALANCES_FILE)) await fs.writeJson(BALANCES_FILE, {});
if (!fs.existsSync(DEALS_FILE)) await fs.writeJson(DEALS_FILE, {});
if (!fs.existsSync(LOGS_FILE)) await fs.writeJson(LOGS_FILE, {});

// Load locales
const LOCALES_DIR = "./locales";
const RU = await fs.readJson(`${LOCALES_DIR}/ru.json`);
const EN = await fs.readJson(`${LOCALES_DIR}/en.json`);
const AR = await fs.readJson(`${LOCALES_DIR}/ar.json`);

// Utility: load/save
const loadJson = async (p) => (await fs.readJson(p).catch(() => ({})));
const saveJson = async (p, d) => await fs.writeJson(p, d, { spaces: 2 });

// Data caches (will be saved frequently)
let users = await loadJson(USERS_FILE);       // { userId: { lang, stage, temp, lastMsg } }
let balances = await loadJson(BALANCES_FILE); // { userId: number }
let deals = await loadJson(DEALS_FILE);       // { dealId: { id, seller, buyer, title, desc, type, price, status, locked } }
let logs = await loadJson(LOGS_FILE);         // { id: { ... } }

// Price buffer for inline keypad per user
const priceBuffers = {}; // { userId: "123,45" }

// Helper: save all changed data
async function persistAll() {
  await saveJson(USERS_FILE, users);
  await saveJson(BALANCES_FILE, balances);
  await saveJson(DEALS_FILE, deals);
  await saveJson(LOGS_FILE, logs);
}

// Helper: pick locale by userId
function L(userId) {
  const u = users[userId];
  const lang = u && u.lang ? u.lang : "en";
  if (lang === "ru") return RU;
  if (lang === "ar") return AR;
  return EN;
}

// Helper: generate next deal id in deterministic sequence A7342 -> A9999 -> B1000...
// We'll persist sequence in users._seq if not present
if (!users._seq) {
  users._seq = { letter: "A", number: 7342 };
  await saveJson(USERS_FILE, users);
}
function nextDealId() {
  let { letter, number } = users._seq;
  const id = `#${letter}${number}`;
  number++;
  if (number > 9999) {
    // move letter forward to next char
    const nextChar = String.fromCharCode(letter.charCodeAt(0) + 1);
    users._seq.letter = nextChar;
    users._seq.number = 1000;
    if (nextChar > "Z") {
      users._seq.letter = "A";
      users._seq.number = 1000;
    }
  } else {
    users._seq.number = number;
  }
  fs.writeJsonSync(USERS_FILE, users, { spaces: 2 });
  return id;
}

// Unicode styling helpers
const U = {
  title: (s) => `𝗚𝗶𝗳𝘁 𝗖𝗮𝘀𝘁𝗹𝗲 • ${s}`,
  bold: (s) => `**${s}**`, // some places use markdown-like markers for readability
  semibold: (s) => s, // we will use unicode characters inline where needed
};

// Ensure every message has 20+ words: we'll produce rich templates in locales; helper below ensures filler if needed
function ensureLong(text) {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words >= 20) return text;
  // add polite filler in the same language (we will append general phrase from EN)
  return text + "\n\n" + "💬 Мы всегда рядом, чтобы помочь с безопасной и прозрачной сделкой, сопровождение с момента создания до завершения.";
}

// Format date
function formatDateISO(d = new Date()) {
  return d.toISOString().replace("T", " ").split(".")[0] + " UTC";
}

// Compose media edit options (photo remains constant)
function mediaEditOptions(chatId, messageId, caption, buttons) {
  const media = {
    type: "photo",
    media: PHOTO_ID,
    caption,
    parse_mode: "HTML"
  };
  const extra = { reply_markup: { inline_keyboard: buttons } };
  return { chat_id: chatId, message_id: messageId, media, extra };
}

// Compose buttons: helper to map arrays to inline keyboard
function makeInline(keys) {
  // keys: array of arrays of { text, cb }
  return keys.map((row) => row.map((k) => Markup.button.callback(k.text, k.cb)));
}

// Function to edit message media safely
async function editMessageWithPhoto(ctxOrChatId, messageId, caption, buttons) {
  // ctxOrChatId may be ctx (with callbackQuery) or chatId
  try {
    // if ctx available and callback query, use ctx.editMessageMedia
    if (typeof ctxOrChatId === "object" && ctxOrChatId.callbackQuery) {
      const ctx = ctxOrChatId;
      const message = ctx.callbackQuery.message;
      await ctx.answerCbQuery().catch(() => {});
      await bot.telegram.editMessageMedia(
        message.chat.id,
        message.message_id,
        undefined,
        { type: "photo", media: PHOTO_ID, caption, parse_mode: "HTML" },
        { reply_markup: { inline_keyboard: buttons } }
      );
      return;
    } else {
      // ctxOrChatId is { chatId }
      const chatId = ctxOrChatId;
      // send new photo if no messageId
      await bot.telegram.sendPhoto(chatId, PHOTO_ID, {
        caption,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons }
      });
    }
  } catch (err) {
    console.error("editMessageWithPhoto error:", err?.description || err?.message || err);
  }
}

// Express simple status route
app.get("/", async (req, res) => {
  const activeDeals = Object.values(deals).filter((d) => d.status && d.status !== "done").length;
  const totalLocked = Object.values(deals).reduce((acc, d) => acc + (Number(d.locked || 0)), 0);
  res.send(`Gift Castle v3 — running. Active deals: ${activeDeals}. Total locked TON: ${totalLocked}`);
});

// ---------- BOT BEHAVIOR ----------

// /start -> show language selection photo with inline buttons
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  users[ctx.from.id] = users[ctx.from.id] || {};
  users[ctx.from.id].lang = users[ctx.from.id].lang || null;
  users[ctx.from.id].stage = "choose_lang";
  await saveJson(USERS_FILE, users);

  const caption = "<b>🌐 Choose language / Выберите язык / اختر لغتك</b>\n\n" +
    "Please select your preferred language to continue. Select the language that feels most comfortable for you and we will present the interface and instructions accordingly.";

  const buttons = [
    [{ text: "🇷🇺 Русский", cb: "lang_ru" }, { text: "🇬🇧 English", cb: "lang_en" }],
    [{ text: "🇸🇦 العربية", cb: "lang_ar" }]
  ].map(row => row.map(b => Markup.button.callback(b.text, b.cb)));

  // send photo with inline keyboard
  try {
    await bot.telegram.sendPhoto(chatId, PHOTO_ID, {
      caption,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (err) {
    console.error("/start sendPhoto error:", err);
  }
});

// Callback handling for many actions
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userId = ctx.from.id;
  users[userId] = users[userId] || {};
  const u = users[userId];

  // Language selection
  if (data === "lang_ru" || data === "lang_en" || data === "lang_ar") {
    const lang = data === "lang_ru" ? "ru" : data === "lang_en" ? "en" : "ar";
    u.lang = lang;
    u.stage = "loading_animation";
    await saveJson(USERS_FILE, users);

    // Animated loading: sequence of edits with short delays
    const seq = [
      { text: lang === "ru" ? "🌍 𝐙𝐚𝐠𝐫𝐮𝐳𝐤𝐚 𝐈𝐧𝐭𝐞𝐫𝐟𝐞𝐢𝐬𝐚..." : lang === "en" ? "🌍 𝐋𝐨𝐚𝐝𝐢𝐧𝐠 𝐆𝐢𝐟𝐭 𝐂𝐚𝐬𝐭𝐥𝐞 𝐈𝐧𝐭𝐞𝐫𝐟𝐚𝐜𝐞..." : "🌍 𝐉𝐚𝐫𝐲 𝐟𝐢𝐥 𝐢𝐧𝐭𝐞𝐫𝐟𝐚𝐜𝐞..." , wait: 800 },
      { text: lang === "ru" ? "✨ 𝗜𝗻𝗶𝘁𝗶𝗮𝗹𝗶𝘇𝘂ем 𝘀𝘆𝘀𝘁𝗲𝗺 𝘇𝗮щ𝗶𝘁ы..." : lang === "en" ? "✨ 𝗜𝗻𝗶𝘁𝗶𝗮𝗹𝗶𝘇𝗶𝗻𝗴 𝗲𝘀𝗰𝗿𝗼𝘄 𝘀𝘆𝘀𝘁𝗲𝗺..." : "✨ 𝗧𝗼𝗹𝗶𝗽 𝗶𝗻𝗶𝘁𝗶𝗮𝗹..." , wait: 900 },
      { text: lang === "ru" ? "💎 𝗕𝗮𝗴𝗮𝗷  𝗚𝗶𝗳𝘁 𝗖𝗮𝘀𝘁𝗹𝗲 — 𝗴𝗼𝘁𝗼𝘃𝗼!" : lang === "en" ? "💎 𝗪𝗲𝗹𝗰𝗼𝗺𝗲 𝘁𝗼 𝗚𝗶𝗳𝘁 𝗖𝗮𝘀𝘁𝗹𝗲!" : "💎 𝗪𝗲𝗹𝗰𝗼𝗺𝗲 𝗯𝗮𝗯!" , wait: 1000 }
    ];

    // First, create a loading caption and edit the message sequentially
    try {
      // edit the same message caption three times
      for (const s of seq) {
        await bot.telegram.editMessageMedia(
          ctx.callbackQuery.message.chat.id,
          ctx.callbackQuery.message.message_id,
          undefined,
          { type: "photo", media: PHOTO_ID, caption: `<b>${s.text}</b>`, parse_mode: "HTML" },
          { reply_markup: { inline_keyboard: [] } }
        );
        await new Promise((r) => setTimeout(r, s.wait));
      }
    } catch (err) {
      console.error("Animation error:", err);
    }

    // After animation, show main menu
    u.stage = "menu";
    await saveJson(USERS_FILE, users);

    const locale = L(userId);
    const welcome = (locale.welcome || EN.welcome || RU.welcome).replace("{username}", ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name);
    const caption = ensureLong(welcome);

    const keyboard = [
      [Markup.button.callback("💼 Создать сделку", "create_deal"), Markup.button.callback("🛍 Войти в сделку", "join_deal")],
      [Markup.button.callback("💰 Баланс", "show_balance"), Markup.button.callback("🆘 Помощь", "help_contact")],
      [Markup.button.callback("⚙️ Настройки", "settings")]
    ];

    try {
      await bot.telegram.editMessageMedia(
        ctx.callbackQuery.message.chat.id,
        ctx.callbackQuery.message.message_id,
        undefined,
        { type: "photo", media: PHOTO_ID, caption, parse_mode: "HTML" },
        { reply_markup: { inline_keyboard: keyboard } }
      );
    } catch (err) {
      console.error("Show main menu edit error:", err);
    }

    return;
  } // end language selection

  // Main menu actions
  if (data === "create_deal") {
    users[userId].stage = "choose_type";
    await saveJson(USERS_FILE, users);
    const text = ensureLong(L(userId).seller_role || RU.seller_role);
    const kb = [
      [Markup.button.callback("NFT", "type_NFT"), Markup.button.callback("Цифровой товар", "type_digital")],
      [Markup.button.callback("Услуга", "type_service"), Markup.button.callback("Другое", "type_other")],
      [Markup.button.callback("⬅️ Назад", "menu_back")]
    ];
    await bot.telegram.editMessageMedia(
      ctx.callbackQuery.message.chat.id,
      ctx.callbackQuery.message.message_id,
      undefined,
      { type: "photo", media: PHOTO_ID, caption: text, parse_mode: "HTML" },
      { reply_markup: { inline_keyboard: kb } }
    );
    return;
  }

  if (data && data.startsWith("type_")) {
    const type = data.split("type_")[1];
    users[userId].stage = "enter_title";
    users[userId].temp = { type };
    await saveJson(USERS_FILE, users);
    const txt = ensureLong("🏰 𝗥𝗼𝗹𝗲: 𝗣𝗿𝗼𝗱𝘂𝗰𝗲𝗿 • Пожалуйста, введите название товара, используя краткую и информативную формулировку. Название должно содержать смысловую и уникальную часть, чтобы покупатель мог понять, за что платит.");
    await bot.telegram.editMessageMedia(
      ctx.callbackQuery.message.chat.id,
      ctx.callbackQuery.message.message_id,
      undefined,
      { type: "photo", media: PHOTO_ID, caption: txt, parse_mode: "HTML" },
      { reply_markup: { inline_keyboard: [[Markup.button.callback("⬅️ Отмена", "menu_back")]] } }
    );
    return;
  }

  if (data === "menu_back") {
    users[userId].stage = "menu";
    await saveJson(USERS_FILE, users);
    const welcome = ensureLong(L(userId).welcome.replace("{username}", ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name));
    const kb = [
      [Markup.button.callback("💼 Создать сделку", "create_deal"), Markup.button.callback("🛍 Войти в сделку", "join_deal")],
      [Markup.button.callback("💰 Баланс", "show_balance"), Markup.button.callback("🆘 Помощь", "help_contact")]
    ];
    await bot.telegram.editMessageMedia(
      ctx.callbackQuery.message.chat.id,
      ctx.callbackQuery.message.message_id,
      undefined,
      { type: "photo", media: PHOTO_ID, caption: welcome, parse_mode: "HTML" },
      { reply_markup: { inline_keyboard: kb } }
    );
    return;
  }

  // Price keypad handlers: num_0 .. num_9, num_dot, num_done, num_back
  if (data && data.startsWith("num_")) {
    const key = data.split("num_")[1]; // e.g., "1" or "dot" or "done"
    priceBuffers[userId] = priceBuffers[userId] || "";
    if (key === "done") {
      const raw = priceBuffers[userId] || "";
      const priceStr = raw.replace(",", ".").replace(/^,+|,+$/g, "");
      const priceVal = parseFloat(priceStr);
      if (!priceVal || isNaN(priceVal) || priceVal <= 0) {
        await ctx.answerCbQuery("Введите корректную сумму перед подтверждением.", { show_alert: true });
        return;
      }

      // finalize: create deal
      const temp = users[userId].temp || {};
      const id = nextDealId();
      const deal = {
        id,
        seller: userId,
        title: temp.title,
        desc: temp.desc,
        type: temp.type || "NFT",
        price: Number(priceVal.toFixed(8)), // TON precision
        status: "open",
        locked: 0,
        created_at: new Date().toISOString()
      };
      deals[id] = deal;
      await saveJson(DEALS_FILE, deals);

      // clear temp
      users[userId].stage = "menu";
      users[userId].temp = {};
      await saveJson(USERS_FILE, users);
      delete priceBuffers[userId];

      const caption = ensureLong(`<b>💎 Сделка ${id} успешно создана</b>\n\n<b>• Тип:</b> ${deal.type}\n<b>• Название:</b> <i>${deal.title}</i>\n<b>• Описание:</b> <i>${deal.desc}</i>\n<b>• Стоимость:</b> <b>${deal.price} TON</b>\n\nПожалуйста, передайте номер сделки покупателю для присоединения. Убедитесь, что вы сохранили этот код и ожидаете подтверждения со стороны покупателя.`);

      await bot.telegram.editMessageMedia(
        ctx.callbackQuery.message.chat.id,
        ctx.callbackQuery.message.message_id,
        undefined,
        { type: "photo", media: PHOTO_ID, caption, parse_mode: "HTML" },
        { reply_markup: { inline_keyboard: [[Markup.button.callback("🏠 В меню", "menu_back")]] } }
      );

      return;
    }

    if (key === "dot") {
      // allow comma once
      if (!priceBuffers[userId].includes(",")) priceBuffers[userId] += ",";
    } else if (key === "back") {
      priceBuffers[userId] = priceBuffers[userId].slice(0, -1);
    } else {
      // digit
      priceBuffers[userId] += key;
    }

    // show current buffer in caption
    const cur = priceBuffers[userId] || "0";
    const caption = ensureLong(`<b>💰 Ввод цены</b>\n\nИспользуйте цифровую клавиатуру ниже для точного ввода суммы в TON. Для дробных значений используйте запятую. Нажмите ↩️, когда сумма будет введена и вы готовы продолжить.\n\n<b>Текущая сумма: ${cur} TON</b>`);
    // redraw keypad
    const keypad = [
      [Markup.button.callback("1", "num_1"), Markup.button.callback("2", "num_2"), Markup.button.callback("3", "num_3")],
      [Markup.button.callback("4", "num_4"), Markup.button.callback("5", "num_5"), Markup.button.callback("6", "num_6")],
      [Markup.button.callback("7", "num_7"), Markup.button.callback("8", "num_8"), Markup.button.callback("9", "num_9")],
      [Markup.button.callback("0", "num_0"), Markup.button.callback(",", "num_dot"), Markup.button.callback("↩️", "num_done")],
      [Markup.button.callback("⬅️ Назад", "menu_back")]
    ];
    try {
      await bot.telegram.editMessageMedia(
        ctx.callbackQuery.message.chat.id,
        ctx.callbackQuery.message.message_id,
        undefined,
        { type: "photo", media: PHOTO_ID, caption, parse_mode: "HTML" },
        { reply_markup: { inline_keyboard: keypad } }
      );
    } catch (err) {
      console.error("price keypad edit error:", err);
    }
    return;
  } // end num_*

  // Join deal flow
  if (data === "join_deal") {
    users[userId].stage = "join_wait_id";
    await saveJson(USERS_FILE, users);
    const caption = ensureLong(L(userId).buyer_role);
    await bot.telegram.editMessageMedia(
      ctx.callbackQuery.message.chat.id,
      ctx.callbackQuery.message.message_id,
      undefined,
      { type: "photo", media: PHOTO_ID, caption, parse_mode: "HTML" },
      { reply_markup: { inline_keyboard: [[Markup.button.callback("⬅️ Назад", "menu_back")]] } }
    );
    return;
  }

  // When buyer views deal from inline menu
  if (data && data.startsWith("view_")) {
    const dealId = data.split("view_")[1];
    const deal = deals[dealId];
    if (!deal) {
      await ctx.answerCbQuery("Сделка не найдена.", { show_alert: true });
      return;
    }
    // Show deal card with actions
    const caption = ensureLong(`<b>💎 Сделка ${dealId}</b>\n\n<b>• Тип:</b> ${deal.type}\n<b>• Название:</b> <i>${deal.title}</i>\n<b>• Описание:</b> <i>${deal.desc}</i>\n<b>• Стоимость:</b> <b>${deal.price} TON</b>\n\nВы можете присоединиться к сделке и оплатить сумму, если ваш баланс достаточен. Средства будут заморожены в эскроу до подтверждения передачи товара продавцом.`);
    const kb = [
      [Markup.button.callback("✔️ Присоединиться и оплатить", `buy_${dealId}`), Markup.button.callback("❌ Отказаться", "menu_back")]
    ];
    await bot.telegram.editMessageMedia(
      ctx.callbackQuery.message.chat.id,
      ctx.callbackQuery.message.message_id,
      undefined,
      { type: "photo", media: PHOTO_ID, caption, parse_mode: "HTML" },
      { reply_markup: { inline_keyboard: kb } }
    );
    return;
  }

  // Buyer chooses to buy
  if (data && data.startsWith("buy_")) {
    const dealId = data.split("buy_")[1];
    const deal = deals[dealId];
    if (!deal) {
      await ctx.answerCbQuery("Сделка не найдена.", { show_alert: true });
      return;
    }
    if (deal.status !== "open") {
      await ctx.answerCbQuery("Сделка уже не доступна для покупки.", { show_alert: true });
      return;
    }
    const buyerId = userId;
    const bal = Number(balances[buyerId] || 0);
    const price = Number(deal.price || 0);

    if (bal < price) {
      await ctx.answerCbQuery("Недостаточно TON на балансе для совершения покупки. Пожалуйста, пополните баланс.", { show_alert: true });
      return;
    }

    // Deduct and lock funds in deal
    balances[buyerId] = Number((bal - price).toFixed(8));
    deal.buyer = buyerId;
    deal.locked = price;
    deal.status = "in_progress";
    deal.locked_at = new Date().toISOString();
    await saveJson(BALANCES_FILE, balances);
    await saveJson(DEALS_FILE, deals);

    // Notify buyer and seller
    const caption = ensureLong(`<b>🤝 Вы успешно присоединились к сделке ${dealId}.</b>\n\n<b>• Продавец:</b> ${deal.seller}\n<b>• Стоимость:</b> <b>${price} TON</b>\n\nСредства списаны с вашего баланса и находятся под защитой Gift Castle до подтверждения передачи товара. Ожидайте дальнейших инструкций от продавца.`);

    await bot.telegram.editMessageMedia(
      ctx.callbackQuery.message.chat.id,
      ctx.callbackQuery.message.message_id,
      undefined,
      { type: "photo", media: PHOTO_ID, caption, parse_mode: "HTML" },
      { reply_markup: { inline_keyboard: [[Markup.button.callback("📨 Связаться с поддержкой", "help_contact")]] } }
    );

    // Notify seller privately
    try {
      const sellerText = ensureLong(`<b>🔔 Уведомление продавцу</b>\n\nПокупатель присоединился к вашей сделке ${dealId}. Пожалуйста, передайте товар поддержке и подтвердите отправку товара через интерфейс бота как только это сделано. Не отправляйте товар напрямую без подтверждения. Если у вас возникли вопросы, свяжитесь с поддержкой.`);
      await bot.telegram.sendPhoto(deal.seller, PHOTO_ID, {
        caption: sellerText,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[Markup.button.callback("📦 Товар передан", `seller_sent_${dealId}`)]] }
      });
    } catch (err) {
      console.warn("Could not notify seller privately:", err?.message || err);
    }

    // update deals file
    await saveJson(DEALS_FILE, deals);
    return;
  }

  // Seller confirms product forwarded to support
  if (data && data.startsWith("seller_sent_")) {
    const dealId = data.split("seller_sent_")[1];
    const deal = deals[dealId];
    if (!deal) {
      await ctx.answerCbQuery("Сделка не найдена.", { show_alert: true });
      return;
    }
    deal.status = "sent_to_support";
    deal.sent_at = new Date().toISOString();
    await saveJson(DEALS_FILE, deals);

    // Notify buyer (if exists)
    if (deal.buyer) {
      try {
        const buyerText = ensureLong(`<b>📦 Продавец подтвердил передачу товара в поддержку</b>\n\nПожалуйста, подтвердите получение товара в боте, нажав кнопку «Я получил товар». Если вы подтверждаете получение — баланс продавца будет разблокирован и зачислен на его внутренний баланс.`);
        await bot.telegram.sendPhoto(deal.buyer, PHOTO_ID, {
          caption: buyerText,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[Markup.button.callback("✅ Я получил товар", `buyer_received_${dealId}`), Markup.button.callback("❌ Проблема", `buyer_problem_${dealId}`)]] }
        });
      } catch (err) {
        console.warn("Could not notify buyer:", err?.message || err);
      }
    }

    await ctx.answerCbQuery("Статус обновлён: товар передан в поддержку.");
    return;
  }

  // Buyer confirms received
  if (data && data.startsWith("buyer_received_")) {
    const dealId = data.split("buyer_received_")[1];
    const deal = deals[dealId];
    if (!deal) {
      await ctx.answerCbQuery("Сделка не найдена.", { show_alert: true });
      return;
    }
    if (!deal.buyer) {
      await ctx.answerCbQuery("Нет привязанного покупателя.", { show_alert: true });
      return;
    }
    // Transfer locked funds to seller balance
    const sellerId = deal.seller;
    const amount = Number(deal.locked || 0);
    balances[sellerId] = Number((Number(balances[sellerId] || 0) + amount).toFixed(8));
    deal.status = "done";
    deal.completed_at = new Date().toISOString();
    deal.locked = 0;
    await saveJson(BALANCES_FILE, balances);
    await saveJson(DEALS_FILE, deals);

    // Log and notify owner
    const logEntry = {
      id: dealId,
      seller: sellerId,
      buyer: deal.buyer,
      amount,
      title: deal.title,
      desc: deal.desc,
      completed_at: deal.completed_at
    };
    logs[dealId] = logEntry;
    await saveJson(LOGS_FILE, logs);

    const ownerMsg = ensureLong(`<b>⚜️ Gift Castle — Завершена сделка</b>\n\n✅ Сделка ${dealId} успешно завершена.\n\n<b>• Продавец:</b> ${sellerId}\n<b>• Покупатель:</b> ${deal.buyer}\n<b>• Сумма:</b> <b>${amount} TON</b>\n<b>• Название товара:</b> <i>${deal.title}</i>\n<b>• Дата завершения:</b> ${formatDateISO(new Date())}`);
    try {
      await bot.telegram.sendMessage(OWNER_ID, ownerMsg, { parse_mode: "HTML" });
    } catch (err) {
      console.warn("Could not send owner log message:", err?.message || err);
    }

    // Notify seller and buyer
    try {
      await bot.telegram.sendPhoto(sellerId, PHOTO_ID, {
        caption: ensureLong(`<b>✅ Сделка ${dealId} завершена. Средства успешно зачислены на ваш баланс.</b>\n\nПожалуйста, проверьте свой внутренний баланс в разделе «Баланс» и при необходимости свяжитесь с поддержкой.`),
        parse_mode: "HTML"
      });
    } catch {}
    try {
      await bot.telegram.sendPhoto(deal.buyer, PHOTO_ID, {
        caption: ensureLong(`<b>✅ Спасибо! Сделка ${dealId} завершена и может считаться закрытой. Мы рады, что вы остались довольны. Если есть жалобы — обратитесь в поддержку.</b>`),
        parse_mode: "HTML"
      });
    } catch {}

    return;
  }

  // Buyer reports problem
  if (data && data.startsWith("buyer_problem_")) {
    const dealId = data.split("buyer_problem_")[1];
    const deal = deals[dealId];
    if (!deal) {
      await ctx.answerCbQuery("Сделка не найдена.", { show_alert: true });
      return;
    }
    // notify owner and seller
    const msg = ensureLong(`<b>🚨 Проблема с сделкой ${dealId}</b>\n\nПокупатель отметил проблему при получении товара. Пожалуйста, свяжитесь с поддержкой для разрешения ситуации. Владелец уведомлён и рассмотрит спор.`);
    try {
      await bot.telegram.sendMessage(OWNER_ID, msg, { parse_mode: "HTML" });
    } catch {}
    try {
      await bot.telegram.sendMessage(deal.seller, msg, { parse_mode: "HTML" });
    } catch {}
    await ctx.answerCbQuery("Проблема отправлена в поддержку и владельцу.", { show_alert: true });
    return;
  }

  // Help contact
  if (data === "help_contact") {
    const msg = ensureLong(L(userId).help || RU.help || EN.help);
    await bot.telegram.editMessageMedia(
      ctx.callbackQuery.message.chat.id,
      ctx.callbackQuery.message.message_id,
      undefined,
      { type: "photo", media: PHOTO_ID, caption: msg, parse_mode: "HTML" },
      { reply_markup: { inline_keyboard: [[Markup.button.url("Связаться с поддержкой", "https://t.me/GiftCastleRelayer")], [Markup.button.callback("🏠 В меню", "menu_back")]] } }
    );
    return;
  }

  // show_balance
  if (data === "show_balance") {
    const bal = Number(balances[userId] || 0).toFixed(8);
    const caption = ensureLong(`<b>💼 Ваш баланс:</b> <b>${bal} TON</b>\n\nЭто внутренний баланс Gift Castle, используемый для участия в сделках и для быстрой безопасной блокировки средств при оплате. Для вывода средств обратитесь в поддержку.`);
    await bot.telegram.editMessageMedia(
      ctx.callbackQuery.message.chat.id,
      ctx.callbackQuery.message.message_id,
      undefined,
      { type: "photo", media: PHOTO_ID, caption, parse_mode: "HTML" },
      { reply_markup: { inline_keyboard: [[Markup.button.url("📤 Запросить вывод", "https://t.me/GiftCastleRelayer")], [Markup.button.callback("🏠 В меню", "menu_back")]] } }
    );
    return;
  }

  // default: ignore unknown callback
  await ctx.answerCbQuery().catch(() => {});
});

// Text message handler for flows: title, desc, join by ID, admin commands, /givebalance
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  users[userId] = users[userId] || { lang: "en", stage: "menu" };
  const u = users[userId];

  const text = ctx.message.text.trim();

  // Admin /givebalance command (in chat)
  if (text.startsWith("/givebalance")) {
    // command: /givebalance [id] [amount]
    const parts = text.split(/\s+/);
    if (Number(ctx.from.id) !== OWNER_ID) {
      // silently ignore for others
      return;
    }
    if (parts.length < 3) {
      return ctx.reply("Использование: /givebalance [user_id] [amount]");
    }
    const target = parts[1];
    const amt = Number(parts[2]);
    if (isNaN(amt)) return ctx.reply("Укажите корректную сумму.");
    balances[target] = Number((Number(balances[target] || 0) + amt).toFixed(8));
    await saveJson(BALANCES_FILE, balances);
    await ctx.reply(`✅ Баланс пользователя ${target} пополнен на ${amt} TON. Текущий баланс: ${balances[target]} TON`);
    try {
      await bot.telegram.sendMessage(target, `💰 Вам начислено ${amt} TON от Gift Castle. Текущий баланс: ${balances[target]} TON`);
    } catch {}
    return;
  }

  // also support /balance
  if (text === "/balance" || text.toLowerCase() === "баланс") {
    const bal = Number(balances[userId] || 0).toFixed(8);
    return ctx.replyWithPhoto(PHOTO_ID, { caption: ensureLong(`<b>💼 Ваш баланс:</b> <b>${bal} TON</b>\n\nИспользуйте средства для участия в сделках или обратитесь в поддержку.`), parse_mode: "HTML" });
  }

  // Flow: seller enters title
  if (u.stage === "enter_title" || u.stage === "create_title" || u.stage === "enter_title") {
    // text is title
    users[userId].temp = users[userId].temp || {};
    users[userId].temp.title = text;
    users[userId].stage = "enter_desc";
    await saveJson(USERS_FILE, users);
    const reply = ensureLong("📝 Отлично. Теперь, пожалуйста, введите подробное описание товара. Дайте полную и честную характеристику, включающую любые важные детали, чтобы покупатель имел полное представление о предмете сделки.");
    return ctx.replyWithPhoto(PHOTO_ID, { caption: reply, parse_mode: "HTML", reply_markup: { inline_keyboard: [[Markup.button.callback("⬅️ Отмена", "menu_back")]] } });
  }

  // Flow: seller enters description
  if (u.stage === "enter_desc") {
    users[userId].temp = users[userId].temp || {};
    users[userId].temp.desc = text;
    users[userId].stage = "enter_price";
    await saveJson(USERS_FILE, users);
    // show price keypad (initial)
    priceBuffers[userId] = "";
    const caption = ensureLong("💰 Пожалуйста, введите цену товара в TON с помощью цифровой клавиатуры ниже. Для ввода десятичной дроби используйте запятую. Нажмите ↩️, когда сумма будет введена корректно и вы готовы продолжить.");
    const keypad = [
      [Markup.button.callback("1", "num_1"), Markup.button.callback("2", "num_2"), Markup.button.callback("3", "num_3")],
      [Markup.button.callback("4", "num_4"), Markup.button.callback("5", "num_5"), Markup.button.callback("6", "num_6")],
      [Markup.button.callback("7", "num_7"), Markup.button.callback("8", "num_8"), Markup.button.callback("9", "num_9")],
      [Markup.button.callback("0", "num_0"), Markup.button.callback(",", "num_dot"), Markup.button.callback("↩️", "num_done")],
      [Markup.button.callback("⬅️ Отмена", "menu_back")]
    ];
    return ctx.replyWithPhoto(PHOTO_ID, { caption, parse_mode: "HTML", reply_markup: { inline_keyboard: keypad } });
  }

  // Flow: buyer entering deal id when stage join_wait_id
  if (u.stage === "join_wait_id") {
    const dealId = text.trim();
    if (!deals[dealId]) {
      return ctx.replyWithPhoto(PHOTO_ID, { caption: ensureLong(`❌ Сделка ${dealId} не найдена. Пожалуйста, проверьте идентификатор и введите его снова, либо обратитесь в поддержку для помощи.`), parse_mode: "HTML" });
    }
    // show deal details and view/join button
    const deal = deals[dealId];
    const caption = ensureLong(`<b>💎 Сделка ${dealId}</b>\n\n<b>• Тип:</b> ${deal.type}\n<b>• Название:</b> <i>${deal.title}</i>\n<b>• Описание:</b> <i>${deal.desc}</i>\n<b>• Стоимость:</b> <b>${deal.price} TON</b>\n\nЕсли вы хотите присоединиться к сделке и оплатить, нажмите кнопку ниже. Обратите внимание, что средства будут заморожены в эскроу до подтверждения получения товара.`);
    const kb = [[Markup.button.callback("✔️ Присоединиться и оплатить", `buy_${dealId}`)], [Markup.button.callback("⬅️ Назад", "menu_back")]];
    await ctx.replyWithPhoto(PHOTO_ID, { caption, parse_mode: "HTML", reply_markup: { inline_keyboard: kb } });
    users[userId].stage = "menu";
    await saveJson(USERS_FILE, users);
    return;
  }

  // Fallback: show main menu
  const welcome = ensureLong(L(userId).welcome.replace("{username}", ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name));
  await ctx.replyWithPhoto(PHOTO_ID, { caption: welcome, parse_mode: "HTML", reply_markup: { inline_keyboard: [[Markup.button.callback("💼 Создать сделку", "create_deal"), Markup.button.callback("🛍 Войти в сделку", "join_deal")], [Markup.button.callback("💰 Баланс", "show_balance")]] } });
});

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

// Start Express and Bot
app.listen(PORT, () => {
  console.log(`✅ Express server started on port ${PORT}`);
});
bot.launch().then(() => console.log("🤖 Gift Castle Bot launched (polling)")).catch(console.error);

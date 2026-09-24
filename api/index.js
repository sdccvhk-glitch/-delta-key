const express = require("express");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");
const { readStore, writeStore, hashAdminPassword } = require("../lib/store");

const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_ADMIN_CHAT_ID = String(process.env.TELEGRAM_ADMIN_CHAT_ID || "").trim();

const app = express();
const PUBLIC_DIR = path.join(__dirname, "..", "public");

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/admin", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin-login.html")));
app.get("/admin/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin-login.html")));
app.get("/admin/dashboard", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin-dashboard.html")));
app.get("/admin-login", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin-login.html")));
app.get("/admin-login.html", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin-login.html")));
app.get("/admin/dashboard.html", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin-dashboard.html")));
app.use(express.static(PUBLIC_DIR));

function verifyAdminPassword(password, stored) {
  try {
    const [salt, expectedHex] = String(stored || "").split(":");
    if (!salt || !expectedHex) return false;
    const actual = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(expectedHex, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function findPlan(product, planId) {
  return (product.plans || []).find(x => x.id === planId && x.active !== false);
}

function publicProduct(p) {
  return { ...p, plans: (p.plans || []).filter(x => x.active !== false) };
}

function publicOrder(order) {
  return {
    id: order.id,
    productId: order.productId,
    productName: order.productName,
    planId: order.planId,
    duration: order.duration,
    amount: order.amount,
    paymentReference: order.paymentReference || "",
    status: order.status,
    key: order.status === "paid" ? order.key : "",
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
}

async function adminAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || "";

    if (!auth.startsWith("Basic ")) {
      return res.status(401).json({ error: "Admin login required." });
    }

    let decoded = "";
    try {
      decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    } catch {}

    const split = decoded.indexOf(":");
    const user = split >= 0 ? decoded.slice(0, split) : "";
    const pass = split >= 0 ? decoded.slice(split + 1) : "";

    const store = await readStore();
    const expectedUser = store.adminCredentials?.username || process.env.ADMIN_USER || "admin";
    const passwordOk = verifyAdminPassword(pass, store.adminCredentials?.passwordHash);

    if (user !== expectedUser || !passwordOk) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    req.store = store;
    next();
  } catch (e) {
    console.error("Admin auth error:", e);
    res.status(500).json({ error: e.message || "Admin auth failed." });
  }
}

function allocateKey(store, productId, planId) {
  const pool = Array.isArray(store.keyPool) ? store.keyPool : [];
  const idx = pool.findIndex(item => {
    if (typeof item === "string") return true;
    return item.productId === productId && item.planId === planId;
  });
  if (idx < 0) return null;
  const item = pool.splice(idx, 1)[0];
  return typeof item === "string" ? item : item.key;
}

function fulfillPaidOrder(store, order, paymentId) {
  if (order.status === "paid" && order.key) return order;

  const key = allocateKey(store, order.productId, order.planId);
  if (!key) {
    throw new Error("No key is available for this product and duration.");
  }

  order.key = key;
  order.status = "paid";
  order.paymentReference = paymentId || order.paymentReference || "";
  order.paidAt = new Date().toISOString();
  order.updatedAt = order.paidAt;

  const product = store.products.find(p => p.id === order.productId);
  if (product) {
    product.stock = Math.max(0, Number(product.stock || 0) - 1);
  }

  return order;
}

function telegramEnabled() {
  return Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_ADMIN_CHAT_ID);
}

function telegramEscape(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function telegramApi(method, body) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Telegram returned HTTP ${response.status}.`);
  }

  if (!response.ok || !data.ok) {
    throw new Error(data?.description || `Telegram returned HTTP ${response.status}.`);
  }

  return data.result;
}

function telegramOrderText(order, title = "\uD83D\uDCB3 NEW PAYMENT") {
  return [
    `<b>${telegramEscape(title)}</b>`,
    ``,
    `<b>Order:</b> <code>${telegramEscape(order.id)}</code>`,
    `<b>Product:</b> ${telegramEscape(order.productName)}`,
    `<b>Duration:</b> ${telegramEscape(order.duration)}`,
    `<b>Amount:</b> \u20B9${Number(order.amount || 0).toFixed(2)}`,
    `<b>UTR:</b> <code>${telegramEscape(order.paymentReference || "Not submitted")}</code>`,
    `<b>Status:</b> ${telegramEscape(order.status)}`,
    order.customerName ? `<b>Customer:</b> ${telegramEscape(order.customerName)}` : "",
    order.customerContact ? `<b>Contact:</b> ${telegramEscape(order.customerContact)}` : ""
  ].filter(Boolean).join("\n");
}

async function sendTelegramPaymentApproval(order) {
  if (!telegramEnabled()) return { sent: false, reason: "Telegram is not configured." };

  const message = await telegramApi("sendMessage", {
    chat_id: TELEGRAM_ADMIN_CHAT_ID,
    text: telegramOrderText(order),
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "\u2705 APPROVE", callback_data: `delta:approve:${order.id}` },
        { text: "\u274C REJECT", callback_data: `delta:reject:${order.id}` }
      ]]
    }
  });

  return { sent: true, messageId: message.message_id };
}

async function telegramAnswerCallback(callbackQueryId, text, showAlert = false) {
  try {
    await telegramApi("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: String(text || "").slice(0, 200),
      show_alert: Boolean(showAlert)
    });
  } catch (e) {
    console.error("Telegram callback answer error:", e.message);
  }
}

async function telegramEditApprovalMessage(callbackQuery, extraText) {
  try {
    const message = callbackQuery.message;
    if (!message) return;

    const oldText = String(message.text || "");
    const newText = `${oldText}\n\n<b>${telegramEscape(extraText)}</b>`;

    await telegramApi("editMessageText", {
      chat_id: String(message.chat.id),
      message_id: message.message_id,
      text: newText,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] }
    });
  } catch (e) {
    console.error("Telegram message edit error:", e.message);
  }
}

async function processTelegramOrderDecision(orderId, decision) {
  const store = await readStore();
  const order = store.orders.find(o => o.id === orderId);

  if (!order) return { ok: false, message: "Order not found." };

  if (decision === "approve") {
    if (order.status === "paid" && order.key) {
      return { ok: true, alreadyDone: true, order, message: "This order was already approved and the key was already released." };
    }

    if (order.status !== "pending") {
      return { ok: false, message: `Order ${order.id} is not pending. Current status: ${order.status}.` };
    }

    if (!order.paymentReference) {
      return { ok: false, message: "This order has no UTR/payment reference." };
    }

    try {
      fulfillPaidOrder(store, order, order.paymentReference || "TELEGRAM_APPROVED");
    } catch (e) {
      return { ok: false, message: e.message || "Could not release the key." };
    }

    order.approvedVia = "telegram";
    order.approvedAt = new Date().toISOString();
    await writeStore(store);

    return { ok: true, order, message: `Approved. Key released: ${order.key}` };
  }

  if (decision === "reject") {
    if (order.status === "rejected") {
      return { ok: true, alreadyDone: true, order, message: "This order was already rejected." };
    }

    if (order.status === "paid") {
      return { ok: false, message: "A paid order cannot be rejected after the key has been released." };
    }

    if (order.status !== "pending") {
      return { ok: false, message: `Order ${order.id} is not pending. Current status: ${order.status}.` };
    }

    order.status = "rejected";
    order.key = "";
    order.rejectedVia = "telegram";
    order.rejectedAt = new Date().toISOString();
    order.updatedAt = order.rejectedAt;
    await writeStore(store);

    return { ok: true, order, message: "Order rejected. No key was released." };
  }

  return { ok: false, message: "Unknown Telegram action." };
}

async function handleTelegramUpdate(update) {
  const callback = update?.callback_query;
  if (!callback) return;

  const callbackChatId = String(callback.message?.chat?.id || "");
  const callbackFromId = String(callback.from?.id || "");
  const configuredAdminChatId = String(TELEGRAM_ADMIN_CHAT_ID || "");

  if (!configuredAdminChatId || (callbackChatId !== configuredAdminChatId && callbackFromId !== configuredAdminChatId)) {
    await telegramAnswerCallback(callback.id, "Not authorized.", true);
    return;
  }

  const data = String(callback.data || "");
  const match = data.match(/^delta:(approve|reject):(.+)$/);

  if (!match) {
    await telegramAnswerCallback(callback.id, "Unknown action.", true);
    return;
  }

  const decision = match[1];
  const orderId = match[2];

  await telegramAnswerCallback(callback.id, decision === "approve" ? "Approving order..." : "Rejecting order...");

  const result = await processTelegramOrderDecision(orderId, decision);

  if (result.ok) {
    await telegramEditApprovalMessage(callback, decision === "approve" ? `\u2705 APPROVED \u2014 ${result.message}` : `\u274C REJECTED \u2014 ${result.message}`);
  } else {
    await telegramEditApprovalMessage(callback, `\u26A0\uFE0F NOT CHANGED \u2014 ${result.message}`);
  }
}

// Telegram calls this URL directly (webhook mode). No background polling
// loop is used because serverless functions cannot run long-lived loops.
app.post("/api/telegram/webhook", async (req, res) => {
  res.status(200).json({ ok: true }); // ack immediately so Telegram doesn't retry
  try {
    await handleTelegramUpdate(req.body);
  } catch (e) {
    console.error("Telegram webhook error:", e);
  }
});

app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/products", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "products.html")));
app.get("/payment", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "payment.html")));
app.get("/status", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "status.html")));

app.get("/api/health", async (req, res) => {
  res.json({ ok: true, app: "DELTA.KEYS", paymentMode: "manual-upi-admin-approval", telegramApproval: telegramEnabled() });
});

app.get("/api/products", async (req, res) => {
  try {
    const store = await readStore();
    res.json(store.products.map(publicProduct));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Could not load products." });
  }
});

app.get("/api/payment-info", async (req, res) => {
  try {
    const store = await readStore();
    res.json({
      enabled: true,
      mode: "manual-upi-admin-approval",
      upiId: store.paymentSettings.upiId || process.env.UPI_ID || "",
      payeeName: store.paymentSettings.payeeName || process.env.PAYMENT_PAYEE_NAME || "DELTA.KEYS",
      qrImage: "/upi-qr.jpg"
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Could not load payment info." });
  }
});

app.post("/api/payments/start-order", async (req, res) => {
  try {
    const { productId, planId } = req.body || {};
    const store = await readStore();

    const product = store.products.find(p => p.id === productId);
    const plan = product && findPlan(product, planId);

    if (!product || !plan) {
      return res.status(400).json({ error: "Product or duration not found." });
    }

    if (Number(product.stock || 0) < 1) {
      return res.status(400).json({ error: "This product is out of stock." });
    }

    const available = store.keyPool.some(item =>
      typeof item === "string" || (item.productId === product.id && item.planId === plan.id)
    );

    if (!available) {
      return res.status(400).json({ error: "No key is available for this duration yet." });
    }

    const upiId = String(store.paymentSettings?.upiId || process.env.UPI_ID || "").trim();
    const payeeName = String(store.paymentSettings?.payeeName || process.env.PAYMENT_PAYEE_NAME || "DELTA.KEYS").trim();

    if (!upiId) {
      return res.status(503).json({ error: "UPI ID is not configured. Ask the admin to add the receiving UPI ID in Settings." });
    }

    const numericAmount = Number(plan.price);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: "This duration has an invalid price." });
    }

    const amount = numericAmount.toFixed(2);
    const localId = "DK-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    const now = new Date().toISOString();

    const upiLink = "upi://pay" +
      "?pa=" + encodeURIComponent(upiId) +
      "&pn=" + encodeURIComponent(payeeName) +
      "&am=" + encodeURIComponent(amount) +
      "&cu=INR" +
      "&tn=" + encodeURIComponent("DELTA.KEYS " + localId);

    const qrDataUrl = await QRCode.toDataURL(upiLink, { errorCorrectionLevel: "M", margin: 2, width: 420 });

    const order = {
      id: localId,
      productId: product.id,
      productName: product.name,
      planId: plan.id,
      duration: plan.name,
      amount: numericAmount,
      paymentReference: "",
      status: "awaiting_payment",
      key: "",
      paymentStartedAt: now,
      createdAt: now,
      updatedAt: now
    };

    store.orders.unshift(order);
    await writeStore(store);

    res.json({
      order: publicOrder(order),
      upiLink,
      qrDataUrl,
      upiId,
      payeeName,
      amount,
      message: "Exact-price UPI QR generated. Complete the payment before submitting your UTR."
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Could not start payment." });
  }
});

app.post("/api/payments/submit-utr", async (req, res) => {
  try {
    const { orderId, paymentReference } = req.body || {};
    const reference = String(paymentReference || "").trim();

    if (!orderId || !reference) {
      return res.status(400).json({ error: "Order ID and UPI transaction ID / UTR are required." });
    }

    if (reference.length < 4 || reference.length > 100) {
      return res.status(400).json({ error: "Enter a valid UPI transaction ID / UTR." });
    }

    const store = await readStore();
    const order = store.orders.find(o => o.id === orderId);

    if (!order) return res.status(404).json({ error: "Order not found." });

    if (order.status !== "awaiting_payment") {
      return res.status(409).json({ error: "This order is no longer accepting a UTR." });
    }

    if (!order.paymentStartedAt) {
      return res.status(400).json({ error: "Start the UPI payment first." });
    }

    const duplicate = store.orders.some(o =>
      o.id !== order.id &&
      o.paymentReference &&
      String(o.paymentReference).toLowerCase() === reference.toLowerCase() &&
      o.status !== "rejected"
    );

    if (duplicate) {
      return res.status(409).json({ error: "This UPI transaction ID has already been submitted." });
    }

    order.paymentReference = reference;
    order.status = "pending";
    order.updatedAt = new Date().toISOString();

    await writeStore(store);

    try {
      await sendTelegramPaymentApproval(order);
    } catch (telegramError) {
      console.error("Telegram payment notification error:", telegramError.message);
    }

    res.json({ order: publicOrder(order), message: "UTR submitted. Admin must verify the actual payment before releasing the key." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Could not submit UTR." });
  }
});

app.get("/api/orders/:id", async (req, res) => {
  try {
    const store = await readStore();
    const order = store.orders.find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });
    res.json({ order: publicOrder(order) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Could not load order." });
  }
});

app.get("/api/admin/data", adminAuth, async (req, res) => {
  try {
    const store = req.store;
    res.json({
      products: store.products,
      orders: store.orders.map(o => ({ ...o })),
      keyPool: store.keyPool || [],
      keyPoolCount: (store.keyPool || []).length,
      planCount: store.products.reduce((n, p) => n + (p.plans || []).length, 0),
      paymentSettings: store.paymentSettings
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Could not load admin data." });
  }
});

app.put("/api/admin/sidebar-order", adminAuth, async (req, res) => {
  try {
    const allowed = new Set(["dashboard", "orders", "products", "keys", "durations", "settings", "telegram"]);
    const order = Array.isArray(req.body?.order) ? req.body.order.filter(x => allowed.has(x)) : [];
    const unique = [...new Set(order)];

    for (const page of ["dashboard", "orders", "products", "keys", "durations", "settings", "telegram"]) {
      if (!unique.includes(page)) unique.push(page);
    }

    const store = req.store;
    store.sidebarOrder = unique;
    await writeStore(store);

    res.json({ sidebarOrder: unique, message: "Admin menu order saved." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Could not save menu order." });
  }
});

app.get("/api/admin/telegram-settings", adminAuth, async (req, res) => {
  res.json({
    enabled: telegramEnabled(),
    configured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_ADMIN_CHAT_ID),
    adminChatIdConfigured: Boolean(TELEGRAM_ADMIN_CHAT_ID),
    message: telegramEnabled() ? "Telegram approval bot is configured." : "Add TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_ID in Vercel Environment Variables."
  });
});

app.put("/api/admin/payment-settings", adminAuth, async (req, res) => {
  try {
    const upiId = String(req.body?.upiId || "").trim();
    const payeeName = String(req.body?.payeeName || "DELTA.KEYS").trim();

    if (!upiId) return res.status(400).json({ error: "Enter the UPI ID used to receive payments." });
    if (upiId.length > 120) return res.status(400).json({ error: "UPI ID is too long." });
    if (payeeName.length > 120) return res.status(400).json({ error: "Payee name is too long." });

    const store = req.store;
    store.paymentSettings = { upiId, payeeName: payeeName || "DELTA.KEYS" };
    await writeStore(store);

    res.json({ paymentSettings: store.paymentSettings, message: "Payment settings updated." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Could not save payment settings." });
  }
});

app.put("/api/admin/change-password", adminAuth, async (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");
    const confirmPassword = String(req.body?.confirmPassword || "");

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: "Fill all password fields." });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters." });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: "New password and confirmation do not match." });
    }

    const store = req.store;

    if (!verifyAdminPassword(currentPassword, store.adminCredentials?.passwordHash)) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }

    store.adminCredentials = {
      username: store.adminCredentials?.username || process.env.ADMIN_USER || "admin",
      passwordHash: hashAdminPassword(newPassword)
    };

    await writeStore(store);

    res.json({ message: "Admin password changed successfully. Please log in again with your new password." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Could not change password." });
  }
});

app.put("/api/admin/orders/:id", adminAuth, async (req, res) => {
  try {
    const store = req.store;
    const order = store.orders.find(o => o.id === req.params.id);

    if (!order) return res.status(404).json({ error: "Order not found." });

    const { status, key, customerName, customerContact, paymentReference } = req.body || {};

    if (status && !["awaiting_payment", "pending", "paid", "rejected"].includes(status)) {
      return res.status(400).json({ error: "Invalid status." });
    }

    if (typeof customerName === "string") order.customerName = customerName.trim();
    if (typeof customerContact === "string") order.customerContact = customerContact.trim();
    if (typeof paymentReference === "string") order.paymentReference = paymentReference.trim();
    if (typeof key === "string" && key.trim()) order.key = key.trim();

    if (status === "paid") {
      if (!order.key) {
        fulfillPaidOrder(store, order, order.paymentReference || "ADMIN_APPROVED");
      } else {
        order.status = "paid";
        order.paidAt = order.paidAt || new Date().toISOString();
        order.updatedAt = new Date().toISOString();
      }
    } else if (status === "rejected") {
      order.status = "rejected";
      order.key = "";
      order.rejectedAt = new Date().toISOString();
      order.updatedAt = order.rejectedAt;
    } else if (status === "awaiting_payment") {
      order.status = "awaiting_payment";
      order.key = "";
      order.updatedAt = new Date().toISOString();
    } else if (status === "pending") {
      order.status = "pending";
      order.key = "";
      order.updatedAt = new Date().toISOString();
    } else {
      order.updatedAt = new Date().toISOString();
    }

    await writeStore(store);

    res.json({ order: publicOrder(order) });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || "Could not update order." });
  }
});

app.post("/api/admin/keys", adminAuth, async (req, res) => {
  try {
    const keys = Array.isArray(req.body?.keys) ? req.body.keys : String(req.body?.keys || "").split(/\r?\n/);
    const productId = String(req.body?.productId || "");
    const planId = String(req.body?.planId || "");
    const clean = keys.map(k => String(k).trim()).filter(Boolean);

    if (!clean.length) return res.status(400).json({ error: "No keys supplied." });
    if (!productId || !planId) return res.status(400).json({ error: "Select a product and duration before uploading keys." });

    const store = req.store;
    const product = store.products.find(p => p.id === productId);

    if (!product || !findPlan(product, planId)) {
      return res.status(400).json({ error: "Product or duration not found." });
    }

    store.keyPool = Array.isArray(store.keyPool) ? store.keyPool : [];
    store.keyPool.push(...clean.map(key => ({ key, productId, planId })));

    await writeStore(store);

    res.json({ added: clean.length, total: store.keyPool.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Could not upload keys." });
  }
});

app.post("/api/admin/products", adminAuth, async (req, res) => {
  try {
    const store = req.store;
    const { name, price, stock, description, badge, durationName, durationHours, durationPrice } = req.body || {};

    if (!String(name || "").trim() || !Number.isFinite(Number(price)) || Number(price) < 0) {
      return res.status(400).json({ error: "Product name and valid price are required." });
    }

    const planName = String(durationName || "Default").trim();

    const plan = {
      id: "plan-" + crypto.randomBytes(4).toString("hex"),
      name: planName,
      durationHours: Math.max(0, Number(durationHours || 0)),
      price: Number(durationPrice ?? price),
      active: true
    };

    const product = {
      id: "product-" + crypto.randomBytes(5).toString("hex"),
      name: String(name).trim(),
      price: Number(price),
      stock: Math.max(0, Math.floor(Number(stock || 0))),
      description: String(description || "").trim(),
      badge: String(badge || "NEW").trim(),
      plans: [plan]
    };

    store.products.push(product);
    await writeStore(store);

    res.status(201).json({ product });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Could not add product." });
  }
});

app.put("/api/admin/products/:id", adminAuth, async (req, res) => {
  try {
    const store = req.store;
    const product = store.products.find(p => p.id === req.params.id);

    if (!product) return res.status(404).json({ error: "Product not found." });

    const { name, price, stock, description, badge } = req.body || {};

    if (typeof name === "string" && name.trim()) product.name = name.trim();
    if (Number.isFinite(Number(price)) && Number(price) >= 0) product.price = Number(price);
    if (Number.isFinite(Number(stock)) && Number(stock) >= 0) product.stock = Math.floor(Number(stock));
    if (typeof description === "string") product.description = description.trim();
    if (typeof badge === "string") product.badge = badge.trim();

    await writeStore(store);
    res.json({ product });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Could not update product." });
  }
});

app.post("/api/admin/plans", adminAuth, async (req, res) => {
  try {
    const store = req.store;
    const { productId, name, durationHours, price } = req.body || {};
    const product = store.products.find(p => p.id === productId);

    if (!product) return res.status(404).json({ error: "Product not found." });

    if (!String(name || "").trim() || !Number.isFinite(Number(price)) || Number(price) < 0) {
      return res.status(400).json({ error: "Duration name and valid price are required." });
    }

    product.plans = Array.isArray(product.plans) ? product.plans : [];

    const plan = {
      id: "plan-" + crypto.randomBytes(4).toString("hex"),
      name: String(name).trim(),
      durationHours: Math.max(0, Number(durationHours || 0)),
      price: Number(price),
      active: true
    };

    product.plans.push(plan);
    await writeStore(store);

    res.status(201).json({ plan });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Could not add duration." });
  }
});

app.put("/api/admin/plans/:productId/:planId", adminAuth, async (req, res) => {
  try {
    const store = req.store;
    const product = store.products.find(p => p.id === req.params.productId);
    const plan = product && (product.plans || []).find(x => x.id === req.params.planId);

    if (!plan) return res.status(404).json({ error: "Duration not found." });

    const { name, durationHours, price, active } = req.body || {};

    if (typeof name === "string" && name.trim()) plan.name = name.trim();
    if (Number.isFinite(Number(durationHours)) && Number(durationHours) >= 0) plan.durationHours = Number(durationHours);
    if (Number.isFinite(Number(price)) && Number(price) >= 0) plan.price = Number(price);
    if (typeof active === "boolean") plan.active = active;

    await writeStore(store);
    res.json({ plan });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Could not update duration." });
  }
});

app.delete("/api/admin/plans/:productId/:planId", adminAuth, async (req, res) => {
  try {
    const store = req.store;
    const product = store.products.find(p => p.id === req.params.productId);

    if (!product) return res.status(404).json({ error: "Product not found." });

    product.plans = (product.plans || []).filter(x => x.id !== req.params.planId);
    await writeStore(store);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Could not delete duration." });
  }
});

app.delete("/api/admin/products/:id", adminAuth, async (req, res) => {
  try {
    const store = req.store;
    const before = store.products.length;

    store.products = store.products.filter(p => p.id !== req.params.id);

    if (before === store.products.length) return res.status(404).json({ error: "Product not found." });

    await writeStore(store);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Could not delete product." });
  }
});

// Central error handler so a thrown/rejected error never becomes a raw
// Vercel crash page — it always comes back as JSON.
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || "Internal server error." });
});

module.exports = app;

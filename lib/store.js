const crypto = require("crypto");
const { initFirebase } = require("./firebase");

const COLLECTION = "delta_keys_store";
const DOC_ID = "main";

function defaultPlans() {
  return [
    { id: "5-hours", name: "5 Hours", durationHours: 5, price: 49, active: true },
    { id: "1-day", name: "1 Day", durationHours: 24, price: 79, active: true },
    { id: "7-days", name: "7 Days", durationHours: 168, price: 149, active: true },
    { id: "30-days", name: "30 Days", durationHours: 720, price: 299, active: true },
    { id: "lifetime", name: "Lifetime", durationHours: 0, price: 499, active: true }
  ];
}

function hashAdminPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function defaultStoreData() {
  return {
    products: [
      { id: "delta-basic", name: "DELTA Basic Key", price: 99, stock: 50, description: "Digital access key.", badge: "POPULAR", plans: defaultPlans() },
      { id: "delta-pro", name: "DELTA Pro Key", price: 199, stock: 25, description: "Premium digital access key.", badge: "PRO", plans: defaultPlans() },
      { id: "delta-ultra", name: "DELTA Ultra Key", price: 299, stock: 10, description: "Ultimate digital access key.", badge: "ULTRA", plans: defaultPlans() }
    ],
    orders: [],
    keyPool: [],
    paymentSettings: {
      upiId: process.env.UPI_ID || "",
      payeeName: process.env.PAYMENT_PAYEE_NAME || "DELTA.KEYS"
    },
    sidebarOrder: ["dashboard", "orders", "products", "keys", "durations", "settings", "telegram"],
    adminCredentials: {
      username: process.env.ADMIN_USER || "admin",
      passwordHash: hashAdminPassword(process.env.ADMIN_PASSWORD || "admin123")
    }
  };
}

function normalize(store) {
  for (const p of store.products || []) {
    if (!Array.isArray(p.plans) || !p.plans.length) {
      p.plans = [{
        id: "default",
        name: "Default",
        durationHours: 0,
        price: Number(p.price || 0),
        active: true
      }];
    }
  }

  if (!Array.isArray(store.keyPool)) store.keyPool = [];
  if (!Array.isArray(store.orders)) store.orders = [];
  if (!Array.isArray(store.products)) store.products = [];

  if (!store.paymentSettings || typeof store.paymentSettings !== "object") {
    store.paymentSettings = {};
  }
  if (typeof store.paymentSettings.upiId !== "string") {
    store.paymentSettings.upiId = process.env.UPI_ID || "";
  }
  if (
    typeof store.paymentSettings.payeeName !== "string" ||
    !store.paymentSettings.payeeName.trim()
  ) {
    store.paymentSettings.payeeName = process.env.PAYMENT_PAYEE_NAME || "DELTA.KEYS";
  }

  if (!Array.isArray(store.sidebarOrder)) {
    store.sidebarOrder = ["dashboard", "orders", "products", "keys", "durations", "settings", "telegram"];
  }

  if (
    !store.adminCredentials ||
    typeof store.adminCredentials !== "object" ||
    !store.adminCredentials.passwordHash
  ) {
    store.adminCredentials = {
      username: process.env.ADMIN_USER || "admin",
      passwordHash: hashAdminPassword(process.env.ADMIN_PASSWORD || "admin123")
    };
  }

  return store;
}

async function readStore() {
  const { db } = initFirebase();
  const ref = db.collection(COLLECTION).doc(DOC_ID);
  const snap = await ref.get();

  if (!snap.exists) {
    const initial = defaultStoreData();
    await ref.set(initial);
    return initial;
  }

  return normalize(snap.data());
}

async function writeStore(data) {
  const { db } = initFirebase();
  const ref = db.collection(COLLECTION).doc(DOC_ID);
  // Firestore rejects `undefined` field values; JSON round-trip strips them.
  const clean = JSON.parse(JSON.stringify(data));
  await ref.set(clean);
  return clean;
}

module.exports = { readStore, writeStore, hashAdminPassword, defaultPlans };

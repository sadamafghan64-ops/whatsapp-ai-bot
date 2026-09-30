const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  isJidGroup
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const express = require("express");
const QRCode = require("qrcode");

// ==================================================
// SETTINGS
// ==================================================

const PORT = Number(process.env.PORT) || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const CHANNEL_LINK = process.env.CHANNEL_LINK || "https://whatsapp.com/channel/0029Vb8aj9h6hENnMWzkQE07";
const REGISTRATION_CODE = process.env.REGISTRATION_CODE || "SDA25324809$";

// ==================================================
// ADMIN NUMBERS
// ==================================================

const ADMIN_PHONES = [
  "93774849282@s.whatsapp.net",
  "93764835808@s.whatsapp.net"
];

// ==================================================
// FILES
// ==================================================

const AUTH_DIR = path.join(__dirname, "whatsapp_sessions");
const MEMORY_FILE = path.join(__dirname, "bot_memory.json");
const HISTORY_FILE = path.join(__dirname, "chat_history.json");

// ==================================================
// GLOBALS
// ==================================================

let latestQR = "";
let reconnectTimer = null;
let isConnecting = false;
const userLocks = new Set();

// ==================================================
// EXPRESS SERVER
// ==================================================

const app = express();

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>WhatsApp AI Bot</title>
      </head>
      <body style="font-family: Arial; text-align: center; padding: 30px;">
        <h1>🤖 WhatsApp AI Bot</h1>
        <p>Bot Server فعال دی ✅</p>
        <p><a href="/health">Health Check</a></p>
        <p><a href="/qr">📱 Open WhatsApp QR</a></p>
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    whatsapp: latestQR ? "waiting_for_qr_scan" : "connected_or_starting",
    time: new Date().toISOString()
  });
});

app.get("/qr", async (req, res) => {
  try {
    if (!latestQR) {
      return res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <meta http-equiv="refresh" content="5">
            <title>WhatsApp QR</title>
          </head>
          <body style="font-family: Arial; text-align: center; padding: 30px;">
            <h2>📱 WhatsApp QR</h2>
            <p>QR Code لا تر اوسه تیار نه دی.</p>
            <p>څو ثانیې انتظار وکړه...</p>
          </body>
        </html>
      `);
    }

    const qrImage = await QRCode.toDataURL(latestQR, { width: 400, margin: 2 });
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>WhatsApp QR Code</title>
        </head>
        <body style="font-family: Arial; text-align: center; padding: 20px;">
          <h2>📱 WhatsApp QR Code</h2>
          <p>په خپل اصلي WhatsApp کې:</p>
          <p><b>Settings → Linked devices → Link a device</b></p>
          <br>
          <img src="${qrImage}" alt="WhatsApp QR Code" style="width: 350px; max-width: 90%; height: auto; border: 5px solid #000;">
          <br><br>
          <p>QR Code ژر بدلېږي.</p>
          <p>که Scan نه شو، پاڼه Refresh کړه.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.log("QR page error:", error.message);
    res.status(500).send("QR Code جوړولو کې ستونزه راغله.");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("\n================================");
  console.log(`🌐 Server running on port ${PORT}`);
  console.log("================================\n");
});

// ==================================================
// JSON HELPERS
// ==================================================

function loadData(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const data = fs.readFileSync(file, "utf8");
    if (!data.trim()) return {};
    return JSON.parse(data);
  } catch (error) {
    console.log(`⚠️ File read error: ${file}`, error.message);
    return {};
  }
}

function saveData(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.log(`⚠️ File save error: ${file}`, error.message);
  }
}

function isAdmin(jid) {
  return ADMIN_PHONES.includes(jid);
}

// ==================================================
// FIXED AI FUNCTION (GEMINI 1.5 FLASH)
// ==================================================

async function getAIResponse(userPhone, userMessage) {
  if (!GEMINI_API_KEY) {
    return "⚠️ Gemini API Key په Render کې تنظیم شوی نه دی.";
  }

  const historyData = loadData(HISTORY_FILE);
  const history = historyData[userPhone] || [];
  const recentHistory = history.slice(-10);

  // د ماډل لارښود (System Instruction)
  const systemInstruction = "ته د WhatsApp یو ځیرک او مهربان پښتو AI مرستندوی یې. د کارونکي خبرې په روانه او ساده پښتو درک کړه او لنډ، واضح او ګټور ځواب ورکړه. که کارونکی په انګلیسي غږېږي په انګلیسي ځواب کړه.";

  // د Gemini نوي جوړښت (Payload Structure) ته د تاریخچې برابرول
  const contents = [];
  for (const item of recentHistory) {
    contents.push({
      role: item.role === "model" ? "model" : "user",
      parts: [{ text: item.content }]
    });
  }

  contents.push({
    role: "user",
    parts: [{ text: userMessage }]
  });

  try {
    // د باوري او مستقر ماډل (gemini-1.5-flash) کارول
    const url = `https://googleapis.com{GEMINI_API_KEY}`;

    const response = await axios.post(url, {
      contents: contents,
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      }
    }, {
      timeout: 30000,
      headers: { "Content-Type": "application/json" }
    });

    const aiText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!aiText) {
      return "بښنه، زه اوس ځواب نشم جوړولی.";
    }

    // د تاریخچې خوندي کول
    history.push({ role: "user", content: userMessage });
    history.push({ role: "model", content: aiText });
    historyData[userPhone] = history.slice(-20); // د حافظې د ډکېدو د مخنیوي لپاره تر ۲۰ پیغامونو ساتل
    saveData(HISTORY_FILE, historyData);

    return aiText;

  } catch (error) {
    console.error("❌ Gemini API Error Details:", error.response ? JSON.stringify(error.response.data) : error.message);
    return "بښنه، د AI خدمت کې لنډمهاله ستونزه راغلې. لږ وروسته بیا هڅه وکړه.";
  }
}

// ==================================================
// TYPING & SENDING
// ==================================================

async function simulateTyping(sock, jid, text) {
  try {
    await sock.sendPresenceUpdate("composing", jid);
    const delay = Math.min(4000, Math.max(1000, text.length * 10));
    await new Promise(resolve => setTimeout(resolve, delay));
    await sock.sendPresenceUpdate("paused", jid);
  } catch (error) {
    console.log("Typing error:", error.message);
  }
}

async function sendMessage(sock, jid, text) {
  await simulateTyping(sock, jid, text);
  await sock.sendMessage(jid, { text });
}

// ==================================================
// ADMIN COMMANDS
// ==================================================

async function handleAdmin(sock, jid, text) {
  const command = text.trim();

  if (command === "حالت") {
    await sendMessage(sock, jid, "✅ Bot فعال دی او WhatsApp سره وصل دی.");
    return true;
  }

  if (command.toLowerCase() === "ping") {
    await sendMessage(sock, jid, "pong ✅");
    return true;
  }

  if (command === "لیست") {
    const users = loadData(MEMORY_FILE);
    const registered = Object.values(users).filter(user => user.status === "registered");

    if (registered.length === 0) {
      await sendMessage(sock, jid, "📊 تر اوسه هېڅ ثبت شوی کارن نشته.");
      return true;
    }

    let result = "📊 ثبت شوي کارنان:\n\n";
    registered.forEach((user, index) => {
      const phone = String(user.phone || "").replace("@s.whatsapp.net", "");
      result += `${index + 1}. شمېره: ${user.serial_number || "-"} نمبر: +${phone}\n`;
    });

    await sendMessage(sock, jid, result);
    return true;
  }

  return false;
}

// ==================================================
// WHATSAPP CONNECTION
// ==================================================

async function connectToWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    console.log("\n🚀 Starting WhatsApp...");

    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async update => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQR = qr;
        console.log("\n======================================");
        console.log("📱 WHATSAPP QR CODE READY");
        console.log("======================================");
        console.log("Open your Render /qr page.");
        console.log("======================================\n");
      }

      if (connection === "open") {
        latestQR = "";
        isConnecting = false;
        console.log("\n======================================");

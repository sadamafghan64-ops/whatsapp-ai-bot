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

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "";

const CHANNEL_LINK =
  process.env.CHANNEL_LINK ||
  "https://whatsapp.com";

const REGISTRATION_CODE =
  process.env.REGISTRATION_CODE ||
  "SDA25324809$";

// ==================================================
// ADMIN NUMBERS (FROM ENVIRONMENT VARIABLES)
// ==================================================

const rawAdminPhones = process.env.ADMIN_PHONES || "93774849282,93764835808";
const ADMIN_PHONES = rawAdminPhones.split(",").map(phone => {
  const cleanPhone = phone.trim();
  return cleanPhone.endsWith("@s.whatsapp.net") ? cleanPhone : `${cleanPhone}@s.whatsapp.net`;
});

// ==================================================
// FILES
// ==================================================

const AUTH_DIR =
  path.join(__dirname, "whatsapp_sessions");

const MEMORY_FILE =
  path.join(__dirname, "bot_memory.json");

const HISTORY_FILE =
  path.join(__dirname, "chat_history.json");

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
        <meta name="viewport"
              content="width=device-width, initial-scale=1">
        <title>WhatsApp AI Bot</title>
      </head>

      <body style="
        font-family: Arial;
        text-align: center;
        padding: 30px;
      ">

        <h1>🤖 WhatsApp AI Bot</h1>

        <p>Bot Server فعال دی ✅</p>

        <p>
          <a href="/health">
            Health Check
          </a>
        </p>

        <p>
          <a href="/qr">
            📱 Open WhatsApp QR
          </a>
        </p>

      </body>
    </html>
  `);
});

// ==================================================
// HEALTH
// ==================================================

app.get("/health", (req, res) => {

  res.json({
    status: "online",
    whatsapp:
      latestQR
        ? "waiting_for_qr_scan"
        : "connected_or_starting",
    time: new Date().toISOString()
  });

});

// ==================================================
// QR PAGE
// ==================================================

app.get("/qr", async (req, res) => {

  try {

    if (!latestQR) {

      return res.send(`
        <!DOCTYPE html>

        <html>

          <head>

            <meta charset="UTF-8">

            <meta
              name="viewport"
              content="width=device-width, initial-scale=1"
            >

            <meta
              http-equiv="refresh"
              content="5"
            >

            <title>WhatsApp QR</title>

          </head>

          <body style="
            font-family: Arial;
            text-align: center;
            padding: 30px;
          ">

            <h2>📱 WhatsApp QR</h2>

            <p>
              QR Code لا تر اوسه تیار نه دی.
            </p>

            <p>
              څو ثانیې انتظار وکړه...
            </p>

          </body>

        </html>
      `);
    }

    const qrImage =
      await QRCode.toDataURL(
        latestQR,
        {
          width: 400,
          margin: 2
        }
      );

    res.send(`
      <!DOCTYPE html>

      <html>

        <head>

          <meta charset="UTF-8">

          <meta
            name="viewport"
            content="width=device-width, initial-scale=1"
          >

          <title>WhatsApp QR Code</title>

        </head>

        <body style="
          font-family: Arial;
          text-align: center;
          padding: 20px;
        ">

          <h2>📱 WhatsApp QR Code</h2>

          <p>
            په خپل اصلي WhatsApp کې:
          </p>

          <p>
            <b>
              Settings → Linked devices
              → Link a device
            </b>
          </p>

          <br>

          <img
            src="${qrImage}"
            alt="WhatsApp QR Code"
            style="
              width: 350px;
              max-width: 90%;
              height: auto;
              border: 5px solid #000;
            "
          >

          <br><br>

          <p>
            QR Code ژر بدلېږي.
          </p>

          <p>
            که Scan ne sho، پاڼه Refresh کړه.
          </p>

        </body>

      </html>
    `);

  } catch (error) {

    console.log(
      "QR page error:",
      error.message
    );

    res.status(500).send(
      "QR Code جوړولو کې ستونزه راغله."
    );
  }

});

// ==================================================
// START SERVER
// ==================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");
    console.log(
      "================================"
    );

    console.log(
      `🌐 Server running on port ${PORT}`
    );

    console.log(
      "================================"
    );

  }
);

// ==================================================
// JSON LOAD
// ==================================================

function loadData(file) {

  try {

    if (!fs.existsSync(file)) {
      return {};
    }

    const data =
      fs.readFileSync(
        file,
        "utf8"
      );

    if (!data.trim()) {
      return {};
    }

    return JSON.parse(data);

  } catch (error) {

    console.log(
      `⚠️ File read error: ${file}`,
      error.message
    );

    return {};
  }

}

// ==================================================
// JSON SAVE
// ==================================================

function saveData(file, data) {

  try {

    fs.writeFileSync(
      file,
      JSON.stringify(
        data,
        null,
        2
      ),
      "utf8"
    );

  } catch (error) {

    console.log(
      `⚠️ File save error: ${file}`,
      error.message
    );

  }

}

// ==================================================
// ADMIN CHECK
// ==================================================

function isAdmin(jid) {

  return ADMIN_PHONES.includes(jid);

}

// ==================================================
// AI
// ==================================================

async function getAIResponse(
  userPhone,
  userMessage
) {

  const historyData =
    loadData(HISTORY_FILE);

  const history =
    historyData[userPhone] || [];

  if (!GEMINI_API_KEY) {

    return (
      "⚠️ Gemini API Key تنظیم شوی نه دی."
    );

  }

  const systemInstruction = `
ته د WhatsApp یو AI مرستندوی یې.
د کارونکي خبرې په روانه او ساده پښتو درک کړه.
لنډ، واضح او ګټور ځواب ورکړه.
که کارونکی په پښتو خبرې کوي، په پښتو ځواب ورکړه.
که کارونکی په انګلیسي خبرې کوي، په انګلیسي ځواب ورکولای شې.
د نورو کاروونکو شخصي معلومات مه ښکاره کوه.
خپل ځان د WhatsApp AI مرستندوی په توګه معرفي کړه.
`;

  const recentHistory =
    history.slice(-10);

  const contents = [];

  for (
    const item
    of recentHistory
  ) {

    contents.push({

      role:
        item.role === "model"
          ? "model"
          : "user",

      parts: [
        {
          text: item.content
        }
      ]

    });

  }

  contents.push({

    role: "user",

    parts: [
      {
        text: userMessage
      }
    ]

  });

  try {

    const response =
      await axios.post(

        "https://googleapis.com",

        {

          systemInstruction: {

            parts: [
              {
                text:
                  systemInstruction
              }
            ]

          },

          contents

        },

        {

          params: {
            key: GEMINI_API_KEY
          },

          timeout: 30000

        }

      );

    const parts =
      response.data
        ?.candidates?.[0]
        ?.content?.parts || [];

    const aiText =
      parts
        .map(
          part =>
            part.text || ""
        )
        .join("")
        .trim();

    if (!aiText) {

      return (
        "بښنه، AI اوس ځواب نشي جوړولی."
      );

    }

    history.push({

      role: "user",

      content: userMessage

    });

    history.push({

      role: "model",

      content: aiText

    });

    historyData[userPhone] =
      history.slice(-30);

    saveData(
      HISTORY_FILE,
      historyData
    );

    return aiText;

  } catch (error) {

    console.log(
      "❌ Gemini Error:",
      error.response?.data ||
      error.message
    );

    return (
      "بښنه، د AI خدمت کې لنډمهاله ستونزه راغلې. لږ وروسته بیا هڅه وکړه."
    );

  }

}

// ==================================================
// TYPING
// ==================================================

async function simulateTyping(
  sock,
  jid,
  text
) {

  try {

    await sock.sendPresenceUpdate(
      "composing",
      jid
    );

    const delay =
      Math.min(
        5000,
        Math.max(
          1000,
          text.length * 15
        )
      );

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          delay
        )
    );

    await sock.sendPresenceUpdate(
      "paused",
      jid
    );

  } catch (error) {

    console.log(
      "Typing error:",
      error.message
    );

  }

}

// ==================================================
// SEND MESSAGE

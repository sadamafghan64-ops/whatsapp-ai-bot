const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  isJidGroup
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");
const pino = require("pino");
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ===============================
// SETTINGS
// ===============================

const PORT = Number(process.env.PORT) || 10000;

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || "";

// خپل WhatsApp نمبر دلته ولیکه
// مثال: 937XXXXXXXXX
// + مه لیکه
const PHONE_NUMBER =
  process.env.WHATSAPP_PHONE || "";

const ADMIN_NUMBERS = [
  "93774849282@s.whatsapp.net",
  "93764835808@s.whatsapp.net"
];

const AUTH_DIR = path.join(
  __dirname,
  "whatsapp_sessions"
);

const MEMORY_FILE = path.join(
  __dirname,
  "bot_memory.json"
);

const HISTORY_FILE = path.join(
  __dirname,
  "chat_history.json"
);

// ===============================
// EXPRESS
// ===============================

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("WhatsApp AI Bot is running ✅");
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    bot: "WhatsApp AI Bot",
    time: new Date().toISOString()
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `🌐 Server running on port ${PORT}`
  );
});

// ===============================
// JSON
// ===============================

function loadJSON(file, defaultValue) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(
        file,
        JSON.stringify(
          defaultValue,
          null,
          2
        )
      );

      return defaultValue;
    }

    return JSON.parse(
      fs.readFileSync(file, "utf8")
    );

  } catch (error) {
    console.log(
      "JSON load error:",
      error.message
    );

    return defaultValue;
  }
}

function saveJSON(file, data) {
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
      "JSON save error:",
      error.message
    );
  }
}

// ===============================
// DATA
// ===============================

let botMemory = loadJSON(
  MEMORY_FILE,
  {}
);

let chatHistory = loadJSON(
  HISTORY_FILE,
  {}
);

// ===============================
// GEMINI
// ===============================

async function askAI(
  userMessage,
  userId
) {

  if (!GEMINI_API_KEY) {
    return "⚠️ GEMINI_API_KEY تنظیم شوی نه دی.";
  }

  try {

    const oldHistory =
      chatHistory[userId] || [];

    const recentHistory =
      oldHistory
        .slice(-10)
        .map(
          item =>
            `${item.role}: ${item.text}`
        )
        .join("\n");

    const prompt = `
You are a helpful WhatsApp AI assistant.

Answer the user naturally and clearly.

Previous conversation:
${recentHistory}

New user message:
${userMessage}

Give a useful answer.
`;

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

    const response =
      await axios.post(
        url,
        {
          contents: [
            {
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ]
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

    const answer =
      parts
        .map(
          part => part.text || ""
        )
        .join("")
        .trim();

    if (!answer) {
      return "بښنه، اوس ځواب نشم جوړولای.";
    }

    return answer;

  } catch (error) {

    console.log(
      "Gemini error:",
      error.response?.data ||
      error.message
    );

    return "بښنه، د AI له سرور سره ستونزه ده. لږ وروسته بیا هڅه وکړه.";
  }
}

// ===============================
// SEND MESSAGE
// ===============================

async function sendReply(
  sock,
  jid,
  text
) {

  try {

    await sock.sendPresenceUpdate(
      "composing",
      jid
    );

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          700
        )
    );

    await sock.sendMessage(
      jid,
      {
        text
      }
    );

    await sock.sendPresenceUpdate(
      "paused",
      jid
    );

  } catch (error) {

    console.log(
      "Send error:",
      error.message
    );
  }
}

// ===============================
// SAVE USER
// ===============================

function saveUser(userId) {

  if (!botMemory[userId]) {

    botMemory[userId] = {
      phone: userId,
      firstMessage:
        new Date().toISOString(),
      messages: 0,
      lastMessage: null
    };
  }

  botMemory[userId].messages += 1;

  botMemory[userId].lastMessage =
    new Date().toISOString();

  saveJSON(
    MEMORY_FILE,
    botMemory
  );
}

// ===============================
// SAVE CHAT
// ===============================

function saveChat(
  userId,
  role,
  text
) {

  if (!chatHistory[userId]) {
    chatHistory[userId] = [];
  }

  chatHistory[userId].push({
    role,
    text,
    time:
      new Date().toISOString()
  });

  if (
    chatHistory[userId].length >
    30
  ) {

    chatHistory[userId] =
      chatHistory[userId]
        .slice(-30);
  }

  saveJSON(
    HISTORY_FILE,
    chatHistory
  );
}

// ===============================
// ADMIN
// ===============================

function isAdmin(jid) {
  return ADMIN_NUMBERS.includes(jid);
}

async function handleAdminCommand(
  sock,
  jid,
  text
) {

  const command =
    text.trim().toLowerCase();

  if (command === "حالت") {

    await sendReply(
      sock,
      jid,
      "✅ بوټ فعال دی او WhatsApp سره وصل دی."
    );

    return true;
  }

  if (command === "ping") {

    await sendReply(
      sock,
      jid,
      "pong ✅"
    );

    return true;
  }

  if (command === "لیست") {

    const users =
      Object.values(botMemory);

    if (users.length === 0) {

      await sendReply(
        sock,
        jid,
        "تر اوسه هېڅ کارن ثبت شوی نه دی."
      );

      return true;
    }

    const list =
      users
        .slice(-100)
        .map(
          (user, index) =>
            `${index + 1}. ${user.phone} — ${user.messages} messages`
        )
        .join("\n");

    await sendReply(
      sock,
      jid,
      `👥 Users:\n\n${list}`
    );

    return true;
  }

  return false;
}

// ===============================
// WHATSAPP
// ===============================

let reconnectTimer = null;
let pairingRequested = false;

async function startBot() {

  try {

    console.log(
      "🚀 Starting WhatsApp bot..."
    );

    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(
      AUTH_DIR
    );

    const sock =
      makeWASocket({

        auth: state,

        logger:
          pino({
            level: "silent"
          }),

        markOnlineOnConnect:
          false,

        syncFullHistory:
          false
      });

    // Save WhatsApp credentials
    sock.ev.on(
      "creds.update",
      saveCreds
    );

    // =========================
    // CONNECTION
    // =========================

    sock.ev.on(
      "connection.update",
      async update => {

        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        // =====================
        // PAIRING CODE
        // =====================

        if (
          !state.creds.registered &&
          (connection === "connecting" || qr) &&
          !pairingRequested
        ) {

          pairingRequested = true;

          if (!PHONE_NUMBER) {

            console.log(
              "❌ WHATSAPP_PHONE is missing."
            );

            console.log(
              "Render Environment Variables کې WHATSAPP_PHONE اضافه کړه."
            );

            return;
          }

          try {

            const code =
              await sock.requestPairingCode(
                PHONE_NUMBER
              );

            console.log("");
            console.log(
              "================================"
            );
            console.log(
              "📱 WHATSAPP PAIRING CODE"
            );
            console.log(
              "================================"
            );
            console.log(
              code
            );
            console.log(
              "================================"
            );
            console.log(
              "WhatsApp → Settings → Linked devices → Link a device → Link with phone number"
            );
            console.log(
              "================================"
            );
            console.log("");

          } catch (error) {

            pairingRequested =
              false;

            console.log(
              "❌ Pairing code error:",
              error.message
            );
          }
        }

        // =====================
        // CONNECTED
        // =====================

        if (
          connection === "open"
        ) {

          pairingRequested =
            false;

          console.log("");
          console.log(
            "================================"
          );
          console.log(
            "✅ WHATSAPP CONNECTED"
          );
          console.log(
            "================================"
          );
          console.log("");
        }

        // =====================
        // DISCONNECTED
        // =====================

        if (
          connection === "close"
        ) {

          pairingRequested =
            false;

          const statusCode =
            new Boom(
              lastDisconnect?.error
            )?.output?.statusCode;

          console.log(
            "❌ WhatsApp disconnected:",
            statusCode
          );

          if (
            statusCode ===
            DisconnectReason.loggedOut
          ) {

            console.log(
              "⚠️ WhatsApp logged out."
            );

            console.log(
              "د بیا Login لپاره نوې session ته اړتیا ده."
            );

            return;
          }

          if (
            reconnectTimer
          ) {
            clearTimeout(
              reconnectTimer
            );
          }

          reconnectTimer =
            setTimeout(
              () => {
                startBot();
              },
              5000
            );
        }
      }
    );

    // =========================
    // MESSAGES
    // =========================

    sock.ev.on(
      "messages.upsert",
      async ({ messages }) => {

        for (
          const message
          of messages
        ) {

          try {

            if (
              !message.message
            ) {
              continue;
            }

            if (
              message.key.fromMe
            ) {
              continue;
            }

            const jid =
              message.key.remoteJid;

            if (!jid) {
              continue;
            }

            // Ignore groups
            if (
              isJidGroup(jid)
            ) {
              continue;
            }

            const content =
              message.message;

            let text = "";

            if (
              content.conversation
            ) {

              text =
                content.conversation;

            } else if (
              content
                .extendedTextMessage
                ?.text
            ) {

              text =
                content
                  .extendedTextMessage
                  .text;

            } else if (
              content
                .imageMessage
                ?.caption
            ) {

              text =
                content
                  .imageMessage
                  .caption;

            } else if (
              content
                .videoMessage
                ?.caption
            ) {

              text =
                content
                  .videoMessage
                  .caption;
            }

            text =
              text.trim();

            if (!text) {
              continue;
            }

            console.log(
              `📩 ${jid}: ${text}`
            );

            saveUser(jid);

            saveChat(
              jid,
              "user",
              text
            );

            // Admin commands
            if (
              isAdmin(jid)
            ) {

              const handled =
                await handleAdminCommand(
                  sock,
                  jid,
                  text
                );

              if (handled) {
                continue;
              }
            }

            // AI
            const answer =
              await askAI(
                text,
                jid
              );

            saveChat(
              jid,
              "assistant",
              answer
            );

            await sendReply(
              sock,
              jid,
              answer
            );

          } catch (error) {

            console.log(
              "Message error:",
              error.message
            );
          }
        }
      }
    );

  } catch (error) {

    console.log(
      "Startup error:",
      error.message
    );

    pairingRequested =
      false;

    if (
      reconnectTimer
    ) {
      clearTimeout(
        reconnectTimer
      );
    }

    reconnectTimer =
      setTimeout(
        () => {
          startBot();
        },
        10000
      );
  }
}

// ===============================
// START
// ===============================

startBot();

// ===============================
// SHUTDOWN
// ===============================

process.on(
  "SIGTERM",
  () => {
    console.log(
      "SIGTERM received."
    );

    process.exit(0);
  }
);

process.on(
  "SIGINT",
  () => {
    console.log(
      "SIGINT received."
    );

    process.exit(0);
  }
);

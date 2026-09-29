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
// ADMIN NUMBERS
// ==================================================

const ADMIN_PHONES = [
  "93774849282@s.whatsapp.net",
  "93764835808@s.whatsapp.net"
];

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
            که Scan نه شو، پاڼه Refresh کړه.
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

        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",

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
// ==================================================

async function sendMessage(
  sock,
  jid,
  text
) {

  await simulateTyping(
    sock,
    jid,
    text
  );

  await sock.sendMessage(
    jid,
    {
      text
    }
  );

}

// ==================================================
// ADMIN COMMANDS
// ==================================================

async function handleAdmin(
  sock,
  jid,
  text
) {

  const command =
    text.trim();

  // حالت

  if (command === "حالت") {

    await sendMessage(
      sock,
      jid,
      "✅ Bot فعال دی او WhatsApp سره وصل دی."
    );

    return true;
  }

  // ping

  if (
    command.toLowerCase() ===
    "ping"
  ) {

    await sendMessage(
      sock,
      jid,
      "pong ✅"
    );

    return true;
  }

  // لیست

  if (command === "لیست") {

    const users =
      loadData(
        MEMORY_FILE
      );

    const registered =
      Object.values(users)
        .filter(
          user =>
            user.status ===
            "registered"
        );

    if (
      registered.length === 0
    ) {

      await sendMessage(
        sock,
        jid,
        "📊 تر اوسه هېڅ ثبت شوی کارن نشته."
      );

      return true;
    }

    let result =
      "📊 ثبت شوي کارنان:\n\n";

    registered.forEach(
      (user, index) => {

        const phone =
          String(
            user.phone || ""
          ).replace(
            "@s.whatsapp.net",
            ""
          );

        result +=
          `${index + 1}. ` +
          `شمېره: ${user.serial_number || "-"} ` +
          `نمبر: +${phone}\n`;

      }
    );

    await sendMessage(
      sock,
      jid,
      result
    );

    return true;
  }

  return false;

}

// ==================================================
// WHATSAPP CONNECTION
// ==================================================

async function connectToWhatsApp() {

  if (isConnecting) {
    return;
  }

  isConnecting = true;

  try {

    console.log("");
    console.log(
      "🚀 Starting WhatsApp..."
    );

    // Auth directory جوړول

    if (
      !fs.existsSync(
        AUTH_DIR
      )
    ) {

      fs.mkdirSync(
        AUTH_DIR,
        {
          recursive: true
        }
      );

    }

    const {
      state,
      saveCreds
    } =
      await useMultiFileAuthState(
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

    // Save WhatsApp session

    sock.ev.on(
      "creds.update",
      saveCreds
    );

    // ==================================================
    // CONNECTION UPDATE
    // ==================================================

    sock.ev.on(
      "connection.update",
      async update => {

        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        // ----------------------------------------------
        // QR CODE
        // ----------------------------------------------

        if (qr) {

          latestQR = qr;

          console.log("");
          console.log(
            "======================================"
          );

          console.log(
            "📱 WHATSAPP QR CODE READY"
          );

          console.log(
            "======================================"
          );

          console.log(
            "Open your Render /qr page."
          );

          console.log(
            "======================================"
          );

          console.log("");

        }

        // ----------------------------------------------
        // CONNECTED
        // ----------------------------------------------

        if (
          connection === "open"
        ) {

          latestQR = "";

          isConnecting = false;

          console.log("");
          console.log(
            "======================================"
          );

          console.log(
            "✅ WHATSAPP CONNECTED SUCCESSFULLY"
          );

          console.log(
            "======================================"
          );

          console.log("");

        }

        // ----------------------------------------------
        // DISCONNECTED
        // ----------------------------------------------

        if (
          connection === "close"
        ) {

          isConnecting = false;

          const statusCode =
            new Boom(
              lastDisconnect?.error
            )
              ?.output
              ?.statusCode;

          console.log("");
          console.log(
            "❌ WhatsApp disconnected:",
            statusCode
          );

          // Logged out

          if (
            statusCode ===
            DisconnectReason.loggedOut
          ) {

            latestQR = "";

            console.log(
              "⚠️ WhatsApp session logged out."
            );

            console.log(
              "Delete the old session and connect again."
            );

            return;
          }

          // Reconnect

          if (reconnectTimer) {

            clearTimeout(
              reconnectTimer
            );

          }

          reconnectTimer =
            setTimeout(
              () => {

                console.log(
                  "🔄 Reconnecting WhatsApp..."
                );

                connectToWhatsApp();

              },
              5000
            );

        }

      }
    );

    // ==================================================
    // MESSAGES
    // ==================================================

    sock.ev.on(
      "messages.upsert",
      async ({
        messages,
        type
      }) => {

        if (
          type !== "notify"
        ) {
          return;
        }

        for (
          const msg
          of messages
        ) {

          try {

            // No message

            if (
              !msg.message
            ) {
              continue;
            }

            // Ignore own message

            if (
              msg.key.fromMe
            ) {
              continue;
            }

            const from =
              msg.key.remoteJid;

            if (!from) {
              continue;
            }

            // Ignore groups

            if (
              isJidGroup(from)
            ) {
              continue;
            }

            const message =
              msg.message;

            let body = "";

            // Normal text

            if (
              message.conversation
            ) {

              body =
                message.conversation;

            }

            // Extended text

            else if (
              message
                .extendedTextMessage
                ?.text
            ) {

              body =
                message
                  .extendedTextMessage
                  .text;

            }

            // Image caption

            else if (
              message
                .imageMessage
                ?.caption
            ) {

              body =
                message
                  .imageMessage
                  .caption;

            }

            // Video caption

            else if (
              message
                .videoMessage
                ?.caption
            ) {

              body =
                message
                  .videoMessage
                  .caption;

            }

            const cleanBody =
              body.trim();

            if (!cleanBody) {
              continue;
            }

            // Prevent duplicate processing

            if (
              userLocks.has(from)
            ) {

              continue;

            }

            userLocks.add(from);

            try {

              const users =
                loadData(
                  MEMORY_FILE
                );

              // ==================================================
              // ADMIN
              // ==================================================

              if (
                isAdmin(from)
              ) {

                const handled =
                  await handleAdmin(
                    sock,
                    from,
                    cleanBody
                  );

                if (handled) {
                  continue;
                }

                const aiReply =
                  await getAIResponse(
                    from,
                    cleanBody
                  );

                await sendMessage(
                  sock,
                  from,
                  aiReply
                );

                continue;

              }

              // ==================================================
              // NEW USER
              // ==================================================

              if (!users[from]) {

                users[from] = {

                  phone: from,

                  status:
                    "unregistered",

                  step: 1,

                  serial_number:
                    "",

                  verification_sent:
                    "",

                  created_at:
                    new Date()
                      .toISOString(),

                  last_message:
                    new Date()
                      .toISOString(),

                  messages: 1

                };

                saveData(
                  MEMORY_FILE,
                  users
                );

                const welcome =
                  `ښه راغلاست! 🌷\n\n` +
                  `د راجستر لپاره لومړی لاندې لینک ته لاړ شئ او اړوند کار بشپړ کړئ، بیا ترلاسه شوی کوډ دلته راولېږئ.\n\n` +
                  `🔗 لینک:\n${CHANNEL_LINK}`;

                await sendMessage(
                  sock,
                  from,
                  welcome
                );

                continue;

              }

              // ==================================================
              // EXISTING USER
              // ==================================================

              const user =
                users[from];

              user.last_message =
                new Date()
                  .toISOString();

              user.messages =
                (user.messages || 0) + 1;

              // ==================================================
              // REGISTERED
              // ==================================================

              if (
                user.status ===
                "registered"
              ) {

                saveData(
                  MEMORY_FILE,
                  users
                );

                const aiReply =
                  await getAIResponse(
                    from,
                    cleanBody
                  );

                await sendMessage(
                  sock,
                  from,
                  aiReply
                );

                continue;

              }

              // ==================================================
              // STEP 1
              // ==================================================

              if (
                user.step === 1
              ) {

                if (
                  cleanBody ===
                  REGISTRATION_CODE
                ) {

                  user.step = 2;

                  saveData(
                    MEMORY_FILE,
                    users
                  );

                  await sendMessage(
                    sock,
                    from,
                    `ستاسو کوډ ترلاسه شو ✅\n\n` +
                    `اوس دوهم پړاو ته لاړ شو.\n` +
                    `مهرباني وکړئ بیا د ثبت کوډ راولېږئ.`
                  );

                } else {

                  await sendMessage(
                    sock,
                    from,
                    `⚠️ کوډ سم نه دی.\n\n` +
                    `لاندې لینک ته لاړ شئ او صحیح کوډ ترلاسه کړئ:\n\n` +
                    `${CHANNEL_LINK}`
                  );

                }

                continue;

              }

              // ==================================================
              // STEP 2
              // ==================================================

              if (
                user.step === 2
              ) {

                if (
                  cleanBody ===
                  REGISTRATION_CODE
                ) {

                  const randomCode =
                    `CONFIRM-${Math.floor(
                      1000 +
                      Math.random() *
                      9000
                    )}`;

                  user.step = 3;

                  user.verification_sent =
                    randomCode;

                  saveData(
                    MEMORY_FILE,
                    users
                  );

                  await sendMessage(
                    sock,
                    from,
                    `دوهم تایید هم ومنل شو ✅\n\n` +
                    `ستاسو د تایید کوډ:\n\n` +
                    `${randomCode}\n\n` +
                    `همدا کوډ بېرته راولېږئ.`
                  );

                } else {

                  await sendMessage(
                    sock,
                    from,
                    "⚠️ کوډ سم نه دی. مهرباني وکړئ صحیح کوډ راولېږئ."
                  );

                }

                continue;

              }

              // ==================================================
              // STEP 3
              // ==================================================

              if (
                user.step === 3
              ) {

                if (
                  cleanBody ===
                  user.verification_sent
                ) {

                  const registeredCount =
                    Object.values(
                      users
                    )
                      .filter(
                        u =>
                          u.status ===
                          "registered"
                      )
                      .length;

                  user.status =
                    "registered";

                  user.step = 4;

                  user.serial_number =
                    String(
                      registeredCount + 1
                    ).padStart(
                      4,
                      "0"
                    );

                  user.verification_sent =
                    "";

                  saveData(
                    MEMORY_FILE,
                    users
                  );

                  await sendMessage(
                    sock,
                    from,
                    `🎉 مبارک!\n\n` +
                    `ستاسو راجستر په بریالیتوب بشپړ شو.\n\n` +
                    `📋 د ثبت شمېره: ${user.serial_number}\n\n` +
                    `اوس کولی شئ له AI سره خبرې وکړئ.`
                  );

                } else {

                  await sendMessage(
                    sock,
                    from,
                    "⚠️ د تایید کوډ سم نه دی."
                  );

                }

                continue;

              }

            } finally {

              userLocks.delete(
                from
              );

            }

          } catch (error) {

            console.log(
              "❌ Message error:",
              error.message
            );

            if (msg.key.remoteJid) {

              userLocks.delete(
                msg.key.remoteJid
              );

            }

          }

        }

      }
    );

  } catch (error) {

    isConnecting = false;

    console.log(
      "❌ WhatsApp startup error:",
      error.message
    );

    if (reconnectTimer) {

      clearTimeout(
        reconnectTimer
      );

    }

    reconnectTimer =
      setTimeout(
        () => {

          connectToWhatsApp();

        },
        10000
      );

  }

}

// ==================================================
// START BOT
// ==================================================

connectToWhatsApp();

// ==================================================
// SHUTDOWN
// ==================================================

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

"use strict";

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

// =====================================================
// CONFIGURATION
// =====================================================

const PORT = Number(process.env.PORT) || 10000;

// د مدیرانو WhatsApp نمبرونه
const ADMIN_PHONES = [
    "93774849282@s.whatsapp.net",
    "93764835808@s.whatsapp.net"
];

// Gemini API Key
// Render > Environment Variables کې یې اضافه کړه
const GEMINI_API_KEY =
    process.env.GEMINI_API_KEY || "";

// WhatsApp session
const AUTH_DIR = path.join(
    __dirname,
    "whatsapp_sessions"
);

// Memory files
const MEMORY_FILE = path.join(
    __dirname,
    "bot_memory.json"
);

const HISTORY_FILE = path.join(
    __dirname,
    "chat_history.json"
);

// =====================================================
// GLOBAL VARIABLES
// =====================================================

let sock = null;
let reconnectTimer = null;
let reconnecting = false;

const userLocks = new Set();

// =====================================================
// CREATE REQUIRED FOLDERS
// =====================================================

if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, {
        recursive: true
    });
}

// =====================================================
// EXPRESS SERVER
// =====================================================

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
    res.status(200).send(
        "Patane Bot is running successfully."
    );
});

app.get("/health", (req, res) => {
    res.status(200).json({
        status: "ok",
        whatsapp: sock
            ? "connected"
            : "disconnected",
        time: new Date().toISOString()
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(
        `🌐 Render server running on port ${PORT}`
    );
});

// =====================================================
// JSON STORAGE
// =====================================================

function loadJSON(file) {
    try {
        if (!fs.existsSync(file)) {
            return {};
        }

        const data = fs.readFileSync(
            file,
            "utf8"
        );

        if (!data.trim()) {
            return {};
        }

        return JSON.parse(data);

    } catch (error) {

        console.log(
            `⚠️ Could not read ${path.basename(file)}`
        );

        return {};
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
            `❌ Could not save ${path.basename(file)}:`,
            error.message
        );
    }
}

// =====================================================
// AI RESPONSE
// =====================================================

async function getAIResponse(
    userId,
    userMessage
) {

    if (!GEMINI_API_KEY) {

        return (
            "بخښنه غواړم، د AI خدمت لا فعال شوی نه دی."
        );
    }

    const historyData =
        loadJSON(HISTORY_FILE);

    const history =
        Array.isArray(
            historyData[userId]
        )
            ? historyData[userId]
            : [];

    const contents =
        history
            .slice(-8)
            .map(item => ({
                role:
                    item.role === "model"
                        ? "model"
                        : "user",

                parts: [
                    {
                        text:
                            String(
                                item.content || ""
                            )
                    }
                ]
            }));

    contents.push({
        role: "user",
        parts: [
            {
                text: userMessage
            }
        ]
    });

    const systemInstruction = `
تاسو د پښتو ژبې یو مرستندوی یاست.

د کاروونکي پښتو که املايي تېروتنې ولري،
د مطلب له مخې یې درک کړئ.

په ساده، روانه او طبیعي پښتو ځواب ورکړئ.

بې ضرورته اوږده ځواب مه ورکوئ.

که څوک پوښتنه وکړي:
"تاسو څوک یاست؟"
یا
"ایا تاسو بوټ یاست؟"

ووایاست:
"زه پټان یم، ستاسو په خدمت کې یم."

د هر کاروونکي خبرې او معلومات جلا وساتئ.

د یوه کاروونکي شخصي معلومات بل کاروونکي ته
مه ښکاره کوئ.
`;

    try {

        const apiUrl =
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
            encodeURIComponent(
                GEMINI_API_KEY
            );

        const response =
            await axios.post(
                apiUrl,
                {
                    systemInstruction: {
                        parts: [
                            {
                                text:
                                    systemInstruction
                            }
                        ]
                    },

                    contents: contents
                },
                {
                    timeout: 20000,

                    headers: {
                        "Content-Type":
                            "application/json"
                    }
                }
            );

        const parts =
            response
                .data
                ?.candidates?.[0]
                ?.content?.parts;

        const aiText =
            Array.isArray(parts)
                ? parts
                    .map(part =>
                        part.text || ""
                    )
                    .join("")
                    .trim()
                : "";

        if (!aiText) {
            throw new Error(
                "Empty AI response"
            );
        }

        // د کاروونکي پیغام ثبتول
        history.push({
            role: "user",
            content: userMessage
        });

        // د AI ځواب ثبتول
        history.push({
            role: "model",
            content: aiText
        });

        // یوازې وروستي 20 ساتل
        historyData[userId] =
            history.slice(-20);

        saveJSON(
            HISTORY_FILE,
            historyData
        );

        return aiText;

    } catch (error) {

        console.log(
            "❌ Gemini API error:"
        );

        if (error.response) {
            console.log(
                error.response.data
            );
        } else {
            console.log(
                error.message
            );
        }

        return (
            "بخښنه غواړم، اوس مهال د AI خدمت کې تخنیکي ستونزه ده. لږ وروسته بیا هڅه وکړئ."
        );
    }
}

// =====================================================
// SEND MESSAGE
// =====================================================

async function sendReply(
    whatsapp,
    jid,
    text
) {

    try {

        const message =
            String(text || "").trim();

        if (!message) {
            return;
        }

        // typing
        try {

            await whatsapp.sendPresenceUpdate(
                "composing",
                jid
            );

        } catch (_) {}

        // طبیعي لنډ ځنډ
        const delay =
            Math.min(
                2500,
                Math.max(
                    700,
                    message.length * 10
                )
            );

        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    delay
                )
        );

        await whatsapp.sendMessage(
            jid,
            {
                text: message
            }
        );

        try {

            await whatsapp.sendPresenceUpdate(
                "paused",
                jid
            );

        } catch (_) {}

    } catch (error) {

        console.log(
            "❌ Message send error:",
            error.message
        );
    }
}

// =====================================================
// SAVE USER
// =====================================================

function saveUser(jid) {

    const users =
        loadJSON(MEMORY_FILE);

    if (!users[jid]) {

        users[jid] = {
            phone: jid,

            firstMessage:
                new Date().toISOString(),

            messages: 0
        };
    }

    users[jid].messages =
        Number(
            users[jid].messages || 0
        ) + 1;

    users[jid].lastMessage =
        new Date().toISOString();

    saveJSON(
        MEMORY_FILE,
        users
    );
}

// =====================================================
// ADMIN COMMANDS
// =====================================================

async function handleAdminCommand(
    whatsapp,
    jid,
    text
) {

    // حالت
    if (text === "حالت") {

        await sendReply(
            whatsapp,
            jid,
            "✅ بوټ فعال دی او WhatsApp سره وصل دی."
        );

        return true;
    }

    // Ping
    if (
        text.toLowerCase() ===
        "ping"
    ) {

        await sendReply(
            whatsapp,
            jid,
            "pong ✅"
        );

        return true;
    }

    // لیست
    if (text === "لیست") {

        const users =
            loadJSON(
                MEMORY_FILE
            );

        const list =
            Object.values(users);

        if (list.length === 0) {

            await sendReply(
                whatsapp,
                jid,
                "📋 تر اوسه هېڅ کاروونکی ثبت شوی نه دی."
            );

            return true;
        }

        let result =
            "📋 د ثبت شویو کاروونکو لیست:\n\n";

        list
            .slice(0, 100)
            .forEach(
                (user, index) => {

                    result +=
                        `${index + 1}. ${user.phone} — ${user.messages || 0} پیغامونه\n`;
                }
            );

        if (list.length > 100) {

            result +=
                `\n... او نور ${list.length - 100} کسان.`;
        }

        await sendReply(
            whatsapp,
            jid,
            result
        );

        return true;
    }

    // AI
    return false;
}

// =====================================================
// WHATSAPP CONNECTION
// =====================================================

async function connectToWhatsApp() {

    if (reconnecting) {
        return;
    }

    reconnecting = true;

    try {

        console.log(
            "🔄 Starting WhatsApp..."
        );

        const {
            state,
            saveCreds
        } =
            await useMultiFileAuthState(
                AUTH_DIR
            );

        const newSock =
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

        sock = newSock;

        // Credentials
        sock.ev.on(
            "creds.update",
            saveCreds
        );

        // =================================================
        // CONNECTION UPDATE
        // =================================================

        sock.ev.on(
            "connection.update",
            async update => {

                const {
                    connection,
                    lastDisconnect
                } = update;

                // Connected
                if (
                    connection === "open"
                ) {

                    console.log(
                        "======================================"
                    );

                    console.log(
                        "✅ WhatsApp connected successfully"
                    );

                    console.log(
                        "🤖 Patane Bot is online"
                    );

                    console.log(
                        "======================================"
                    );

                    reconnecting = false;

                    return;
                }

                // Disconnected
                if (
                    connection === "close"
                ) {

                    sock = null;
                    reconnecting = false;

                    let statusCode =
                        null;

                    try {

                        if (
                            lastDisconnect?.error
                        ) {

                            statusCode =
                                new Boom(
                                    lastDisconnect.error
                                )
                                    .output
                                    ?.statusCode;
                        }

                    } catch (_) {}

                    console.log(
                        `⚠️ WhatsApp disconnected. Code: ${statusCode}`
                    );

                    // Logout
                    if (
                        statusCode ===
                        DisconnectReason.loggedOut
                    ) {

                        console.log(
                            "❌ WhatsApp session logged out."
                        );

                        console.log(
                            "🔑 New WhatsApp login is required."
                        );

                        return;
                    }

                    // Temporary disconnect
                    if (
                        !reconnectTimer
                    ) {

                        console.log(
                            "🔄 Reconnecting in 5 seconds..."
                        );

                        reconnectTimer =
                            setTimeout(
                                () => {

                                    reconnectTimer =
                                        null;

                                    connectToWhatsApp();

                                },
                                5000
                            );
                    }
                }
            }
        );

        // =================================================
        // INCOMING MESSAGES
        // =================================================

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

                    let jid = null;

                    try {

                        // No message
                        if (
                            !msg.message
                        ) {
                            continue;
                        }

                        // Own message
                        if (
                            msg.key?.fromMe
                        ) {
                            continue;
                        }

                        jid =
                            msg.key
                                ?.remoteJid;

                        if (!jid) {
                            continue;
                        }

                        // Group messages ignored
                        if (
                            isJidGroup(jid)
                        ) {
                            continue;
                        }

                        // Text message
                        const body =
                            msg.message
                                ?.conversation ||

                            msg.message
                                ?.extendedTextMessage
                                ?.text ||

                            msg.message
                                ?.imageMessage
                                ?.caption ||

                            msg.message
                                ?.videoMessage
                                ?.caption ||

                            "";

                        const text =
                            String(
                                body
                            ).trim();

                        if (!text) {
                            continue;
                        }

                        // Prevent simultaneous processing
                        if (
                            userLocks.has(jid)
                        ) {
                            continue;
                        }

                        userLocks.add(jid);

                        console.log(
                            `📩 ${jid}: ${text}`
                        );

                        // =====================================
                        // ADMIN
                        // =====================================

                        if (
                            ADMIN_PHONES.includes(
                                jid
                            )
                        ) {

                            const handled =
                                await handleAdminCommand(
                                    sock,
                                    jid,
                                    text
                                );

                            if (
                                handled
                            ) {
                                continue;
                            }
                        }

                        // =====================================
                        // USER MEMORY
                        // =====================================

                        saveUser(jid);

                        // =====================================
                        // AI
                        // =====================================

                        const reply =
                            await getAIResponse(
                                jid,
                                text
                            );

                        await sendReply(
                            sock,
                            jid,
                            reply
                        );

                    } catch (error) {

                        console.log(
                            "❌ Message processing error:",
                            error.message
                        );

                    } finally {

                        if (jid) {
                            userLocks.delete(
                                jid
                            );
                        }
                    }
                }
            }
        );

    } catch (error) {

        reconnecting = false;
        sock = null;

        console.log(
            "❌ WhatsApp startup error:",
            error.message
        );

        if (!reconnectTimer) {

            reconnectTimer =
                setTimeout(
                    () => {

                        reconnectTimer =
                            null;

                        connectToWhatsApp();

                    },
                    10000
                );
        }
    }
}

// =====================================================
// START
// =====================================================

console.log(
    "======================================"
);

console.log(
    "🚀 Patane Bot starting..."
);

console.log(
    `🌐 Port: ${PORT}`
);

console.log(
    "======================================"
);

connectToWhatsApp();

// =====================================================
// SAFE SHUTDOWN
// =====================================================

process.on(
    "SIGTERM",
    async () => {

        console.log(
            "🛑 SIGTERM received. Shutting down..."
        );

        try {

            if (sock) {
                sock.end(
                    new Error(
                        "Server shutting down"
                    )
                );
            }

        } catch (_) {}

        process.exit(0);
    }
);

process.on(
    "SIGINT",
    async () => {

        console.log(
            "🛑 SIGINT received. Shutting down..."
        );

        try {

            if (sock) {
                sock.end(
                    new Error(
                        "Server shutting down"
                    )
                );
            }

        } catch (_) {}

        process.exit(0);
    }
);

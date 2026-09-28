const { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    isJidGroup 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const express = require('express');

// ستاسو د پلان او غوښتنو پر بنسټ دایمي ثابت معلومات
const ADMIN_PHONE = '93774849282@s.whatsapp.net'; 
const CHANNEL_LINK = 'https://whatsapp.com';
const REGISTRATION_CODE = 'SDA25324809$';
const API_KEY = 'AQ.Ab8RN6J52fsSfbnZupajRubLvUnNUgtT3vpbpHy4n_Kc7oHTrA';

// د ګډوډۍ او پرله پسې میسجونو د مخنیوي لپاره (Message Queue Locking)
const userLocks = new Set();

// د لویې حافظې او راجستر کتاب (SQLite3 Database) پیل کول
const db = new sqlite3.Database('./bot_memory.db', (err) => {
    if (err) console.error('[DB Error]:', err.message);
    console.log('📦 د شمیرو د دایمي ساتلو کتاب په بریالیتوب سره وصل شو.');
});

// د ډیټابیس د جدولونو چمتو کول (شمیرې پکې د تل لپاره خوندي پاتې کیږي)
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        phone TEXT PRIMARY KEY,
        status TEXT DEFAULT 'unregistered',
        step INTEGER DEFAULT 1,
        serial_number TEXT DEFAULT '',
        verification_sent TEXT DEFAULT ''
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS chat_history (
        phone TEXT,
        role TEXT,
        content TEXT
    )`);
});

// کلاوډ سرور ته د دایمي ویښ پاتې کېدو اښتیزاز (Keep-Alive Multi-Threading Webhook)
const app = express();
app.get('/', (req, res) => res.send('پټان بوټ په منظم او دایمي ډول ویښ دی!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`📡 کlaوډ سرور ته د دایمي ویښ پاتې کېدو اښتیزاز فعال شو پر پورټ: ${PORT}`));

// ۱۰۰٪ مصنوعي زیرکتیا له څو سرچینو سره او د ناسمې املا پېژندنه (Multi-Model AI Fallback)
async function getAIResponse(userPhone, userMessage) {
    // د محرمیت ساتلو او د چاټونو د جلاوالي سیسټم (Isolated Chat History)
    const history = await new Promise((resolve) => {
        db.all(`SELECT role, content FROM chat_history WHERE phone = ? LIMIT 6`, [userPhone], (err, rows) => {
            resolve(rows || []);
        });
    });

    const messages = history.map(h => ({ role: h.role, parts: [{ text: h.content }] }));
    messages.push({ role: 'user', parts: [{ text: userMessage }] });

    // ستاسو د کلتوري پښتو او هوهیت د پټولو لارښوونه
    const systemInstruction = "تاسو یو ریښتینی افغان پښتون یاست او هیڅکله داسې کلمې نه کاروئ چې خلک پوه شي تاسو بوټ یاست. که څوک پوښتنه وکړي 'تاسو څوک یاست؟' یا 'ایا تاسو بوټ یاست؟' نو په کلکه او په پښتونولۍ ورته ووایه: 'زه پټان یم، 24 هر وخت ستاسو په حدمت کې یم'. که د کاروونکي پښتو املا خرابه او ناسمه وي (لکه سنګه، اواړم)، بیا هم د هغه په مطلب او غوښتنه پوره پوه شه او په خورا خوږه, روانه او سمه پښتو ژبه بېرته ځواب ورکړه. د هر کاروونکي چاټ او محرمیت په جلا توګه وساته او د بل چا سره یې مه ګډوه.";

    // لومړۍ سرچینه (Primary AI - Google Gemini API)
    try {
        const response = await axios.post(`https://googleapis.com{API_KEY}`, {
            contents: messages,
            systemInstruction: { parts: [{ text: systemInstruction }] }
        }, { timeout: 7000 });
        
        const aiText = response.data.candidates.content.parts.text;
        
        // د چاټ د تاریخ خوندي کول
        db.run(`INSERT INTO chat_history (phone, role, content) VALUES (?, 'user', ?)`, [userPhone, userMessage]);
        db.run(`INSERT INTO chat_history (phone, role, content) VALUES (?, 'model', ?)`, [userPhone, aiText]);
        return aiText;
    } catch (e) {
        console.log("⚠️ لومړۍ سرچینه ځنډ لري، په اتومات ډول دوهم AI (Fallback) ته لاړ شو...");
        // دوهمه سرچینه که لومړۍ بنده شي (Secondary AI Fallback)
        try {
            const altResponse = await axios.post('https://deepseek.com', {
                model: "deepseek-chat",
                messages: [
                    { role: "system", content: systemInstruction },
                    ...history.map(h => ({ role: h.role === 'model' ? 'assistant' : 'user', content: h.content })),
                    { role: "user", content: userMessage }
                ]
            }, { headers: { 'Authorization': `Bearer ${API_KEY}` }, timeout: 7000 });
            return altResponse.data.choices.message.content;
        } catch (err) {
            return "سلامونه ګرانه! زه پټان یم ستاسو په خدمت کې، مګر داسې ښکاري چې زما ذهن ته د رسېدو شبکې مصروفې دي. یو څو ثانیې وروسته بېرته پوښتنه راولېږه، زه ستا خدمت ته ولاړ یم.";
        }
    }
}

// د انسان په څېر د چلند لوپ او اتوماتیک ټایپنګ (Anti-Ban Guard)
async function simulateTyping(sock, jid, text) {
    await sock.sendPresenceUpdate('composing', jid);
    const delay = Math.min(5000, Math.max(1500, text.length * 20));
    await new Promise(res => setTimeout(res, delay));
    await sock.sendPresenceUpdate('paused', jid);
}

// د غړو معرفي کولو پرمختللی انجن (Background Add Member Engine)
async function backgroundAddMembers(sock, groupJid, phoneNumbers) {
    console.log(`🚀 د مدیر په امر په شالید کې ګروپ ته د ${phoneNumbers.length} شمیرو اډ کول پیل شول...`);
    for (const phone of phoneNumbers) {
        try {
            const formattedJid = phone.trim().replace('+', '') + '@s.whatsapp.net';
            await sock.groupParticipantsUpdate(groupJid, [formattedJid], "add");
            console.log(`✅ شمیره په بریالیتوب سره اډ شوه: ${formattedJid}`);
        } catch (err) {
            console.log(`❌ د شمیرې په اډ کولو کې تېروتنه: ${phone}`);
        }
        // د بېن د مخنیوي لپاره د هر غړي ترمنځ لویه او تصادفي وقفه (Anti-Ban Timeout)
        const randomDelay = Math.floor(Math.random() * (40000 - 20000 + 1)) + 20000; 
        await new Promise(res => setTimeout(res, randomDelay));
    }
}

// د واټساپ اصلي پیوستون او لوپ
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('whatsapp_sessions');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            console.log('⚠️ اړیکه پرې شوه. د بېرته اتومات لوګین کېدو هڅه تل جریان لري...', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ پټان بوټ له واټساپ سره وصل شو او خدمت ته چمتو دی!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages;
        if (!msg.message || msg.key.fromMe || isJidGroup(msg.key.remoteJid)) return;

        const from = msg.key.remoteJid;
        const msgType = Object.keys(msg.message);
        const body = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        const cleanBody = body.trim();

        if (userLocks.has(from)) return;
        userLocks.add(from);

        try {
            // الف: د محترم مدیر یا VIP کارونکي لپاره صلاحیت
            if (from === ADMIN_PHONE) {
                if (cleanBody === 'لیست') {
                    db.all(`SELECT serial_number, phone FROM users WHERE status='registered' ORDER BY serial_number ASC`, [], async (err, rows) => {
                        let rList = "📊 د ټولو راجستر شویو کسانو نوی لیست:\n";
                        if (!rows || rows.length === 0) {
                            rList += "تر اوسه هیچ څوک نه دی راجستر شوی.";
                        } else {
                            rows.forEach(r => {
                                const purePhone = r.phone.replace('@s.whatsapp.net', '');
                                rList += `کس راجیستر: ${r.serial_number} بیا نمبر: +${purePhone}\n`;
                            });
                        }
                        await simulateTyping(sock, from, rList);
                        await sock.sendMessage(from, { text: rList });
                    });
                } else if (cleanBody.startsWith('اډ ګروپ')) {
                    await sock.sendMessage(from, { text: "پوشوم ګران مدیر صیب! ستاسو لارښوونه ۱۰۰٪ مصنوعي زیرکتیا ته ورسېده. د شمیرو د په ورځ کې د یو یو اډ کولو چارې په منظم ډول په شالید کې پیل شوې." });
                    
                    const parts = cleanBody.split(' ');
                    const groupJid = parts[1];
                    const numbersList = parts.slice(2).join(' ').split(',');
                    
                    backgroundAddMembers(sock, groupJid, numbersList);
                } else {
                    const aiReply = await getAIResponse(from, cleanBody);
                    await simulateTyping(sock, from, aiReply);
                    await sock.sendMessage(from, { text: aiReply });
                }
                userLocks.delete(from);
                return;
            }

            // ب: د عامو کاروونکو لپاره قوانین او منظم راجستر سیسټم
            db.get(`SELECT * FROM users WHERE phone = ?`, [from], async (err, user) => {
                if (!user) {
                    db.run(`INSERT INTO users (phone, status, step) VALUES (?, 'unregistered', 1)`, [from]);
                    const welcome = `ښه راغلاست! د AI سره د راجستر لپاره لومړی د لاندې لینک په واسطه د AI STUDIO ته لاړشئ او فالو یې کړئ. په هغه کې چې کوم کوډ دی، هغه موږ ته راولیږئ ترڅو له موږ سره راجستر شئ.\n\nد تایید لینک: ${CHANNEL_LINK}`;
                    await simulateTyping(sock, from, welcome);
                    await sock.sendMessage(from, { text: welcome });

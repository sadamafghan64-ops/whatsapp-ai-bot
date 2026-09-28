const { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    isJidGroup 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const axios = require('axios');
const express = require('express');

// ستاسو د غوښتنو پر بنسټ د دوه مدیرانو (Multi-Admin) دایمي معلومات
const ADMIN_PHONES = [
    '93774849282@s.whatsapp.net',
    '93764835808@s.whatsapp.net'
]; 
const CHANNEL_LINK = 'https://whatsapp.com';
const REGISTRATION_CODE = 'SDA25324809$';
const API_KEY = 'AQ.Ab8RN6J52fsSfbnZupajRubLvUnNUgtT3vpbpHy4n_Kc7oHTrA';

// د ګډوډۍ او پرله پسې میسجونو د مخنیوي لپاره (Message Queue Locking)
const userLocks = new Set();

// د دایمي حافظې د راجستر کتاب چمتو کول (Safe Local Storage JSON System)
const MEMORY_FILE = './bot_memory.json';
const HISTORY_FILE = './chat_history.json';

function loadData(file) {
    if (!fs.existsSync(file)) return {};
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
}

function saveData(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// کلاوډ سرور ته د دایمي ویښ پاتې کېدو اښتیزاز
const app = express();
app.get('/', (req, res) => res.send('پټان بوټ په منظم او دایمي ډول ویښ دی!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`📡 کلاوډ سرور ته د دایمي فریکونسي اښتیزاز فعال شو پر پورټ: ${PORT}`));

// ۱۰۰٪ مصنوعي زیرکتیا له څو سرچینو سره او د ناسمې املا پېژندنه (Multi-Model AI Fallback)
async function getAIResponse(userPhone, userMessage) {
    const historyData = loadData(HISTORY_FILE);
    const history = historyData[userPhone] || [];

    const messages = history.slice(-6).map(h => ({ role: h.role, parts: [{ text: h.content }] }));
    messages.push({ role: 'user', parts: [{ text: userMessage }] });

    const systemInstruction = "تاسو یو ریښتینی افغان پښتون یاست او هیڅکله داسې کلمې نه کاروئ چې خلک پوه شي تاسو بوټ یاست. که څوک پوښتنه وکړي 'تاسو څوک یاست؟' یا 'ایا تاسو بوټ یاست؟' نو په کلکه او په پښتونولۍ ورته ووایه: 'زه پټان یم، 24 هر وخت ستاسو په حدمت کې یم'. که د کاروونکي پښتو املا خرابه او ناسمه وي (لکه سنګه، اواړم)، بیا هم د هغه په مطلب او غوښتنه پوره پوه شه او په خورا خوږه، روانه او سمه پښتو ژبه بېرته ځواب ورکړه. د هر کاروونکي چاټ او محرمیت په جلا توګه وساته او د بل چا سره یې مه ګډوه.";

    try {
        const response = await axios.post(`https://googleapis.com{API_KEY}`, {
            contents: messages,
            systemInstruction: { parts: [{ text: systemInstruction }] }
        }, { timeout: 7000 });
        
        const aiText = response.data.candidates.content.parts.text;
        
        history.push({ role: 'user', content: userMessage });
        history.push({ role: 'model', content: aiText });
        historyData[userPhone] = history;
        saveData(HISTORY_FILE, historyData);
        return aiText;
    } catch (e) {
        console.log("⚠️ لومړۍ سرچینه ځنډ لري، په اتومات ډول دوهم AI (Fallback) ته لاړ شو...");
        try {
            const altResponse = await axios.post('https://deepseek.com', {
                model: "deepseek-chat",
                messages: [
                    { role: "system", content: systemInstruction },
                    ...history.slice(-6).map(h => ({ role: h.role === 'model' ? 'assistant' : 'user', content: h.content })),
                    { role: "user", content: userMessage }
                ]
            }, { headers: { 'Authorization': `Bearer ${API_KEY}` }, timeout: 7000 });
            return altResponse.data.choices.message.content;
        } catch (err) {
            return "سلامونه ګرانه! زه پټان یم ستاسو په خدمت کې، مګر داسې ښکاري چې زما ذهن ته د رسېدو شبکې مصروفې دي. یو څو ثانیې وروسته بېرته پوښتنه راولېږه، زه ستا خدمت ته ولاړ یم.";
        }
    }
}

async function simulateTyping(sock, jid, text) {
    await sock.sendPresenceUpdate('composing', jid);
    const delay = Math.min(5000, Math.max(1500, text.length * 20));
    await new Promise(res => setTimeout(res, delay));
    await sock.sendPresenceUpdate('paused', jid);
}

// د غړو معرفي کولو پرمختللی انجن
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
        const randomDelay = Math.floor(Math.random() * (40000 - 20000 + 1)) + 20000; 
        await new Promise(res => setTimeout(res, randomDelay));
    }
}

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
            const users = loadData(MEMORY_FILE);

            if (ADMIN_PHONES.includes(from)) {
                if (cleanBody === 'لیست') {
                    let rList = "📊 د ټولو راجستر شویو کسانو نوی لیست:\n";
                    const registeredUsers = Object.values(users).filter(u => u.status === 'registered').sort((a,b) => a.serial_number.localeCompare(b.serial_number));
                    
                    if (registeredUsers.length === 0) {
                        rList += "تر اوسه هیڅ څوک نه دی راجستر شوی.";
                    } else {
                        registeredUsers.forEach(r => {
                            const purePhone = r.phone.replace('@s.whatsapp.net', '');
                            rList += `کس راجیستر: ${r.serial_number} بیا نمبر: +${purePhone}\n`;
                        });
                    }
                    await simulateTyping(sock, from, rList);
                    await sock.sendMessage(from, { text: rList });
                } else if (cleanBody.startsWith('اډ ګروپ')) {
                    await sock.sendMessage(from, { text: "پوشوم ګران مدیر صیب! ستاسو لارښوونه ۱۰۰٪ مصنوعي زیرکتیا ته ورسېده. د شمیرو د په ورځ کې د یو یو اډ کولو چارې په منظم ډول په شالید کې پیل شوې." });
                    const parts = cleanBody.split(' ');
                    const groupJid = parts[2];
                    const numbersList = parts.slice(3).join(' ').split(',');
                    backgroundAddMembers(sock, groupJid, numbersList);
                } else {
                    const aiReply = await getAIResponse(from, cleanBody);
                    await simulateTyping(sock, from, aiReply);
                    await sock.sendMessage(from, { text: aiReply });
                }
                userLocks.delete(from);
                return;
            }

            let user = users[from];
            if (!user) {
                users[from] = { phone: from, status: 'unregistered', step: 1, serial_number: '', verification_sent: '' };
                saveData(MEMORY_FILE, users);
                const welcome = `ښه راغلاست! د AI سره د راجستر لپاره لومړی د لاندې لینک په واسطه د AI STUDIO ته لاړشئ او فالو یې کړئ. په هغه کې چې کوم کوډ دی، هغه موږ ته راولیږئ ترڅو له موږ سره راجستر شئ.\n\nد تایید لینک: ${CHANNEL_LINK}`;
                await simulateTyping(sock, from, welcome);
                await sock.sendMessage(from, { text: welcome });
            } else if (user.status === 'unregistered') {
                if (cleanBody === REGISTRATION_CODE && user.step === 1) {
                    user.step = 2;
                    users[from] = user;
                    saveData(MEMORY_FILE, users);
                    const tryAgain = `بیا کوشش وکړی! کیدای شي تاسو د AI STUDIO چینل نه وي فالو کړی او یا تخنیکي ستونزه وي. بیا لاندې لینک ته لاړ شئ او ډاډ ترلاسه کړئ چې فالو مو کړی دی او کوډ سم راولیږئ.\n\nلینک: ${CHANNEL_LINK}`;
                    await simulateTyping(sock, from, tryAgain);
                    await sock.sendMessage(from, { text: tryAgain });
                } else if (cleanBody === REGISTRATION_CODE && user.step === 2) {
                    const randomCode = `CONFIRM-${Math.floor(1000 + Math.random() * 9000)}`;
                    user.step = 3;
                    user.verification_sent = randomCode;
                    users[from] = user;
                    saveData(MEMORY_FILE, users);

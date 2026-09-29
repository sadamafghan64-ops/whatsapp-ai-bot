// ==================================================
// WHATSAPP QR CONNECTION
// ==================================================

let reconnectTimer = null;
let latestQR = "";

async function connectToWhatsApp() {
  try {
    console.log("🚀 WhatsApp starting...");

    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
      auth: state,

      logger: pino({
        level: "silent"
      }),

      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on(
      "connection.update",
      async (update) => {

        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        // ------------------------------------------
        // QR CODE
        // ------------------------------------------

        if (qr) {
          latestQR = qr;

          console.log("");
          console.log("================================");
          console.log("📱 NEW WHATSAPP QR CODE");
          console.log("================================");
          console.log("QR Code ready at:");
          console.log(
            "https://YOUR-RENDER-SERVICE.onrender.com/qr"
          );
          console.log("================================");
          console.log("");
        }

        // ------------------------------------------
        // CONNECTED
        // ------------------------------------------

        if (connection === "open") {

          latestQR = "";

          console.log("");
          console.log("================================");
          console.log("✅ WHATSAPP CONNECTED");
          console.log("================================");
          console.log("");
        }

        // ------------------------------------------
        // DISCONNECTED
        // ------------------------------------------

        if (connection === "close") {

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

            return;
          }

          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
          }

          reconnectTimer = setTimeout(() => {
            connectToWhatsApp();
          }, 5000);
        }
      }
    );

    // ------------------------------------------
    // MESSAGES
    // ------------------------------------------

    sock.ev.on(
      "messages.upsert",
      async ({
        messages,
        type
      }) => {

        if (type !== "notify") {
          return;
        }

        for (const msg of messages) {

          try {

            if (!msg.message) {
              continue;
            }

            if (msg.key.fromMe) {
              continue;
            }

            const from =
              msg.key.remoteJid;

            if (!from) {
              continue;
            }

            if (isJidGroup(from)) {
              continue;
            }

            const message =
              msg.message;

            let body = "";

            if (message.conversation) {

              body =
                message.conversation;

            } else if (
              message
                .extendedTextMessage
                ?.text
            ) {

              body =
                message
                  .extendedTextMessage
                  .text;

            } else if (
              message
                .imageMessage
                ?.caption
            ) {

              body =
                message
                  .imageMessage
                  .caption;

            } else if (
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

            if (userLocks.has(from)) {
              continue;
            }

            userLocks.add(from);

            try {

              const users =
                loadData(MEMORY_FILE);

              // ADMIN
              if (isAdmin(from)) {

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

              // NEW USER
              if (!users[from]) {

                users[from] = {
                  phone: from,
                  status: "unregistered",
                  step: 1,
                  serial_number: "",
                  verification_sent: "",
                  created_at:
                    new Date().toISOString(),
                  last_message:
                    new Date().toISOString(),
                  messages: 1
                };

                saveData(
                  MEMORY_FILE,
                  users
                );

                await sendMessage(
                  sock,
                  from,
                  `ښه راغلاست! 🌷\n\n` +
                  `د راجستر لپاره لاندې لینک ته لاړ شئ او اړوند کار بشپړ کړئ، بیا ترلاسه شوی کوډ دلته راولېږئ.\n\n` +
                  `لینک:\n${CHANNEL_LINK}`
                );

                continue;
              }

              const user = users[from];

              // REGISTERED USER
              if (
                user.status ===
                "registered"
              ) {

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

              // STEP 1
              if (user.step === 1) {

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
                    "ستاسو کوډ ترلاسه شو ✅\n\nاوس دوهم پړاو ته لاړ شو."
                  );

                } else {

                  await sendMessage(
                    sock,
                    from,
                    `⚠️ کوډ سم نه دی.\n\n${CHANNEL_LINK}`
                  );
                }

                continue;
              }

              // STEP 2
              if (user.step === 2) {

                if (
                  cleanBody ===
                  REGISTRATION_CODE
                ) {

                  const randomCode =
                    `CONFIRM-${Math.floor(
                      1000 +
                      Math.random() * 9000
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
                    `د تایید کوډ:\n${randomCode}\n\n` +
                    `دا کوډ راولېږئ.`
                  );

                } else {

                  await sendMessage(
                    sock,
                    from,
                    "⚠️ کوډ سم نه دی."
                  );
                }

                continue;
              }

              // STEP 3
              if (user.step === 3) {

                if (
                  cleanBody ===
                  user.verification_sent
                ) {

                  const registeredCount =
                    Object.values(users)
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
                    ).padStart(4, "0");

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
                    `ستاسو راجستر بشپړ شو.\n\n` +
                    `د ثبت شمېره: ${user.serial_number}\n\n` +
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

              userLocks.delete(from);
            }

          } catch (error) {

            console.log(
              "❌ Message error:",
              error.message
            );
          }
        }
      }
    );

  } catch (error) {

    console.log(
      "❌ WhatsApp startup error:",
      error.message
    );

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
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
// START
// ==================================================

connectToWhatsApp();

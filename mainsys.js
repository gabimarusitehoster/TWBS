const express = require('express');
const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const { loadUserData, saveUserData, ensureFollowed } = require('./tools/main');
const baileys = require('baileys');
const QRCode = require('qrcode');
const { createCanvas } = require('canvas');

const PORT = process.env.PORT || 3000;
const SUPPORT_CHANNEL = '@gabimarutechchannel';
const ADMIN_CHAT_ID = "7638524824";
const BotToken = "7508572561:AAHRf9zWM2SKKfHk0p1i3taB0jZc_8Et5ec";

const bot = new Telegraf(BotToken);

const pairingMethods = {};

bot.start(async (ctx) => {
  const userId = ctx.from.id.toString();
  const userData = loadUserData();

  if (!(await ensureFollowed(ctx, SUPPORT_CHANNEL))) {
    return ctx.reply('❌ Please follow our support channel to use this bot.', {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Support Channel',
              url: `https://t.me/${SUPPORT_CHANNEL.replace('@', '')}`,
            },
          ],
        ],
      },
    });
  }

  if (!userData[userId]) {
    userData[userId] = { username: ctx.from.username || '', numbers: [], referrals: 0 };
    saveUserData(userData);
  }

  ctx.reply(
    'Choose your pairing method:',
    Markup.inlineKeyboard([
      [Markup.button.callback('Scan QR Code', 'qr_method')],
      [Markup.button.callback('Use Pairing Code', 'code_method')],
    ])
  );
});

bot.action('qr_method', async (ctx) => {
  pairingMethods[ctx.from.id] = 'qr';
  ctx.reply('Please send your WhatsApp number in international format (e.g. 234XXXXXXXXXX) to pair with QR code:');
});

bot.action('code_method', async (ctx) => {
  pairingMethods[ctx.from.id] = 'code';
  ctx.reply('Please send your WhatsApp number in international format (e.g. 234XXXXXXXXXX) to pair with pairing code:');
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const method = pairingMethods[userId];
  const number = ctx.message.text.trim();
  const userData = loadUserData();

  if (!method) return;

  if (!/^\d{10,15}$/.test(number)) return ctx.reply('❌ Invalid number format.');

  if (!userData[userId]) userData[userId] = { username: ctx.from.username || '', numbers: [], referrals: 0 };

  const alreadyUsed = Object.values(userData).some((u) => u.numbers.includes(number));
  if (alreadyUsed) return ctx.reply('❌ Number already paired by another user.');

  const maxPair = 3 + userData[userId].referrals;
  if (userData[userId].numbers.length >= maxPair) return ctx.reply('❌ Pairing limit reached. Refer users to increase limit.');

  userData[userId].numbers.push(number);
  saveUserData(userData);

  if (method === 'qr') {
    ctx.reply('✅ Number saved. Please wait while we generate the QR code...');
    const qr = await generateQR(number);
    bot.telegram.sendPhoto(ctx.chat.id, { source: qr }, { caption: 'Scan this QR code to pair your WhatsApp.' });
  } else if (method === 'code') {
    ctx.reply('✅ Number saved. Please wait while we generate the pairing code...');
    const code = await generatePairingCode(number);
    bot.telegram.sendMessage(ctx.chat.id, `🔑 Your pairing code is: \`${code}\`\nGo to WhatsApp > Link a Device > Enter Code.`);
  }

  delete pairingMethods[userId];
});

const app = express();

app.get('/', (req, res) => {
  res.send('Telegram WhatsApp Pair Bot is Running.');
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = baileys;
const pendingQRRequests = [];
const pendingPairingCodeRequests = [];

async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState(`sessions/${phoneNumber}`);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ auth: state, version, browser: Browsers.macOS('Chrome') });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { qr, connection } = update;

    if (qr && pendingQRRequests.length > 0) {
      const request = pendingQRRequests.shift();
      const buffer = await generateQR(qr);
      await bot.telegram.sendPhoto(request.chatId, { source: buffer }, { caption: 'Scan this QR code to connect your WhatsApp.' });
    }

    if (connection === 'open') {
      console.log('WA Connected');
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, '✅ WhatsApp bot connected.');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const from = msg.key.remoteJid.replace('@s.whatsapp.net', '');
      const userData = loadUserData();

      const isPaired = Object.values(userData).some((u) => u.numbers.includes(from));
      if (!isPaired) {
        await sock.sendMessage(msg.key.remoteJid, {
          text: '❌ This number is not paired with our system. Use the Telegram bot to pair.',
        });
        return;
      }

      const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      const command = body.trim().toLowerCase();

      switch (command) {
        case '.ping':
          await sock.sendMessage(msg.key.remoteJid, { text: '🏓 Pong!' });
          break;
        case '.menu':
          await sock.sendMessage(msg.key.remoteJid, {
            text: '📋 *Menu*\n.ping - Check bot\n.menu - List commands\n.delete - Unpair',
          });
          break;
        default:
          await sock.sendMessage(msg.key.remoteJid, { text: '❔ Unknown command. Use .menu' });
          break;
      }
    } catch (err) {
      console.error('WA Bot Error:', err);
    }
  });
}

async function generateQR(phoneNumber) {
  const { state, saveCreds } = await useMultiFileAuthState(`sessions/${phoneNumber}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  return new Promise((resolve) => {
    sock.ev.on('connection.update', async ({ qr, connection }) => {
      if (qr) {
        const canvas = createCanvas();
        await QRCode.toCanvas(canvas, qr);
        resolve(canvas.toBuffer());
      }
    });
  });
}

async function generatePairingCode(phoneNumber) {
  const { state, saveCreds } = await useMultiFileAuthState(`sessions/${phoneNumber}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  try {
    const code = await sock.requestPairingCode(phoneNumber);
    return code;
  } catch (err) {
    console.error('Failed to generate pairing code:', err);
    return '❌ Error generating code. Try again later.';
  }
}

bot.launch()
  .then(() => {
    console.log('Telegram bot launched');
    startWhatsAppBot();
  })
  .catch(console.error);
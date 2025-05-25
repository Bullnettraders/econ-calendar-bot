// index.js
import { Client, GatewayIntentBits } from 'discord.js';
import cron from 'node-cron';
import fetch from 'node-fetch';
import { load } from 'cheerio';
import dotenv from 'dotenv';

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
const channelId = process.env.CHANNEL_ID;
const tz = process.env.TZ || 'Europe/Berlin';

// Hilfsfunktion: holt das HTML-Fragment vom Investing API
async function fetchCalendarHTML(date, countryCode) {
  const url = 'https://www.investing.com/economic-calendar/Service/getCalendarFilteredData';
  const params = new URLSearchParams({
    dateFrom: date,
    dateTo: date,
    'country[]': countryCode,
    timeFilter: 'all',
    timezoneId: '93' // 93 = Europe/Berlin
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-requested-with': 'XMLHttpRequest',
      'Referer': 'https://www.investing.com/economic-calendar/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    },
    body: params
  });

  if (!res.ok) {
    throw new Error(`Investing API Error: ${res.status}`);
  }

  const json = await res.json();
  return json.data.content; // HTML-Fragment
}

// Parser für alle Einträge
function parseCalendar(html) {
  const $ = load(html);
  const rows = [];
  $('#economicCalendarData tbody tr').each((_, el) => {
    const time     = $(el).find('td').eq(0).text().trim();
    const currency = $(el).find('td').eq(1).text().trim();
    const event    = $(el).find('td').eq(2).text().trim();
    const actual   = $(el).find('td').eq(3).text().trim();
    const forecast = $(el).find('td').eq(4).text().trim();
    const previous = $(el).find('td').eq(5).text().trim();
    rows.push(
      `\`${time}\` • **${currency}** — ${event}\n` +
      `> Actual: ${actual} | Forecast: ${forecast} | Previous: ${previous}`
    );
  });
  return rows.length ? rows.join('\n\n') : 'Keine Einträge gefunden.';
}

// Parser, der nur Actual-Werte zurückgibt
function parseActualOnly(html) {
  const $ = load(html);
  const rows = [];
  $('#economicCalendarData tbody tr').each((_, el) => {
    const actual = $(el).find('td').eq(3).text().trim();
    if (actual) {
      const time     = $(el).find('td').eq(0).text().trim();
      const currency = $(el).find('td').eq(1).text().trim();
      const event    = $(el).find('td').eq(2).text().trim();
      rows.push(`\`${time}\` • **${currency}** — ${event}: ${actual}`);
    }
  });
  return rows.length ? rows.join('\n\n') : 'Keine aktuellen Daten.';
}

client.once('ready', () => {
  console.log('Bot ist online!');
  const channel = client.channels.cache.get(channelId);
  if (!channel?.isTextBased()) {
    console.error('Channel nicht gefunden oder kein Text-Channel!');
    process.exit(1);
  }

  // 00:00 Uhr: Tages-Übersicht
  cron.schedule('0 0 * * *', async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const deHtml = await fetchCalendarHTML(today, 'germany');
      const usHtml = await fetchCalendarHTML(today, 'united_states');
      const deText = parseCalendar(deHtml);
      const usText = parseCalendar(usHtml);
      await channel.send(
        `📊 **Wirtschaftskalender ${today}**\n\n` +
        `🇩🇪 **Deutschland**:\n${deText}\n\n` +
        `🇺🇸 **USA**:\n${usText}`
      );
    } catch (err) {
      console.error('Fehler bei 00:00-Job:', err);
    }
  }, { timezone: tz });

  // 08:00 Uhr: Nur Actual-Werte
  cron.schedule('0 8 * * *', async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const deHtml = await fetchCalendarHTML(today, 'germany');
      const usHtml = await fetchCalendarHTML(today, 'united_states');
      const deText = parseActualOnly(deHtml);
      const usText = parseActualOnly(usHtml);
      await channel.send(
        `⏱ **Aktuelle Wirtschafts-Daten ${today}**\n\n` +
        `🇩🇪 Deutschland:\n${deText}\n\n` +
        `🇺🇸 USA:\n${usText}`
      );
    } catch (err) {
      console.error('Fehler bei 08:00-Job:', err);
    }
  }, { timezone: tz });

  // Test-Command: Schreibe "!test" im Channel, um eine Sofort-Abfrage zu starten
  client.on('messageCreate', async message => {
    if (message.channelId === channelId && message.content === '!test') {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const deHtml = await fetchCalendarHTML(today, 'germany');
        const usHtml = await fetchCalendarHTML(today, 'united_states');
        const deText = parseCalendar(deHtml);
        const usText = parseCalendar(usHtml);
        await message.reply(
          `📊 **Test: Wirtschaftskalender ${today}**\n\n` +
          `🇩🇪 **Deutschland**:\n${deText}\n\n` +
          `🇺🇸 **USA**:\n${usText}`
        );
      } catch (err) {
        console.error('Fehler bei Test-Command:', err);
        await message.reply('Fehler beim Abrufen der Daten. Schau in die Logs!');
      }
    }
  });
});

client.login(process.env.DISCORD_TOKEN);

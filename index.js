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

// 1) Vollen Kalender abrufen (ohne country-Filter)
async function fetchCalendarHTML(date) {
  const url = 'https://www.investing.com/economic-calendar/Service/getCalendarFilteredData';
  const params = new URLSearchParams({
    dateFrom: date,
    dateTo: date,
    timeFilter: 'all',
    timezoneId: '93'     // Berlin
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
  return json.data.content;
}

// 2) Komplettes HTML in ein Objekt-Array parsen
function parseAll(html) {
  const $ = load(html);
  const items = [];
  $('#economicCalendarData tbody tr').each((_, el) => {
    const time     = $(el).find('td').eq(0).text().trim();
    const currency = $(el).find('td').eq(1).text().trim();
    const event    = $(el).find('td').eq(2).text().trim();
    const actual   = $(el).find('td').eq(3).text().trim();
    const forecast = $(el).find('td').eq(4).text().trim();
    const previous = $(el).find('td').eq(5).text().trim();
    items.push({ time, currency, event, actual, forecast, previous });
  });
  return items;
}

// 3) Objekt-Array zu Markdown-Text umwandeln
function formatRows(rows) {
  if (!rows.length) return 'Keine Einträge gefunden.';
  return rows
    .map(r =>
      `\`${r.time}\` • **${r.currency}** — ${r.event}\n` +
      `> Actual: ${r.actual} | Forecast: ${r.forecast} | Previous: ${r.previous}`
    )
    .join('\n\n');
}

// 4) Nur Actual-Werte formatieren
function formatActual(rows) {
  const filtered = rows.filter(r => r.actual);
  if (!filtered.length) return 'Keine aktuellen Daten.';
  return filtered
    .map(r =>
      `\`${r.time}\` • **${r.currency}** — ${r.event}: ${r.actual}`
    )
    .join('\n\n');
}

client.once('ready', () => {
  console.log('Bot ist online!');
  const channel = client.channels.cache.get(channelId);
  if (!channel?.isTextBased()) {
    console.error('Channel nicht gefunden oder kein Text-Channel!');
    process.exit(1);
  }

  // Cronjob 00:00 Uhr: komplette Übersicht
  cron.schedule('0 0 * * *', async () => {
    try {
      const today   = new Date().toISOString().slice(0, 10);
      const html    = await fetchCalendarHTML(today);
      const allRows = parseAll(html);

      // splitten nach Währung (EUR = DE, USD = US)
      const deRows = allRows.filter(r => r.currency === 'EUR');
      const usRows = allRows.filter(r => r.currency === 'USD');

      await channel.send(
        `📊 **Wirtschaftskalender ${today}**\n\n` +
        `🇩🇪 **Deutschland (EUR)**\n${formatRows(deRows)}\n\n` +
        `🇺🇸 **USA (USD)**\n${formatRows(usRows)}`
      );
    } catch (err) {
      console.error('Fehler bei 00:00-Job:', err);
    }
  }, { timezone: tz });

  // Cronjob 08:00 Uhr: nur Actual
  cron.schedule('0 8 * * *', async () => {
    try {
      const today   = new Date().toISOString().slice(0, 10);
      const html    = await fetchCalendarHTML(today);
      const allRows = parseAll(html);

      const deRows = allRows.filter(r => r.currency === 'EUR');
      const usRows = allRows.filter(r => r.currency === 'USD');

      await channel.send(
        `⏱ **Aktuelle Wirtschafts-Daten ${today}**\n\n` +
        `🇩🇪 Deutschland (EUR)\n${formatActual(deRows)}\n\n` +
        `🇺🇸 USA (USD)\n${formatActual(usRows)}`
      );
    } catch (err) {
      console.error('Fehler bei 08:00-Job:', err);
    }
  }, { timezone: tz });

  // Test-Command: "!test" im Channel
  client.on('messageCreate', async message => {
    if (message.channelId === channelId && message.content === '!test') {
      try {
        const today   = new Date().toISOString().slice(0, 10);
        const html    = await fetchCalendarHTML(today);
        const allRows = parseAll(html);
        const deRows  = allRows.filter(r => r.currency === 'EUR');
        const usRows  = allRows.filter(r => r.currency === 'USD');
        await message.reply(
          `📊 **Test: Wirtschaftskalender ${today}**\n\n` +
          `🇩🇪 Deutschland (EUR)\n${formatRows(deRows)}\n\n` +
          `🇺🇸 USA (USD)\n${formatRows(usRows)}`
        );
      } catch (err) {
        console.error('Fehler bei Test-Command:', err);
        await message.reply('Fehler beim Abrufen der Daten. Sieh in die Logs!');
      }
    }
  });
});

client.login(process.env.DISCORD_TOKEN);

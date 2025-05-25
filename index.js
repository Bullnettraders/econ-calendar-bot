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

// Cache für bereits gepostete Actual-Werte
const lastActual = {};

// 1) öffentliche Seite per GET holen
async function fetchCalendarHTML() {
  const res = await fetch('https://www.investing.com/economic-calendar/', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  if (!res.ok) throw new Error(`Fetch Error: ${res.status}`);
  return await res.text();
}

// 2) parse alle Zeilen der Tabelle
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

// 3) formatiere Tages-Übersicht
function formatRows(rows) {
  if (!rows.length) return 'Keine Einträge gefunden.';
  return rows.map(r =>
    `\`${r.time}\` • **${r.currency}** — ${r.event}\n` +
    `> Actual: ${r.actual || '-'} | Forecast: ${r.forecast} | Previous: ${r.previous}`
  ).join('\n\n');
}

// 4) vergleiche Actual mit Forecast und setze Pfeil+Text
function compareWithForecast(actualStr, forecastStr) {
  const a = parseFloat(actualStr.replace(/[,%]/g, ''));
  const f = parseFloat(forecastStr.replace(/[,%]/g, ''));
  if (isNaN(a) || isNaN(f)) return '';
  if (a > f) return '🔺 besser als erwartet';
  if (a < f) return '🔻 schlechter als erwartet';
  return '→ wie erwartet';
}

// 5) Polling ab 08–22 Uhr: neue Actual-Werte posten
client.once('ready', () => {
  console.log('Bot ist online!');
  const channel = client.channels.cache.get(channelId);
  if (!channel?.isTextBased()) {
    console.error('Channel nicht gefunden!');
    process.exit(1);
  }

  // 00:00 Uhr: komplette Tages-Übersicht
  cron.schedule('0 0 * * *', async () => {
    try {
      const html   = await fetchCalendarHTML();
      const all    = parseAll(html);
      const deRows = all.filter(r => r.currency === 'EUR');
      const usRows = all.filter(r => r.currency === 'USD');
      await channel.send(
        `📊 **Wirtschaftskalender ${new Date().toISOString().slice(0,10)}**\n\n` +
        `🇩🇪 Deutschland (EUR)\n${formatRows(deRows)}\n\n` +
        `🇺🇸 USA (USD)\n${formatRows(usRows)}`
      );
    } catch (e) {
      console.error('00:00-Job Fehler:', e);
    }
  }, { timezone: tz });

  // Polling: jede Minute von 08:00–22:00
  cron.schedule('*/1 8-22 * * *', async () => {
    try {
      const html      = await fetchCalendarHTML();
      const all       = parseAll(html);
      const candidates = all.filter(r => r.actual);
      const newEntries = [];

      for (const r of candidates) {
        const key = `${r.currency}|${r.event}|${r.time}`;
        if (lastActual[key] !== r.actual) {
          const comp = compareWithForecast(r.actual, r.forecast);
          newEntries.push(
            `\`${r.time}\` • **${r.currency}** — ${r.event}: ${r.actual} ${comp}`
          );
          lastActual[key] = r.actual;
        }
      }

      if (newEntries.length) {
        const now = new Date().toISOString().substr(11,5);
        await channel.send(
          `🕑 **Neue Wirtschafts-Daten (${now})**\n` +
          newEntries.join('\n')
        );
      }
    } catch (e) {
      console.error('Polling-Job Fehler:', e);
    }
  }, { timezone: tz });

  // Test-Command: "!test"
  client.on('messageCreate', async msg => {
    if (msg.channelId === channelId && msg.content === '!test') {
      try {
        const html   = await fetchCalendarHTML();
        const all    = parseAll(html);
        const deRows = all.filter(r => r.currency === 'EUR');
        const usRows = all.filter(r => r.currency === 'USD');
        await msg.reply(
          `📊 **Test: Wirtschaftskalender**\n\n` +
          `🇩🇪 Deutschland\n${formatRows(deRows)}\n\n` +
          `🇺🇸 USA\n${formatRows(usRows)}`
        );
      } catch (e) {
        console.error('Test-Command Fehler:', e);
        await msg.reply('Fehler beim Testen – siehe Logs.');
      }
    }
  });
});

client.login(process.env.DISCORD_TOKEN);

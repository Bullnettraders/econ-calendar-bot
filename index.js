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

// 1) Seite per GET holen
async function fetchCalendarHTML() {
  const res = await fetch('https://www.investing.com/economic-calendar/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    }
  });
  if (!res.ok) throw new Error(`Fetch Error: ${res.status}`);
  const html = await res.text();
  return html;
}

// 2) Tabelle parsen wie vorher
function parseAll(html) {
  const $ = load(html);
  const items = [];
  // Die Seite zeigt immer die heutige Tabelle, im tbody sind die Rows
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

function formatRows(rows) {
  if (!rows.length) return 'Keine Einträge gefunden.';
  return rows.map(r =>
    `\`${r.time}\` • **${r.currency}** — ${r.event}\n` +
    `> Actual: ${r.actual} | Forecast: ${r.forecast} | Previous: ${r.previous}`
  ).join('\n\n');
}

function formatActual(rows) {
  const filtered = rows.filter(r => r.actual);
  if (!filtered.length) return 'Keine aktuellen Daten.';
  return filtered.map(r =>
    `\`${r.time}\` • **${r.currency}** — ${r.event}: ${r.actual}`
  ).join('\n\n');
}

client.once('ready', () => {
  console.log('Bot ist online!');
  const channel = client.channels.cache.get(channelId);
  if (!channel?.isTextBased()) {
    console.error('Channel nicht gefunden!');
    process.exit(1);
  }

  // 00:00 Tages-Übersicht
  cron.schedule('0 0 * * *', async () => {
    try {
      const html = await fetchCalendarHTML();
      const all  = parseAll(html);
      const de   = all.filter(r => r.currency === 'EUR');
      const us   = all.filter(r => r.currency === 'USD');
      await channel.send(
        `📊 **Wirtschaftskalender ${new Date().toISOString().slice(0,10)}**\n\n` +
        `🇩🇪 Deutschland (EUR)\n${formatRows(de)}\n\n` +
        `🇺🇸 USA (USD)\n${formatRows(us)}`
      );
    } catch (e) {
      console.error('00:00-Job Fehler:', e);
    }
  }, { timezone: tz });

  // 08:00 nur Actual
  cron.schedule('0 8 * * *', async () => {
    try {
      const html = await fetchCalendarHTML();
      const all  = parseAll(html);
      const de   = all.filter(r => r.currency === 'EUR');
      const us   = all.filter(r => r.currency === 'USD');
      await channel.send(
        `⏱ **Aktuelle Wirtschafts-Daten ${new Date().toISOString().slice(0,10)}**\n\n` +
        `🇩🇪 Deutschland (EUR)\n${formatActual(de)}\n\n` +
        `🇺🇸 USA (USD)\n${formatActual(us)}`
      );
    } catch (e) {
      console.error('08:00-Job Fehler:', e);
    }
  }, { timezone: tz });

  // Test-Command
  client.on('messageCreate', async msg => {
    if (msg.channelId === channelId && msg.content === '!test') {
      try {
        const html = await fetchCalendarHTML();
        const all  = parseAll(html);
        const de   = all.filter(r => r.currency === 'EUR');
        const us   = all.filter(r => r.currency === 'USD');
        await msg.reply(
          `📊 **Test: Wirtschaftskalender**\n\n` +
          `🇩🇪 Deutschland\n${formatRows(de)}\n\n` +
          `🇺🇸 USA\n${formatRows(us)}`
        );
      } catch (e) {
        console.error('Test-Command Fehler:', e);
        await msg.reply('Fehler beim Testen – siehe Logs.');
      }
    }
  });
});

client.login(process.env.DISCORD_TOKEN);

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

// Cache für bereits gepostete Actual-Werte (als Number)
const lastActual = {};

// Hilfsfunktion: Nachrichten eines Autors im Channel löschen
async function clearBotMessages(channel) {
  let fetched;
  do {
    fetched = await channel.messages.fetch({ limit: 100 });
    const botMessages = fetched.filter(msg => msg.author.id === client.user.id);
    if (botMessages.size === 0) break;
    await channel.bulkDelete(botMessages, true).catch(err => console.error('BulkDelete Error:', err));
  } while (fetched.size >= 2);
}

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
    const cols     = $(el).find('td');
    const time     = cols.eq(0).text().trim();
    const currency = cols.eq(1).text().trim();
    const event    = cols.eq(2).text().trim();
    const actual   = cols.eq(3).text().trim();
    const forecast = cols.eq(4).text().trim();
    const previous = cols.eq(5).text().trim();
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

client.once('ready', () => {
  console.log('Bot ist online!');
  const channel = client.channels.cache.get(channelId);
  if (!channel?.isTextBased()) {
    console.error('Channel nicht gefunden!');
    process.exit(1);
  }

  // 00:00 Uhr: komplette Tages-Übersicht + Cache-Reset + Old-Posts löschen
  cron.schedule('0 0 * * *', async () => {
    try {
      await clearBotMessages(channel);
      const html = await fetchCalendarHTML();
      const all  = parseAll(html);
      for (const key in lastActual) delete lastActual[key];
      const date = new Date().toISOString().slice(0,10);
      const deRows = all.filter(r => r.currency === 'EUR');
      const usRows = all.filter(r => r.currency === 'USD');
      await channel.send(
        `📊 **Wirtschaftskalender ${date}**\n\n` +
        `🇩🇪 Deutschland (EUR)\n${formatRows(deRows)}\n\n` +
        `🇺🇸 USA (USD)\n${formatRows(usRows)}`
      );
      all.forEach(r => {
        const a = parseFloat(r.actual.replace(/[,%]/g, ''));
        if (!isNaN(a)) {
          const key = `${r.currency}|${r.event}|${r.time}`;
          lastActual[key] = a;
        }
      });
    } catch (e) {
      console.error('00:00-Job Fehler:', e);
    }
  }, { timezone: tz });

  // Polling: jede Minute von 08:00–22:00, nur neue Zahlen
  cron.schedule('*/1 8-22 * * *', async () => {
    try {
      const html = await fetchCalendarHTML();
      const all  = parseAll(html);
      const newEntries = [];
      for (const r of all) {
        const a = parseFloat(r.actual.replace(/[,%]/g, ''));
        if (isNaN(a)) continue;
        const key = `${r.currency}|${r.event}|${r.time}`;
        if (lastActual[key] !== a) {
          newEntries.push(
            `\`${r.time}\` • **${r.currency}** — ${r.event}: ${r.actual} ${compareWithForecast(r.actual, r.forecast)}`
          );
          lastActual[key] = a;
        }
      }
      if (newEntries.length > 0) {
        const now = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: tz });
        await channel.send(`🕑 **Neue Wirtschafts-Daten (${now})**\n${newEntries.join('\n')}`);
      }
    } catch (e) {
      console.error('Polling-Job Fehler:', e);
    }
  }, { timezone: tz });

  client.on('messageCreate', async msg => {
    if (msg.channelId !== channelId) return;

    // Test-Command: Tagesübersicht
    if (msg.content === '!test') {
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

    // Test-Command: einzelne neue Werte
    if (msg.content === '!testlive') {
      try {
        const html       = await fetchCalendarHTML();
        const all        = parseAll(html);
        const testEntries = [];
        for (const r of all) {
          const a = parseFloat(r.actual.replace(/[,%]/g, ''));
          if (isNaN(a)) continue;
          testEntries.push(
            `\`${r.time}\` • **${r.currency}** — ${r.event}: ${r.actual} ${compareWithForecast(r.actual, r.forecast)}`
          );
        }
        if (testEntries.length > 0) {
          await msg.reply(`🕑 **Test Live-Daten**\n${testEntries.join('\n')}`);
        } else {
          await msg.reply('Keine Live-Daten zum Testen gefunden.');
        }
      } catch (e) {
        console.error('TestLive-Command Fehler:', e);
        await msg.reply('Fehler beim Testen der Live-Daten.');
      }
    }

    // Clear-Command: alle Bot-Nachrichten löschen
    if (msg.content === '!clear') {
      try {
        await msg.reply('Lösche alle Bot-Nachrichten...');
        await clearBotMessages(channel);
        await msg.reply('Fertig: alle Bot-Nachrichten wurden gelöscht.');
      } catch (e) {
        console.error('Clear-Command Fehler:', e);
        await msg.reply('Fehler beim Löschen der Nachrichten.');
      }
    }
  });
});

client.login(process.env.DISCORD_TOKEN);

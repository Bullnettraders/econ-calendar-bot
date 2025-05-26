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

// 2) parse alle Zeilen der Tabelle, inkl. country aus Flag-Title
function parseAll(html) {
  const $ = load(html);
  const items = [];
  $('#economicCalendarData tbody tr').each((_, el) => {
    const cols     = $(el).find('td');
    const time     = cols.eq(0).text().trim();
    const currency = cols.eq(1).text().trim();
    const country  = cols.eq(1).find('span.flag').attr('title') || '';
    const event    = cols.eq(2).text().trim();
    const actual   = cols.eq(3).text().trim();
    const forecast = cols.eq(4).text().trim();
    const previous = cols.eq(5).text().trim();
    items.push({ time, currency, country, event, actual, forecast, previous });
  });
  return items;
}

// Helper: convert scraped time string to Berlin Time formatted
function toBerlinTime(timeStr) {
  // timeStr: "HH:mm" assumed in UTC
  const [h, m] = timeStr.split(':').map(Number);
  const date = new Date();
  date.setUTCHours(h, m, 0, 0);
  return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: tz });
}

// 3) formatiere Tages-Übersicht (Zeit in Berliner Zeit)
function formatRows(rows) {
  if (!rows.length) return 'Keine Einträge gefunden.';
  return rows.map(r => {
    const timeBerlin = toBerlinTime(r.time);
    return `\`${timeBerlin}\` • **${r.currency} (${r.country})** — ${r.event}\n` +
           `> Actual: ${r.actual || '-'} | Forecast: ${r.forecast} | Previous: ${r.previous}`;
  }).join('\n\n');
}

// 4) formatiere Feiertage (nur Event-Name)
function formatHolidays(rows) {
  if (!rows.length) return 'Keine Feiertage.';
  return rows.map(r => `• **${r.event}** (${r.currency})`).join('\n');
}

// 5) vergleiche Actual mit Forecast und setze Pfeil+Text
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

  // 00:00 Uhr (Berlin): komplette Tages-Übersicht + Cache-Reset + Old-Posts löschen
  cron.schedule('0 0 * * *', async () => {
    try {
      await clearBotMessages(channel);
      const html = await fetchCalendarHTML();
      const all  = parseAll(html);

      // Cache zurücksetzen
      for (const key in lastActual) delete lastActual[key];

      const date = new Date().toLocaleDateString('de-DE', { timeZone: tz });
      // Liste europäischer Länder (inkl. UK)
      const europeCountries = [
        'Austria','Belgium','Finland','France','Germany','Greece','Ireland',
        'Italy','Netherlands','Portugal','Spain','Sweden','United Kingdom'
      ];
      // Feiertage Europa und USA
      const eurHolidays = all.filter(r => r.time === 'All Day' && europeCountries.includes(r.country));
      const usdHolidays = all.filter(r => r.time === 'All Day' && r.country === 'United States');
      // Wirtschaftstermine Deutschland und USA
      const deRows = all.filter(r => r.currency === 'EUR' && r.country === 'Germany' && r.time !== 'All Day');
      const usRows = all.filter(r => r.currency === 'USD' && r.country === 'United States' && r.time !== 'All Day');

      await channel.send(
        `📅 **Feiertage ${date}**
` +
        `🇪🇺 Europa
${formatHolidays(eurHolidays)}

` +
        `🇺🇸 USA
${formatHolidays(usdHolidays)}

` +
        `📊 **Wirtschaftskalender ${date}**

` +
        `🇩🇪 Deutschland
${formatRows(deRows)}

` +
        `🇺🇸 USA
${formatRows(usRows)}`
      );

      // Cache mit aktuellen Zahlen füllen (nur Wirtschaft)
      [...deRows, ...usRows].forEach(r => {
        const a = parseFloat(r.actual.replace(/[,%]/g, ''));
        if (!isNaN(a)) {
          const key = `${r.currency}|${r.country}|${r.event}|${r.time}`;
          lastActual[key] = a;
        }
      });

    } catch (e) {
      console.error('00:00-Job Fehler:', e);
    }
  }, { timezone: tz });

  // Polling: jede Minute von 08:00–22:00 (Berlin), nur neue Zahlen von 08:00–22:00 (Berlin), nur neue Zahlen
  cron.schedule('*/1 8-22 * * *', async () => {
    try {
      const html = await fetchCalendarHTML();
      const all  = parseAll(html);
      const newEntries = [];

      // Filter nur DE und US Wirtschaft (keine Feiertage)
      const candidates = all.filter(r => {
        const a = parseFloat(r.actual.replace(/[,%]/g, ''));
        return !isNaN(a) &&
               ((r.currency === 'EUR' && r.country === 'Germany' && r.time !== 'All Day') ||
                (r.currency === 'USD' && r.country === 'United States' && r.time !== 'All Day'));
      });

      for (const r of candidates) {
        const a = parseFloat(r.actual.replace(/[,%]/g, ''));
        const key = `${r.currency}|${r.country}|${r.event}|${r.time}`;
        if (lastActual[key] !== a) {
          const timeBerlin = toBerlinTime(r.time);
          newEntries.push(
            `\`${timeBerlin}\` • **${r.currency} (${r.country})** — ${r.event}: ${r.actual} ${compareWithForecast(r.actual, r.forecast)}`
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

    // Test-Command: Übersicht inkl. Feiertage
    if (msg.content === '!test') {
      try {
        const html   = await fetchCalendarHTML();
        const all    = parseAll(html);
        const eurH   = all.filter(r => r.currency === 'EUR' && r.time === 'All Day');
        const usdH   = all.filter(r => r.currency === 'USD' && r.time === 'All Day');
        const deR    = all.filter(r => r.currency === 'EUR' && r.country === 'Germany' && r.time !== 'All Day');
        const usR    = all.filter(r => r.currency === 'USD' && r.country === 'United States' && r.time !== 'All Day');
        await msg.reply(
          `📅 **Test: Feiertage & Wirtschaft ${new Date().toLocaleDateString('de-DE',{timeZone:tz})}**\n` +
          `🇪🇺 Europa Feiertage\n${formatHolidays(eurH)}\n\n` +
          `🇺🇸 USA Feiertage\n${formatHolidays(usdH)}\n\n` +
          `📊 Wirtschaft Deutschland\n${formatRows(deR)}\n\n` +
          `📊 Wirtschaft USA\n${formatRows(usR)}`
        );
      } catch (e) {
        console.error('Test-Command Fehler:', e);
        await msg.reply('Fehler beim Testen – siehe Logs.');
      }
    }

    // Test-Command: einzelne neue Wirtschaftswerte
    if (msg.content === '!testlive') {
      try {
        const html = await fetchCalendarHTML();
        const all  = parseAll(html);
        const entries = [];
        const cand = all.filter(r => {
          const a = parseFloat(r.actual.replace(/[,%]/g, ''));
          return !isNaN(a) &&
                 ((r.currency==='EUR'&&r.country==='Germany'&&r.time!=='All Day')||
                  (r.currency==='USD'&&r.country==='United States'&&r.time!=='All Day'));
        });
        cand.forEach(r => {
          const timeBerlin = toBerlinTime(r.time);
          entries.push(
            `\`${timeBerlin}\` • **${r.currency} (${r.country})** — ${r.event}: ${r.actual} ${compareWithForecast(r.actual,r.forecast)}`
          );
        });
        if(entries.length) await msg.reply(`🕑 **Test Live-Daten**\n${entries.join('\n')}`);
        else           await msg.reply('Keine Live-Daten zum Testen gefunden.');
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

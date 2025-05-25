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
    GatewayIntentBits.GuildMessages
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

// Parst das HTML-Fragment und gibt eine Text-Liste der Einträge zurück
function parseCalendar(html) {
  const $ = load(html);
  const rows = [];
  $('#economicCalendarData tbody tr').each((_, el) => {
    const time = $(el).find('td').eq(0).text().trim();
    const currency = $(el).find('td').eq(1).text().trim();
    const event = $(el).find('td').eq(2).text().trim();
    const actual = $(el).find('td').eq(3).text().trim();
    const forecast = $(el).find('td').eq(4).text().trim();
    const previous = $(el).find('td').eq(5).text().trim();
    rows.push(
      `\`${time}\` • **${currency}** — ${event}\n` +
      `> Actual: ${actual} | Forecast: ${forecast} | Previous: ${previous}`
    );
  });
  return rows.length ? rows.join('\n\n') : 'Keine Einträge gefunden.';
}

client.once('ready', () => {
  const channel = client.channels.cache.get(channelId);
  if (!channel?.isTextBased()) {
    console.error('Channel nicht gefunden oder kein Text-Channel!');
    process.exit(1);
  }

  // Cronjob: 00:00 Uhr Tages-Übersicht
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

  // Cronjob: 08:00 Uhr nur Actual-Werte
  cron.schedule('0 8 * * *', async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const deHtml = await fetchCalendarHTML(today, 'germany');
      const usHtml = await fetchCalendarHTML(today, 'united_states');

      // Nur Zeilen mit “Actual” filtern
      const filterActual = html => {
        const $ = load(html);
        const rows = [];
        $('#economicCalendarData tbody tr').each((_, el) => {
          const actual = $(el).find('td').eq(3).text().trim();
          if (actual) {
            const time = $(el).find('td').eq(0).text().trim();
            const currency = $(el).find('td').eq(1).text().trim();
            const event = $(el).find('td').eq(2).text().trim();
            rows.push(`\`${time}\` • **${currency}** — ${event}: ${actual}`);
          }
        });
        return rows.length ? rows.join('\n\n') : 'Keine aktuellen Daten.';
      };

      const deActual = filterActual(deHtml);
      const usActual = filterActual(usHtml);

      await channel.send(
        `⏱ **Aktuelle Wirtschafts-Daten ${today}**\n\n` +
        `🇩🇪 Deutschland:\n${deActual}\n\n` +
        `🇺🇸 USA:\n${usActual}`
      );
    } catch (err) {
      console.error('Fehler bei 08:00-Job:', err);
    }
  }, { timezone: tz });

  console.log('Bot ist online!');
});

client.login(process.env.DISCORD_TOKEN);

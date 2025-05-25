import { Client, GatewayIntentBits } from 'discord.js';
import cron from 'node-cron';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
const channelId = process.env.CHANNEL_ID;
const tz = process.env.TZ || 'Europe/Berlin';

async function fetchCalendar(date, country) {
  const url = `${process.env.INVESTING_CSV_URL}?country=${country}&date=${date}`;
  const res = await fetch(url);
  const text = await res.text();
  return text;
}

client.once('ready', () => {
  const channel = client.channels.cache.get(channelId);
  if (!channel || !channel.isTextBased()) return console.error('Channel nicht gefunden oder kein Text-Channel!');

  // 00:00 Uhr: Tages-Übersicht
  cron.schedule('0 0 * * *', async () => {
    const today = new Date().toISOString().slice(0,10);
    const de = await fetchCalendar(today, 'germany');
    const us = await fetchCalendar(today, 'united_states');
    channel.send(`📊 **Wirtschaftskalender ${today}**\n\n🇩🇪 Deutschland:\n${de}\n\n🇺🇸 USA:\n${us}`);
  }, { timezone: tz });

  // 08:00 Uhr: Aktuelle reale Daten
  cron.schedule('0 8 * * *', async () => {
    const today = new Date().toISOString().slice(0,10);
    const deNow = (await fetchCalendar(today, 'germany'))
                    .split('\n')
                    .filter(line => line.includes('Actual'))
                    .join('\n');
    const usNow = (await fetchCalendar(today, 'united_states'))
                    .split('\n')
                    .filter(line => line.includes('Actual'))
                    .join('\n');
    channel.send(`⏱ **Aktuelle Wirtschafts-Daten ${today}**\n\n🇩🇪 Deutschland:\n${deNow}\n\n🇺🇸 USA:\n${usNow}`);
  }, { timezone: tz });

  console.log('Bot ist online!');
});

client.login(process.env.DISCORD_TOKEN);

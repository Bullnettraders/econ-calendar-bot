// ... (oben unverändert)

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
      const html = await fetchCalendarHTML();
      const all  = parseAll(html);

      // 1. Cache zurücksetzen, damit wir nur die tagesaktuellen Werte speichern
      for (const key in lastActual) {
        delete lastActual[key];
      }

      const deRows = all.filter(r => r.currency === 'EUR');
      const usRows = all.filter(r => r.currency === 'USD');

      // 2. Übersicht senden
      await channel.send(
        `📊 **Wirtschaftskalender ${new Date().toISOString().slice(0,10)}**\n\n` +
        `🇩🇪 Deutschland (EUR)\n${formatRows(deRows)}\n\n` +
        `🇺🇸 USA (USD)\n${formatRows(usRows)}`
      );

      // 3. Cache mit den aktuellen Werten füllen,
      //    damit der Polling-Job ab 08:00 keine "alten" Werte als neu sieht
      all
        .filter(r => r.actual)
        .forEach(r => {
          const key = `${r.currency}|${r.event}|${r.time}`;
          lastActual[key] = r.actual;
        });

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

  // ... (Rest bleibt unverändert)
});

// =====================================================================
//  Bot de eventos + Sign Up para Discord
//  - POST /publish  -> publica el embed con menú de roles y botón de baja
//  - Interacciones  -> mueven/añaden/quitan al usuario y editan el mensaje en vivo
//  El estado vive en el propio embed (sin base de datos): sobrevive a reinicios.
// =====================================================================
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const {
  Client, GatewayIntentBits, Events, MessageFlags, EmbedBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');

const { DISCORD_TOKEN, CHANNEL_ID, API_KEY, ALLOWED_ORIGIN, PORT = 3000 } = process.env;
if (!DISCORD_TOKEN || !CHANNEL_ID || !API_KEY) {
  console.error('Faltan variables de entorno: DISCORD_TOKEN, CHANNEL_ID y API_KEY son obligatorias.');
  process.exit(1);
}

// Orden = orden de los campos del embed. "max" mantiene cada campo bajo el límite de 1024 caracteres.
const ROLES = [
  { key: 'cmd',   label: 'Comandante',              emoji: '⭐',  max: 1 },
  { key: 'sl',    label: 'Oficial (SL)',            emoji: '🎖️', max: 20 },
  { key: 'inf',   label: 'Infantería',              emoji: '🔫', max: 40 },
  { key: 'tank',  label: 'Tanque / Blindados',      emoji: '🚜', max: 12 },
  { key: 'recon', label: 'Recon / Reconocimiento',  emoji: '🎯', max: 8 },
  { key: 'res',   label: 'Reserva',                 emoji: '🪑', max: 40 },
];

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------------------------------------------------------------- Embed
function buildFields(lists) {
  return ROLES.map((r, i) => ({
    name: `${r.emoji} ${r.label} (${lists[i].length}/${r.max})`,
    value: lists[i].length ? lists[i].map(id => `<@${id}>`).join('\n') : '—',
    inline: true,
  }));
}
function parseLists(embed) {
  return ROLES.map((_, i) =>
    [...String(embed?.fields?.[i]?.value || '').matchAll(/<@!?(\d+)>/g)].map(m => m[1]));
}
function footerFor(lists) {
  return { text: `Inscritos: ${lists.reduce((n, l) => n + l.length, 0)} · Elige tu rol en el menú o dátate de baja` };
}
function components() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('evt_role')
    .setPlaceholder('Elige tu rol para el evento…')
    .addOptions(ROLES.map(r => ({ label: r.label, value: r.key, emoji: r.emoji, description: `Cupo: ${r.max}` })));
  const leave = new ButtonBuilder().setCustomId('evt_leave').setLabel('Darse de baja').setEmoji('👋').setStyle(ButtonStyle.Danger);
  return [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(leave)];
}

// Evita que dos clics simultáneos sobre el mismo mensaje se pisen
const locks = new Map();
function withLock(id, fn) {
  const next = (locks.get(id) || Promise.resolve()).catch(() => {}).then(fn);
  locks.set(id, next);
  next.finally(() => { if (locks.get(id) === next) locks.delete(id); }).catch(() => {});
  return next;
}

// ---------------------------------------------------------------- Interacciones
client.on(Events.InteractionCreate, async (i) => {
  const isSelect = i.isStringSelectMenu() && i.customId === 'evt_role';
  const isLeave = i.isButton() && i.customId === 'evt_leave';
  if (!isSelect && !isLeave) return;
  try {
    await i.deferUpdate();
    const userId = i.user.id;
    const target = isSelect ? ROLES.findIndex(r => r.key === i.values[0]) : -1;

    const reply = await withLock(i.message.id, async () => {
      const channel = await client.channels.fetch(i.channelId);
      const msg = await channel.messages.fetch({ message: i.message.id, force: true }); // estado más reciente
      const base = msg.embeds[0];
      if (!base) return 'No pude leer el evento.';
      const lists = parseLists(base);
      const current = lists.findIndex(l => l.includes(userId));

      if (isSelect) {
        if (target < 0) return 'Rol no válido.';
        if (current === target) return `Ya estás inscrito como ${ROLES[target].label}.`;
        if (lists[target].length >= ROLES[target].max)
          return `El cupo de ${ROLES[target].label} está lleno. Prueba otro rol o Reserva.`;
      } else if (current === -1) {
        return 'No estabas inscrito en este evento.';
      }

      lists.forEach(l => { const k = l.indexOf(userId); if (k > -1) l.splice(k, 1); });
      if (isSelect) lists[target].push(userId);

      const embed = EmbedBuilder.from(base).setFields(buildFields(lists)).setFooter(footerFor(lists));
      await msg.edit({ embeds: [embed], components: components() });
      return isSelect
        ? `✅ Inscrito como ${ROLES[target].emoji} ${ROLES[target].label}.`
        : '👋 Te diste de baja del evento.';
    });
    await i.followUp({ content: reply, flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error('Error en interacción:', err);
    try { await i.followUp({ content: '⚠️ Ocurrió un error, inténtalo de nuevo.', flags: MessageFlags.Ephemeral }); } catch (_) {}
  }
});

// ---------------------------------------------------------------- API HTTP
const app = express();
app.set('trust proxy', 1); // Render / Railway van detrás de un proxy
app.use(cors({
  origin: ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(',').map(s => s.trim()) : false,
  methods: ['POST', 'OPTIONS'],
}));
app.use(express.json({ limit: '10kb' }));

app.get('/', (_req, res) => res.send('ok')); // health check

const limiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
function validKey(provided) {
  const a = Buffer.from(String(provided || '')), b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

app.post('/publish', limiter, async (req, res) => {
  if (!validKey(req.get('x-api-key'))) return res.status(401).json({ ok: false, error: 'API key inválida' });
  if (!client.isReady()) return res.status(503).json({ ok: false, error: 'El bot aún no está conectado' });

  const { title, map, startsAt, dateText, roleIds } = req.body || {};
  const t = clean(title, 200), m = clean(map, 100);
  if (!t) return res.status(400).json({ ok: false, error: 'Falta el título' });
  if (!m) return res.status(400).json({ ok: false, error: 'Falta el mapa' });
  const ids = [...new Set((Array.isArray(roleIds) ? roleIds : []).map(String).filter(x => /^\d{17,20}$/.test(x)))].slice(0, 10);

  const unix = Math.floor(Date.parse(startsAt) / 1000);
  const when = Number.isFinite(unix) ? `<t:${unix}:F> · <t:${unix}:R>` : clean(dateText, 100) || 'Por confirmar';

  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    const lists = ROLES.map(() => []);
    const embed = new EmbedBuilder()
      .setTitle(t)
      .setDescription(`🗺️ **Mapa:** ${m}\n🕒 **Fecha:** ${when}`)
      .setColor(0xf59e0b)
      .setFields(buildFields(lists))
      .setFooter(footerFor(lists));
    const msg = await channel.send({
      content: ids.length ? ids.map(id => `<@&${id}>`).join(' ') : undefined, // el ping va FUERA del embed
      embeds: [embed],
      components: components(),
      allowedMentions: { roles: ids },
    });
    res.json({ ok: true, messageId: msg.id, url: msg.url });
  } catch (err) {
    console.error('Error publicando:', err);
    res.status(500).json({ ok: false, error: 'No se pudo publicar (revisa permisos del bot y CHANNEL_ID)' });
  }
});

client.once(Events.ClientReady, c => console.log(`Bot conectado como ${c.user.tag}`));
client.login(DISCORD_TOKEN);
app.listen(PORT, () => console.log(`API escuchando en :${PORT}`));

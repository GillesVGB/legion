import { AttachmentBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits as P, GatewayIntentBits } from 'discord.js';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { assertUser } from './errors.mjs';
import { applicationText } from './application.mjs';
import { embed, safeText, row } from './ui.mjs';
import { renderTranscript } from './transcript-html.mjs';
import { encryptTranscript, publishTranscriptView, transcriptViewURL } from './viewer.mjs';

const allowedMentions = { parse: [], repliedUser: false };
const FILE_BYTES = 750000;
const busy = new Set();
const statusLabel = status => ({ closed: 'Gesloten', accepted: 'Aangenomen', rejected: 'Afgewezen' })[status] ?? status;

export function messageRecord(message) {
  return { id: message.id, created: message.createdTimestamp, edited: message.editedTimestamp,
    author: message.member?.displayName ?? message.author?.tag ?? message.author?.username ?? 'Onbekend', authorId: message.author?.id ?? '', bot: message.author?.bot ?? false,
    content: message.content ?? '', embeds: message.embeds.map(card => card.toJSON()),
    attachments: [...message.attachments.values()].map(file => ({ name: file.name, url: file.url })) };
}

export function transcriptDocuments(guild, channel, dossier, messages) {
  const metadata = [
    `${dossier.kind === 'application' ? 'Legion — Sollicitatie' : 'Legion — Vraag / ticket'} | ${statusLabel(dossier.status)}`,
    `Guild: ${guild.name} (${guild.id})`, `Kanaal: ${channel.name} (${channel.id})`,
    `Dossier: ${dossier.id} | Aanvrager: ${dossier.owner_id}`,
    `Afgehandeld door: ${dossier.closed_by} | Afgehandeld op: ${new Date(dossier.closed_at).toISOString()}`,
    'Bijlagen worden als oorspronkelijke Discord-links vermeld. Die links kunnen verlopen.'
  ].join('\n');
  const application = dossier.kind === 'application' && Object.hasOwn(dossier.payload, 'age') ? applicationText(dossier.payload) : '';
  const blocks = messages.map(message => {
    const cards = message.embeds.map(card => [card.title, card.description, ...(card.fields ?? []).map(field => `${field.name}: ${field.value}`)].filter(Boolean).join('\n')).join('\n');
    const attachments = message.attachments.map(file => `${file.name}: ${file.url}`).join('\n');
    return `${new Date(message.created).toISOString()} | ${message.author} (${message.authorId}) | bericht ${message.id}${message.edited ? ` | gewijzigd ${new Date(message.edited).toISOString()}` : ''}\n${[message.content, cards, attachments].filter(Boolean).join('\n') || '[Bericht zonder tekst]'}\n`;
  });
  const text = [metadata, application, 'GESPREK', ...blocks].filter(Boolean).join('\n\n');
  return { text, html: renderTranscript(guild, channel, dossier, messages, application) };
}

export function splitUTF8(value, maxBytes = FILE_BYTES) {
  const parts = []; let current = ''; let size = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character);
    if (size + bytes > maxBytes && current) { parts.push(current); current = ''; size = 0; }
    current += character; size += bytes;
  }
  if (current || !parts.length) parts.push(current);
  return parts;
}

export async function fetchTranscriptMessages(channel, closedAt) {
  const all = []; let before;
  for (;;) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}), cache: false });
    if (!batch.size) break;
    for (const message of batch.values()) if (message.createdTimestamp <= closedAt) all.push(messageRecord(message));
    const oldest = [...batch.keys()].reduce((min, id) => BigInt(id) < BigInt(min) ? id : min);
    assertUser(oldest !== before, 'De berichtgeschiedenis kon niet volledig worden opgehaald.');
    before = oldest;
    if (batch.size < 100) break;
  }
  return all.sort((a, b) => a.created - b.created || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

export async function archiveTranscript(ctx, client, caseId, validateDestination) {
  const key = `${ctx.config.guildId}:${caseId}`;
  if (busy.has(key)) return false;
  busy.add(key);
  try { return await deliverTranscript(ctx, client, caseId, validateDestination); }
  finally { busy.delete(key); }
}

export async function saveLocalTranscript(ctx, client, dossier, source) {
  assertUser(/^[a-f0-9]{12}$/.test(dossier.id), 'Ongeldig dossier-ID.');
  const documents = transcriptDocuments(source.guild, source, dossier, await fetchTranscriptMessages(source, dossier.closed_at));
  const directory = join(ctx.config.dataDir, 'transcripts', ctx.config.guildId);
  mkdirSync(directory, { recursive: true });
  for (const [extension, contents] of [['html', documents.html], ['txt', documents.text]]) {
    const target = join(directory, `${dossier.id}.${extension}`);
    writeFileSync(`${target}.tmp`, contents, 'utf8');
    renameSync(`${target}.tmp`, target);
  }
}

async function deliverTranscript(ctx, client, caseId, validateDestination) {
  const { store, config } = ctx;
  let delivery = store.transcript(caseId);
  if (!delivery || delivery.state === 'done') return true;
  if (delivery.state === 'unavailable') return false;
  const dossier = store.caseById(caseId);
  let sourceGone = false;
  try {
    assertUser(client.options.intents.has(GatewayIntentBits.MessageContent), 'Message Content Intent ontbreekt; transcript blijft in de wachtrij.');
    const destination = await client.channels.fetch(delivery.channel_id);
    assertUser(destination?.guildId === config.guildId && destination.isTextBased(), 'Het transcriptkanaal moet een tekstkanaal in dezelfde guild zijn.');
    await validateDestination(destination.guild, { ...config, logChannelId: destination.id });
    assertUser(destination.permissionsFor(destination.guild.members.me)?.has(P.AttachFiles), 'De bot mist Bestanden bijvoegen in het transcriptkanaal.');
    if (!delivery.chunks) {
      const sourceGuild = client.guilds.cache.get(config.guildId);
      const source = await sourceGuild.channels.fetch(dossier.channel_id).catch(error => { if (error.code === 10003) { sourceGone = true; return null; } throw error; });
      if (!source) sourceGone = true;
      assertUser(source?.isTextBased(), 'Het originele dossierkanaal ontbreekt.');
      const messages = await fetchTranscriptMessages(source, dossier.closed_at);
      const documents = transcriptDocuments(sourceGuild, source, dossier, messages);
      if (config.transcriptSiteURL || config.transcriptViewerMode === 'local') store.saveTranscriptView(caseId, encryptTranscript(documents.html));
      const files = [{ name: `transcript-${caseId}.txt`, content: documents.text }];
      // Een HTML-bestand blijft zelfstandig leesbaar. Grote gesprekken krijgen volledige TXT-delen.
      if (Buffer.byteLength(documents.html) <= FILE_BYTES) files.push({ name: `transcript-${caseId}.html`, content: documents.html });
      const chunks = files.flatMap(file => splitUTF8(file.content).map((content, i, parts) => ({
        name: parts.length === 1 ? file.name : file.name.replace(/\.[^.]+$/, `-deel-${i + 1}.txt`), content
      })));
      store.prepareTranscript(caseId, chunks);
      delivery = store.transcript(caseId);
    }
    assertUser(config.transcriptViewerMode !== 'local' || config.transcriptSiteURL, 'De transcriptviewer start nog op; het transcript is lokaal bewaard en wordt automatisch opnieuw geprobeerd.');
    let viewURL;
    if (config.transcriptSiteURL) {
      let view = store.transcriptView(caseId);
      if (!view) {
        const sourceGuild = client.guilds.cache.get(config.guildId);
        const source = await sourceGuild.channels.fetch(dossier.channel_id).catch(error => { if (error.code === 10003) return null; throw error; });
        let html;
        if (source?.isTextBased()) html = transcriptDocuments(sourceGuild, source, dossier, await fetchTranscriptMessages(source, dossier.closed_at)).html;
        else html = delivery.chunks.find(file => file.name.endsWith('.html'))?.content;
        assertUser(html, 'Geen HTML-transcript beschikbaar voor de transcriptpagina.');
        view = store.saveTranscriptView(caseId, encryptTranscript(html));
      }
      viewURL = view.uploaded ? transcriptViewURL(config, view) : await publishTranscriptView(config, view);
      if (!view.uploaded) store.markTranscriptUploaded(caseId);
    }
    const components = viewURL ? [row(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Transcript bekijken').setURL(viewURL))] : [];
    // Bestaande transcriptberichten krijgen dezelfde knop, zonder een tweede export.
    for (const messageId of viewURL ? delivery.message_ids : []) {
      const old = await destination.messages.fetch(messageId).catch(error => { if (error.code === 10008) return null; throw error; });
      if (old?.author.id === client.user.id && viewURL) await old.edit({ components });
    }
    for (let part = delivery.message_ids.length; part < delivery.chunks.length; part++) {
      const file = delivery.chunks[part];
      const marker = `Legion dossier ${caseId} | bestand ${part + 1}/${delivery.chunks.length}`;
      const recent = await destination.messages.fetch({ limit: 100 });
      const previous = recent.find(message => message.author.id === client.user.id && message.embeds.some(card => card.footer?.text === marker));
      let message = previous;
      if (!message) {
        const card = embed(config, dossier.kind === 'application' ? 'Legion — Sollicitatietranscript' : 'Legion — Vragentranscript',
          `Status: **${statusLabel(dossier.status)}**\nAanvrager: <@${dossier.owner_id}>\nGuild: **${safeText(destination.guild.name)}**\nDossier: \`${caseId}\`\nKanaal: <#${dossier.channel_id}>\nAfgehandeld door: <@${dossier.closed_by}>`).setFooter({ text: marker });
        message = await destination.send({ embeds: [card], components, files: [new AttachmentBuilder(Buffer.from(file.content, 'utf8'), { name: file.name })],
          allowedMentions, nonce: createHash('sha256').update(`${config.guildId}:${caseId}:${part}`).digest('hex').slice(0, 24), enforceNonce: true });
      }
      else if (viewURL) await message.edit({ components });
      store.transcriptPart(caseId, message.id);
    }
    store.finishTranscript(caseId, viewURL ? new URL(viewURL).origin : undefined);
    return true;
  } catch (error) {
    if (sourceGone && !delivery.chunks) {
      store.markTranscriptUnavailable(caseId);
      console.error(`Guild ${config.guildId}: dossier ${caseId} was vóór de export verwijderd; berichtgeschiedenis is niet meer beschikbaar.`);
      return false;
    }
    store.retryTranscript(caseId, error.code ?? error.name);
    if (error instanceof TypeError) console.error(`Transcriptverwerking: ${error.message}`);
    console.error(`Guild ${config.guildId}: transcript ${caseId} wacht op herhaling (${error.code ?? error.name}).`);
    return false;
  }
}

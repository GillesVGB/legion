import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, escapeMarkdown } from 'discord.js';
import { handValue, showCards } from './cards.mjs';
import { applicationSteps, applicationIntro, applicationThanks, applicationGuidance, applicationTemplate } from './application.mjs';
import { recruitmentState, applicationWaitingNotice } from './recruitment.mjs';

export const safeText = value => escapeMarkdown(String(value)).replaceAll('@', '@\u200b');
export const row = (...buttons) => new ActionRowBuilder().addComponents(...buttons);
export const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
export function embed(config, title, description) {
  return new EmbedBuilder().setColor(config.color).setTitle(title).setDescription(description)
    .setFooter({ text: `${config.content.gangName} • ${config.content.serverName}` }).setTimestamp();
}
export function panel(config, type = 'alles', recruitment) {
  const content = config.content;
  if (type === 'info') return { embeds: [embed(config, `${content.gangName} | Informatie`, `${content.tagline}\n\n${content.information}`)], components: [] };
  const combined = type === 'alles';
  const title = combined ? `${content.gangName} | Welkom bij de familie` : type === 'tickets' ? `${content.gangName} | Tickets` : `${content.gangName} | Solliciteren`;
  const applicationInfo = `${content.applicationIntro}\n\n${applicationGuidance(config.recruitment?.minimumAge ?? 16)}`;
  const description = combined ? `**${content.tagline}**\n\n${config.ticketsEnabled ? `📩 **Ticket openen**\n${content.ticketIntro}\n\n` : ''}🛡️ **Solliciteren**\n${applicationInfo}\n\nGebruik de knoppen hieronder. De antwoorden en gesprekken zijn privé.` : type === 'tickets' ? content.ticketIntro : applicationInfo;
  const state = config.recruitment ? recruitment ?? recruitmentState(null, config.recruitment) : null;
  const buttons = [];
  if (config.ticketsEnabled && (combined || type === 'tickets')) buttons.push(button('ticket:new', '📩 Ticket openen', ButtonStyle.Primary));
  if (combined || type === 'sollicitaties') buttons.push(button('application:new', '🛡️ Solliciteren', ButtonStyle.Success).setDisabled(state?.closed ?? false));
  if (combined) buttons.push(button('info:show', '📜 Informatie'));
  const card = embed(config, title, description);
  card.setColor(state?.color ?? 0x22C55E);
  if (state && (combined || type === 'sollicitaties')) card.addFields({ name: `Sollicitatiestatus: ${state.icon} ${state.label}`,
    value: `${state.count === null ? 'Ledenstand wordt opgehaald.' : `**${state.count}/${config.recruitment.capacity}** plaatsen bezet. Nog **${Math.max(0, config.recruitment.capacity - state.count)}** beschikbaar.`}${applicationWaitingNotice(state) ? `\n\n⏳ ${applicationWaitingNotice(state)}` : ''}\n\n🟢 Open\n🟠 Open, beperkte plaatsen\n🔴 Vol — solliciteren blijft mogelijk` });
  return { embeds: [card], components: [row(...buttons)] };
}
const input = (id, label, style, maxLength, placeholder) => new TextInputBuilder()
  .setCustomId(id).setLabel(label).setStyle(style).setRequired(true).setMaxLength(maxLength).setPlaceholder(placeholder);
export function ticketModal() {
  return new ModalBuilder().setCustomId('ticket:submit').setTitle('Legion | Ticket openen').addComponents(
    new ActionRowBuilder().addComponents(input('subject', 'Onderwerp', TextInputStyle.Short, 100, 'Waar wil je het over hebben?')),
    new ActionRowBuilder().addComponents(input('details', 'Toelichting', TextInputStyle.Paragraph, 1000, 'Beschrijf je vraag of probleem.')));
}
export function applicationModal(draft = { id: 'preview', step: 0, revision: 0, answers: {} }) {
  const modal = new ModalBuilder().setCustomId(`application:submit:${draft.id}:${draft.step}:${draft.revision}`)
    .setTitle(`Legion | Solliciteren ${draft.step + 1}/3`);
  for (const field of applicationSteps[draft.step]) {
    const component = input(field.id, field.label, field.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short, field.max, field.placeholder);
    if (draft.answers[field.id]) component.setValue(draft.answers[field.id]);
    modal.addComponents(new ActionRowBuilder().addComponents(component));
  }
  return modal;
}
export function applicationProgress(config, draft) {
  return { embeds: [embed(config, 'Legion — Sollicitatie', `Deel **${draft.step}/3** is opgeslagen. Klik hieronder om de volgende vragen in te vullen.\n\nJe kunt binnen 24 uur verdergaan met /solliciteren.`)], components: [row(
    button(`application:continue:${draft.id}:${draft.step}:${draft.revision}`, `Verder met deel ${draft.step + 1}/3`, ButtonStyle.Primary)
  )] };
}
export const applicationControls = dossier => row(
  button(`application:interview:${dossier.id}`, 'Gesprek starten', ButtonStyle.Primary),
  button(`application:askaccept:${dossier.id}`, 'Aannemen', ButtonStyle.Success),
  button(`application:askreject:${dossier.id}`, 'Afwijzen', ButtonStyle.Danger),
  button(`application:askclose:${dossier.id}`, 'Sollicitatie sluiten'),
  button(`application:status:${dossier.id}`, 'Sollicitatiestatus')
);

export function caseMessages(config, dossier, recruitment) {
  config = { ...config, color: dossier.status === 'accepted' ? 0x22C55E : ['rejected','closed'].includes(dossier.status) ? 0xEF4444 : recruitment?.color ?? (config.recruitment ? 0xF59E0B : 0x22C55E) };
  if (dossier.kind === 'application' && dossier.payload.template) return [{
    content: `<@${dossier.owner_id}> Vul de template hieronder in en plaats je antwoorden in dit kanaal.`,
    embeds: [withApplicationWaitingNotice(embed(config, 'Legion — Sollicitatie', applicationTemplate), recruitment)],
    components: [applicationControls(dossier)]
  }];
  if (dossier.kind !== 'application' || !Object.hasOwn(dossier.payload, 'age')) {
    const message = caseMessage(config, dossier);
    if (dossier.kind === 'application') withApplicationWaitingNotice(message.embeds[0], recruitment);
    return [message];
  }
  return applicationSteps.map((fields, step) => {
    const card = embed(config, 'Legion — Sollicitatie', step === 0 ? `${applicationIntro}\n\nLid: <@${dossier.owner_id}> • Dossier: \`${dossier.id}\`` : step === 2 ? applicationThanks : 'Legion — Sollicitatie (vervolg)');
    for (const field of fields) {
      const value = safeText(dossier.payload[field.id]);
      for (let offset = 0, part = 0; offset < value.length; part++) {
        let end = Math.min(offset + 1000, value.length);
        if (end < value.length && (value.charCodeAt(end - 1) >= 0xD800 && value.charCodeAt(end - 1) <= 0xDBFF)) end--;
        card.addFields({ name: field.label + (part ? ' (vervolg)' : ''), value: value.slice(offset, end) });
        offset = end;
      }
    }
    if (step === 0) withApplicationWaitingNotice(card, recruitment);
    return { embeds: [card], components: step === 2 ? [applicationControls(dossier)] : [] };
  });
}
export function withApplicationWaitingNotice(card, recruitment) {
  const fields = (card.data.fields ?? []).filter(field => field.name !== 'Langere wachttijd');
  card.setFields(fields);
  const notice = applicationWaitingNotice(recruitment);
  if (notice) card.addFields({ name: 'Langere wachttijd', value: `⏳ ${notice}` });
  return card;
}
export function caseMessage(config, dossier) {
  const applicant = dossier.kind === 'application';
  const info = applicant ? [
    ['RP-naam', dossier.payload.name], ['Ervaring', dossier.payload.experience],
    ['Motivatie', dossier.payload.motivation], ['Beschikbaarheid', dossier.payload.availability], ['Regels', dossier.payload.rules]
  ] : dossier.payload.subject ? [['Onderwerp', dossier.payload.subject], ['Toelichting', dossier.payload.details ?? 'Bespreek je vraag hieronder.']] : [];
  const card = embed(config, applicant ? '🛡️ Legion | Sollicitatie' : '📩 Legion | Ticket',
    `Lid: <@${dossier.owner_id}>\nDossier: \`${dossier.id}\`\n\n${applicant ? 'Bespreek dit dossier in dit privé kanaal.' : 'Welkom! Typ je vraag of probleem hieronder. De Legion-leiding helpt je zo snel mogelijk.'}`);
  for (const [name, value] of info) card.addFields({ name, value: safeText(value).slice(0, 1024) });
  return {
    embeds: [card], components: [applicant ? applicationControls(dossier) : row(button(`ticket:askclose:${dossier.id}`, 'Ticket sluiten', ButtonStyle.Danger))]
  };
}
export function blackjackMessage(config, store, game) {
  const done = game.status === 'done';
  const outcome = !done ? 'Spel bezig' : game.result.credit > game.bet ? 'Gewonnen' : game.result.credit < game.bet ? 'Verloren' : 'Gelijkspel';
  const color = !done ? 0x5865F2 : outcome === 'Gewonnen' ? 0x22C55E : outcome === 'Verloren' ? 0xEF4444 : 0xF59E0B;
  const description = [
    `**Jouw kaarten:** ${showCards(game.player)} — **${handValue(game.player)}**`,
    done ? `**Dealer:** ${showCards(game.dealer)} — **${handValue(game.dealer)}**` : `**Dealer:** ${showCards(game.dealer.slice(0, 1))}  🂠`,
    `\nInzet: **${game.bet} ${config.content.coinName}**`,
    done ? `\n${game.result.text}\nTeruggave: **${game.result.credit}** coins (inclusief inzet).\nSaldo: **${store.wallet(game.userId).balance}** coins.` : `Bij geen actie wordt automatisch gepast <t:${Math.floor(game.expires / 1000)}:R>.\n3:2 bij blackjack • dealer past op 17 • geen splits/double down.`
  ].join('\n');
  return { embeds: [embed(config, `🃏 Blackjack | ${config.content.gangName} — ${outcome}`, description).setColor(color)], components: done ? [] : [row(
    button(`bj:hit:${game.id}:${game.revision}`, 'Kaart pakken', ButtonStyle.Primary),
    button(`bj:stand:${game.id}:${game.revision}`, 'Passen', ButtonStyle.Success)
  )] };
}

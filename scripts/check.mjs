import { loadConfig } from '../src/config.mjs';
import { commands } from '../src/commands.mjs';
import { panel, applicationModal, ticketModal } from '../src/ui.mjs';
import { applicationSteps } from '../src/application.mjs';

try {
  const config = loadConfig(process.env, false);
  for (const guild of config.guilds) {
    const definitions = commands(config.maxBet, guild.ticketsEnabled);
    if (definitions.some(cmd => cmd.name === 'ticket') !== guild.ticketsEnabled) throw new Error('Ticket-commands komen niet overeen met guild-configuratie.');
    panel({ ...config, ...guild }).embeds[0].toJSON();
    console.log(`Guild ${guild.guildId}: configuratie en ${definitions.length} commands OK. Tickets ${guild.ticketsEnabled ? 'aan' : 'uit'}.`);
    if (!guild.staffRoleIds.length) console.log('  Kies na het starten je leidingrol met /inrichten.');
  }
  for (let step = 0; step < applicationSteps.length; step++) applicationModal({ id: 'preview', step, revision: step, answers: {} }).toJSON();
  ticketModal().toJSON();
  console.log('Embeds, knoppen en compatibiliteit met oude sollicitaties OK. Deze check maakt geen verbinding met Discord.');
} catch (error) { console.error(error.message); process.exitCode = 1; }

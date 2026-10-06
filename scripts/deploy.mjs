import { REST, Routes, PermissionFlagsBits as P } from 'discord.js';
import { loadConfig } from '../src/config.mjs';
import { commands } from '../src/commands.mjs';

try {
  const config = loadConfig();
  const rest = new REST({ version: '10' }).setToken(config.token);
  const application = await rest.get(Routes.currentApplication());
  if (application.id !== config.clientId) throw new Error('CLIENT_ID hoort niet bij dit bot-token. Controleer je .env.');
  for (const guild of config.guilds) {
    // Dit vervangt alleen de guild-commands van deze eigen bot-applicatie.
    const registered = await rest.put(Routes.applicationGuildCommands(config.clientId, guild.guildId),
      { body: commands(config.maxBet, guild.ticketsEnabled) });
    console.log(`Guild ${guild.guildId}: ${registered.length} commands geregistreerd. Tickets ${guild.ticketsEnabled ? 'aan' : 'uit'}.`);
  }
  const permissions = P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.EmbedLinks | P.AttachFiles | P.ManageChannels | P.ManageRoles;
  for (const guild of config.guilds) console.log(`Uitnodiging guild ${guild.guildId}: https://discord.com/oauth2/authorize?client_id=${config.clientId}&scope=bot%20applications.commands&permissions=${permissions}&guild_id=${guild.guildId}&disable_guild_select=true`);
} catch (error) {
  console.error(error.message?.startsWith('Configuratie') || error.message?.startsWith('CLIENT_ID') ? error.message : `Commands registreren mislukt (${error.code ?? error.name}). Nodig de bot uit in beide guilds en controleer je .env.`);
  process.exitCode = 1;
}

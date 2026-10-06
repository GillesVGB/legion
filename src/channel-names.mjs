export function caseChannelName(kind, user) {
  const prefix = kind === 'application' ? 'sollicitatie' : kind === 'interview' ? 'gesprek' : 'vraag';
  const username = String(user?.username || 'gebruiker').normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'gebruiker';
  return `${prefix}-${username.slice(0, 100 - prefix.length - 1).replace(/-+$/, '')}`;
}

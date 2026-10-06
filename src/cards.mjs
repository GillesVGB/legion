import { randomInt } from 'node:crypto';

export function makeDeck(rng = randomInt) {
  const deck = ['♠', '♥', '♦', '♣'].flatMap(suit =>
    ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'].map(rank => ({ rank, suit })));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function handValue(cards) {
  let aces = 0;
  let total = 0;
  for (const { rank } of cards) {
    if (rank === 'A') { aces++; total += 11; }
    else total += ['J', 'Q', 'K'].includes(rank) ? 10 : Number(rank);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

export const natural = cards => cards.length === 2 && handValue(cards) === 21;
export const showCards = cards => cards.map(x => `${x.rank}${x.suit}`).join('  ');

// credit is de totale teruggave: winst bevat ook de oorspronkelijke inzet.
export function resultOf(game) {
  const player = handValue(game.player);
  const dealer = handValue(game.dealer);
  if (player > 21) return { credit: 0, text: 'Bust! Je gaat over 21. De dealer wint.' };
  if (natural(game.player) && natural(game.dealer)) return { credit: game.bet, text: 'Allebei blackjack: gelijkspel.' };
  if (natural(game.player)) return { credit: game.bet * 2.5, text: 'Blackjack! Uitbetaling 3:2.' };
  if (natural(game.dealer)) return { credit: 0, text: 'De dealer heeft blackjack.' };
  if (dealer > 21 || player > dealer) return { credit: game.bet * 2, text: 'Je wint! Uitbetaling 1:1.' };
  if (player === dealer) return { credit: game.bet, text: 'Gelijkspel: je krijgt je inzet terug.' };
  return { credit: 0, text: 'De dealer wint.' };
}

export function finishDealer(game) {
  // Dealer blijft staan op 17, ook op soft 17.
  while (handValue(game.dealer) < 17) game.dealer.push(game.deck.pop());
  return resultOf(game);
}

/**
 * I giochi, con l'id che l'API accetta in `game=`.
 *
 * Sono un enum negli schemi degli strumenti perche' un enum e' un errore che il
 * modello non puo' commettere: `one-piece` invece di `onepiece` sarebbe un 400
 * pagato in un giro di conversazione. Il rovescio e' che un gioco nuovo
 * dell'API qui non esiste finche' non si pubblica una versione: per questo
 * `atcg_get_coverage` legge l'elenco vivo da `/v1/games` e dice quali giochi
 * l'API serve che questo elenco non conosce.
 *
 * L'ordine e' quello di `web/src/lib/site.ts` (GAMES), cioe' del sito.
 */
export const GAMES = [
  { id: 'pokemon', name: 'Pokémon TCG' },
  { id: 'yugioh', name: 'Yu-Gi-Oh! Trading Card Game' },
  { id: 'onepiece', name: 'One Piece Card Game' },
  { id: 'lorcana', name: 'Disney Lorcana' },
  { id: 'digimon', name: 'Digimon Card Game' },
  { id: 'dragonball-fw', name: 'Dragon Ball Super Card Game Fusion World' },
  { id: 'fab', name: 'Flesh and Blood' },
  { id: 'swu', name: 'Star Wars: Unlimited' },
  { id: 'weissschwarz', name: 'Weiss Schwarz' },
  { id: 'vanguard', name: 'Cardfight!! Vanguard' },
  { id: 'riftbound', name: 'Riftbound' },
  { id: 'gundam', name: 'Gundam Card Game' },
  { id: 'fftcg', name: 'Final Fantasy Trading Card Game' },
  { id: 'fow', name: 'Force of Will' },
  { id: 'dragonball-masters', name: 'Dragon Ball Super Card Game Masters' },
  { id: 'battlespirits', name: 'Battle Spirits Saga' },
  { id: 'cyberpunk', name: 'Cyberpunk TCG' },
  { id: 'swdestiny', name: 'Star Wars: Destiny' },
  { id: 'dragoborne', name: 'Dragoborne: Rise to Supremacy' },
] as const;

export type GameId = (typeof GAMES)[number]['id'];

export const GAME_IDS: readonly GameId[] = GAMES.map((game) => game.id);

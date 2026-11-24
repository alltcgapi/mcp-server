---
name: tcg-card-data
description: Look up trading cards, sets, sealed products and their current prices across 19 games (Pokémon, Yu-Gi-Oh!, One Piece, Lorcana, Digimon, Flesh and Blood, Star Wars: Unlimited and more) with the alltcgapi tools. Use when the user asks what a card or a booster box is worth, wants cards by name or collector number, lists the sets of a game, or asks which games have Cardmarket or TCGplayer prices.
---

# Trading card data

The `atcg_*` tools read the catalogue at alltcgapi.com. They are all read-only. Most calls cost
credits on the user's account, so answer with the fewest calls that settle the question.

## Which tool

- A card by name or number, in one game or in all: `atcg_search_cards`. Pass `game` when the user
  names one; it is the cheapest way to cut a common name down.
- One card in full (names per language, attributes, image, marketplace ids): `atcg_get_card`. Add
  `include_prices` when the user also wants its value: one call instead of two.
- What a card or a sealed product is worth: `atcg_get_prices` with `type` `card` or `sealed`.
- The sets of a game: `atcg_list_sets`; the cards of one set, in number order: `atcg_list_set_cards`.
- Booster boxes, packs, starter decks: `atcg_search_sealed`, then `atcg_get_prices` with `type: "sealed"`.
- Whether the API has a game, or prices for it: `atcg_get_coverage`. Do not infer coverage from a
  game's name or from an empty search.

## Finding a card

- Name search matches the **start** of the name, ignoring case. "charizard" finds "Charizard ex",
  not "Dark Charizard". With no result, retry with the first word before saying the card is missing.
- Ids are UUIDs. Never build one; take it from a search row.
- Two printings can share a name. Pick by set and number, and tell the user which one you used.

## Reading prices

- Cardmarket quotes are in **EUR**, TCGplayer quotes in **USD**. Report the two markets separately.
  Never add them, average them or convert one into the other.
- Give the source and the `as_of` date with every price. The result says how old the newest quote
  is; if it is more than a week old, say so.
- `variant` says what the number is. `LOWEST_NEAR_MINT` and `LOWEST` are asking prices (offers),
  `MARKET`, `AVG_7D` and `AVG_30D` come from sales, `TREND` is the source's trend figure.
- Read `language`, `condition` and `printing` on the row you quote. A Japanese copy and an English
  copy are two listings; TCGplayer prices Normal and Holofoil apart.
- An empty list means no source quotes the item today, not that the item does not exist.

## What these tools do not hold

- No price history through these tools: only the latest quote of each series. The REST API has a
  history route; do not claim a trend from these results.
- No graded prices (PSA, BGS, CGC).
- No photo recognition: do not claim to identify a card from an image with these tools.
- No deck legality or rules search.

## Refusals

`TRIAL_EXPIRED` and `QUOTA_EXCEEDED` mean the account needs something only its owner can do. Tell
the user as written and stop; do not retry. `RATE_LIMITED` says how many seconds to wait.

# @alltcgapi/mcp

An [MCP](https://modelcontextprotocol.io) server for [alltcgapi](https://alltcgapi.com), the trading
card game API. It gives an agent seven tools over one catalogue of 19 games: cards, sets, sealed
products and the current Cardmarket (EUR) and TCGplayer (USD) quotes of each, every quote with its
source and the date it was observed.

Games: Pokémon, Yu-Gi-Oh!, One Piece, Disney Lorcana, Digimon, Dragon Ball Super Fusion World,
Flesh and Blood, Star Wars: Unlimited, Weiss Schwarz, Cardfight!! Vanguard, Riftbound, Gundam,
Final Fantasy, Force of Will, Dragon Ball Super Masters, Battle Spirits Saga, Cyberpunk,
Star Wars: Destiny and Dragoborne. Which of them the API serves today, and which have quotes from
which source, is what `atcg_get_coverage` answers from a live call.

Unofficial. Not produced, endorsed, supported by or affiliated with any of the publishers of the
games above. All game names and marks are trademarks of their respective owners.

## Get a key

Sign up at [alltcgapi.com/free-api-key](https://alltcgapi.com/free-api-key): the page creates the
account and shows the key. A key starts with `atcg_live_` and is shown once.

## Install

Claude Code:

```bash
claude mcp add alltcgapi --env ALLTCG_API_KEY=your-key -- npx -y @alltcgapi/mcp
```

Claude Desktop, `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "alltcgapi": {
      "command": "npx",
      "args": ["-y", "@alltcgapi/mcp"],
      "env": { "ALLTCG_API_KEY": "your-key" }
    }
  }
}
```

Cursor, `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "alltcgapi": {
      "command": "npx",
      "args": ["-y", "@alltcgapi/mcp"],
      "env": { "ALLTCG_API_KEY": "${env:ALLTCG_API_KEY}" }
    }
  }
}
```

VS Code, `.vscode/mcp.json`. The top-level key is `servers`, and `inputs` keeps the key out of the
committed file:

```json
{
  "inputs": [
    { "id": "alltcg-key", "type": "promptString", "description": "alltcgapi key", "password": true }
  ],
  "servers": {
    "alltcgapi": {
      "command": "npx",
      "args": ["-y", "@alltcgapi/mcp"],
      "env": { "ALLTCG_API_KEY": "${input:alltcg-key}" }
    }
  }
}
```

Environment: `ALLTCG_API_KEY`, and `ALLTCG_BASE_URL` (defaults to `https://api.alltcgapi.com`).
Node 20 or newer. Without a key the server starts and lists its tools; the calls then come back
saying what is missing, except `atcg_get_coverage`, which still reports price coverage and refresh
times from public routes.

## The tools

Seven tools, not one per route. `tools/list` sits in the model's context on every turn, and each
tool is shaped like a question, so the model does not chain four calls to answer one thing.

| Tool | Answers | Credits |
|---|---|---|
| `atcg_search_cards` | Cards by name or collector number, in one game or across all of them | 1 |
| `atcg_get_card` | One card in full: names per language, attributes, image, Cardmarket and TCGplayer ids; optionally its quotes | 1, +2 with prices |
| `atcg_list_sets` | "Every One Piece set released in 2025", by game, print line, name or release window | 1 per page |
| `atcg_list_set_cards` | The cards of one set, in collector-number order | 1 |
| `atcg_search_sealed` | Booster boxes, packs and decks by game, set, kind, name or language | 1 per 50 rows |
| `atcg_get_prices` | Every current quote of a card or a sealed product, one summary line per currency | 2 |
| `atcg_get_coverage` | What the API holds per game, which games have quotes from which source, and what it does not hold at all | 1 |

Every tool is annotated `readOnlyHint: true` and `destructiveHint: false`. Nothing here writes.

Parameters are enumerated where the API would refuse a wrong value: `game` takes one of the 19 ids,
`region` is `WEST` or `EAST`, `source` is `CARDMARKET` or `TCGPLAYER`. An id that is not a UUID is
refused before any call is spent, with the name of the tool that finds one.

## Reading prices correctly

A quote is one source, one variant, one language, one amount in one currency, and the day it was
observed. An item usually has several, and the API returns them all rather than blending them into a
single number. The tool keeps it that way:

- **Two currencies, never one figure.** Cardmarket quotes are in EUR and TCGplayer quotes in USD.
  Nothing is converted. The result opens with one line per currency (how many quotes, from which
  source, how recent) and, when both are present, a line telling the model to report them apart.
- **Dates.** Every quote carries `as_of`, a day in UTC: the API serves each source about a day behind.
  When the newest quote in a currency is more than seven days old, the summary line says so, so an
  old number is not passed off as today's.
- **Variants.** `LOWEST_NEAR_MINT` (lowest asking price for a near mint copy) and `LOWEST` (lowest
  asking price, sealed products) are offers; `MARKET` (TCGplayer), `AVG_7D` and `AVG_30D` come from
  sales; `TREND` is the source's trend price.
- **Rows.** `language` is the language of the copy that was quoted; `printing` separates Normal and
  Holofoil on TCGplayer; `condition` and `region` are set when the source states them.
- **Empty is not missing.** An item with no quote returns an empty list. The catalogue has it, and no
  source quotes it today.

## What these tools do not have

`atcg_get_coverage` returns these from the server rather than leaving a model to infer them:

- No price history through these tools: they return only the latest quote of each series. The REST
  API serves the history of a card or a sealed product; this server has no tool for it yet.
- No graded prices.
- No currency conversion.
- No individual listings, sellers or stock counts.
- No photo recognition.
- No rules text search and no deck legality.
- Card name search is a prefix match on the start of the name, ignoring case, not full text.

## Context discipline

Results are capped at 50 rows whatever the API allows, sent as aligned tables rather than JSON. The
exact objects travel in `structuredContent` for clients that read it. Truncation is always announced,
with the cursor to continue. Price rows are never truncated.

When a tool filters locally (a set name, a release window, a sealed product's name or language), it
reads pages and keeps the matching rows, up to eight pages, and says when it stopped before the end.

## Over HTTP

The package carries a second entry, `dist/http-main.js`, that serves the same seven tools over
streamable HTTP. It is what runs behind the hosted server at `https://mcp.alltcgapi.com/mcp`; the
stdio entry above is unchanged.

Over HTTP the server holds no key of its own. Each request carries an OAuth Bearer token. The server
checks it against the API's token introspection endpoint (RFC 7662), refuses a token issued for
another resource, and calls the API with it, so usage lands on the account of whoever is calling. A
request without a token gets a `401` whose `WWW-Authenticate` header points at
`/.well-known/oauth-protected-resource`, which names the authorization server. On this transport the
tool descriptions and refusals do not mention credits or plans.

To try it from a clone, with an API key in place of an OAuth token:

```bash
npm ci && npm run build
ALLTCG_MCP_ACCEPT_API_KEYS=1 ALLTCG_MCP_PUBLIC_URL=http://localhost:8080/mcp node dist/http-main.js
claude mcp add --transport http alltcgapi-http http://localhost:8080/mcp --header "Authorization: Bearer your-key"
```

It is not a second `bin`: with two, `npx -y @alltcgapi/mcp` could no longer tell which one to run.
`ALLTCG_MCP_ACCEPT_API_KEYS` is for local testing only. The other settings are `PORT`,
`ALLTCG_MCP_PUBLIC_URL`, `ALLTCG_OAUTH_ISSUER`, `ALLTCG_BASE_URL`, `ALLTCG_MCP_INTROSPECTION_URL`,
`ALLTCG_MCP_PROXY_SECRET` and `ALLTCG_MCP_ALLOWED_HOSTS`; `src/http-main.ts` lists their defaults.

## Protocol

Built on `@modelcontextprotocol/server` v2. The protocol revisions it negotiates are the library's,
not a claim of our own.

## Build from source

```bash
npm ci
npm run typecheck
npm test
```

Node 20 or newer. `npm test` builds and runs the unit tests in `tests/` against a stubbed API.

## Licence

MIT. Data served by the API carries per-source terms: see
[alltcgapi.com/legal/attribution](https://alltcgapi.com/legal/attribution).

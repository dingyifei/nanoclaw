---
name: hotel-price-check
description: Find the best effective hotel price by comparing direct rates, OTAs, cashback portals, airline portals, Gondola.ai, and BRG opportunities. Use when the user wants to book a hotel, compare hotel prices, or optimize hotel cashback.
allowed-tools: Bash(agent-browser:*)
argument-hint: "[hotel name] [location] [check-in] [check-out]"
---

# Hotel Best Price Checker with Cashback & Points Optimization

Find the best effective price for a hotel booking by checking direct hotel rates, OTA prices, cashback portals, airline hotel portals, and calculating true effective costs with points valuations.

## Additional resources

- For default CPP valuations, see [cpp-valuations.md](cpp-valuations.md)
- For Gondola.ai supported chains and tier rates, see [gondola-chains.md](gondola-chains.md)
- For Best Rate Guarantee terms, see [brg-reference.md](brg-reference.md)

## Prerequisites

### Tool preference order
1. **MCP tools** — if an MCP server exists for a site, use it directly
2. **WebFetch** — for sites where data is in the HTML source (CashbackMonitor, xe.com)
3. **Browser automation** — for sites requiring JS rendering (Google Travel, Super.com, hotel direct sites, airline portals, portal verification)

### Browser setup
- Use `agent-browser` CLI for all browser automation. Core workflow:
  ```bash
  agent-browser open <url>        # Navigate to page
  agent-browser snapshot -i       # Get interactive elements with refs
  agent-browser click @e1         # Click element by ref
  agent-browser fill @e2 "text"   # Fill input by ref
  agent-browser close             # Close browser
  ```
- **Session persistence**: Use `agent-browser state save hotel-session` after logging in to sites (Gondola.ai, hotel loyalty accounts) and `agent-browser state load hotel-session` at the start of future runs to restore login state. Check preferences file for whether a saved state exists.
- **Automation failures**: If a site blocks automation (CAPTCHA, anti-bot), attempt a reasonable bypass (refresh, try mobile URL). If still blocked, **skip it and continue**. List all skipped sites at the end for the user to check manually.

### Parallel execution
If the Task tool is available, launch independent lookups as parallel subagents to minimize total execution time:
- **Steps 1 + 2 + 3** (hotel direct, Google Travel, Super.com) can run in parallel
- **Step 4** (CashbackMonitor) — multiple store lookups can run in parallel via WebFetch
- **Step 5** (airline portals) — all 4 portals can be checked in parallel

## Step 0: Gather Inputs & Check Preferences

### Load preferences first
Before asking the user anything, read `/workspace/global/hotel-preferences.md` (if it exists) for saved data:
1. **CPP valuations** — user may have custom overrides (see [cpp-valuations.md](cpp-valuations.md) for defaults)
2. **Credit cards** — card portfolio, especially hotel co-branded cards (e.g., Hilton Aspire 14x, Marriott Bonvoy Brilliant 6x, World of Hyatt card 4x)
3. **Hotel loyalty status** — e.g., Marriott Titanium, Hilton Diamond. Affects elite perks and point earning rates.
4. **Loyalty point valuations** — e.g., Hilton points at 0.5 cpp, Hyatt at 2.0 cpp
5. **Gondola.ai tier** — Regular (3%), Silver (5%), or Gold (7%). See [gondola-chains.md](gondola-chains.md)
6. **Browser state** — whether `hotel-session` state was previously saved

If the file doesn't exist, proceed to ask the user — preferences will be saved at the end (main group only).

### Parse $ARGUMENTS
If arguments were passed (e.g., `hotel-price-check Hilton Tokyo Bay Tokyo 2026-04-01 2026-04-03`), parse them to pre-fill:
- Hotel name, location, check-in date, check-out date

### Ask for missing inputs
1. **Hotel name** — e.g., "The Peridot Smart Hotel Tancha Ward"
2. **Location** — e.g., "Onna, Okinawa, Japan"
3. **Check-in date** / **Check-out date**
4. **Number of guests** — default 2
5. **Number of rooms** — default 1
6. **Room type preference** — if none, use cheapest available
7. **Constraints** — e.g., "must be free cancellation", "need breakfast" (optional)
8. **Credit cards** — if not in preferences, ask (especially hotel co-branded)
9. **Hotel loyalty status** — if chain hotel and not in preferences, ask
10. **Gondola.ai tier** — if not in preferences, mention Gondola gives 3/5/7% back on direct hotel bookings, ask if they have an account
11. **Interactive help?** — ask if user will help check prices when sites block automation

## Step 1: Check Hotel's Direct Website

### 1a: Identify hotel chain
Determine if the hotel is a major chain (Marriott, Hilton, Hyatt, IHG, Accor, Best Western, Wyndham, Choice) or independent. This determines AAA/AARP rates, loyalty earning, co-branded CC bonuses, BRG, and Gondola eligibility.

### 1b: Check direct rates via Gondola (preferred for supported chains)
If the hotel is a [supported Gondola chain](gondola-chains.md), use Gondola.ai as the primary interface for checking direct rates:

1. Run `agent-browser state load hotel-session` to restore login state (if previously saved)
2. Navigate to `https://www.gondola.ai/` via `agent-browser open`
3. If not logged in, **prompt the user to log in** (required to see prices). After login, run `agent-browser state save hotel-session`.
4. Search for the hotel, set dates/guests
5. Record rate variants shown: **member rate**, **AAA rate**, **AARP rate** (Gondola surfaces these from the chain)
6. For each rate record:
   - **Price** (before and after tax if shown)
   - **Room type** — cheapest unless user specified. Note **breakfast inclusion**; prefer with-breakfast if same price.
   - **Cancellation policy**
   - **Loyalty points earned** (check preferences for user's tier-specific earning rate)
7. Gondola Cash earned = pre-tax × tier rate (3%/5%/7%) — applied on top of whatever rate is shown

**Fallback**: If Gondola is unavailable, blocked, or user can't log in, navigate to the hotel chain's own website directly and check the same rate variants.

### 1b-alt: Check direct rates for non-Gondola hotels
For independent hotels or chains not in the [Gondola list](gondola-chains.md), navigate to the hotel's own website:
1. Search for the hotel, set dates/guests
2. Record rate variants and details (same as 1b above, minus Gondola Cash)

### 1d: Check cashback portals for hotel direct site
Look up the chain's website on CashbackMonitor (e.g., "hilton", "marriott"). **Constraints:**
- Cashback portals only work on **regular member rates** — NOT AAA/AARP/special rates
- Do NOT apply to Gondola bookings
- May NOT trigger hotel co-branded CC bonus

### 1e: Direct booking effective costs
Show as **separate rows** in the final table:

| Variant | Cashback/Gondola | Hotel CC Bonus? | Loyalty Points? |
|---------|-----------------|-----------------|-----------------|
| Direct (regular) + cashback portal | Portal rate on pre-tax | Likely no | Yes (may vary) |
| Direct (any rate) + Gondola | Gondola tier % on pre-tax | Yes | Yes, full rate |
| Direct (any rate) raw | None | Yes | Yes, full rate |

## Step 2: Get OTA Prices from Google Travel

1. Go to `https://www.google.com/travel/hotels` via `agent-browser open`
2. **Check locale first** — set **currency to USD**, **country to United States** via the top-left settings icon
3. Search for the hotel by name and location
4. Set dates and guest count
5. Click into the hotel listing for price comparison
6. Click "View more options" if present to expand the full list
7. Record ALL options with:
   - **Price** (after tax — Google Travel default)
   - **Room type** and **breakfast inclusion**
   - **Prepaid vs. pay at hotel**
8. Use **cheapest room** unless user specified. Fuzzy match room types across sources ("Superior King" ≈ "King Room" ≈ "1 King Bed"). Prefer with-breakfast if same price.

## Step 3: Check Super.com

1. Navigate to `https://www.super.com/hotels` via `agent-browser open`
2. Search for the same hotel and dates
3. Record: price, Super Cash/discount, cancellation policy, room type
4. **Ignore cross-listed OTA prices** — they are often inaccurate. Only use Super.com's own booking price.

## Step 4: Cashback Rates — CashbackMonitor + Verification

For each OTA from Step 2 **and** the hotel direct site from Step 1d, look up rates on CashbackMonitor.

### Preferred method — WebFetch (no browser needed):
Fetch `https://www.cashbackmonitor.com/cashback-store/{store-name}/` using WebFetch. Cashback rates are in the HTML source as `var str1=[...]` — parse with regex. If `str1` is empty, fall back to browser automation for that store.

### Portals to check (pull rates live — do not hardcode):
- **Cashback**: Rakuten (**use MR earning mode** — valued at 1.4 cpp > cash), TopCashBack, BeFrugal, ShopBack
- **Airline miles**: AA AAdvantage, Alaska Mileage Plan, Delta SkyMiles, United MileagePlus, JetBlue, Southwest Rapid Rewards, Virgin Atlantic Shops Away, Flying Blue, Emirates Skywards
- **Hotel points**: Wyndham Rewards Shopping
- **Other**: Capital One Shopping, any other notable portals

### Verification (CRITICAL)
For the top ~5-8 combinations by potential value, visit the actual portal site:
- CashbackMonitor headline rates ("up to X%") are often for non-hotel categories
- Always check **Terms & Exclusions**
- Note promo expiration times
- URL patterns: `topcashback.com/{store}`, `rakuten.com/shop/{store}`, `befrugal.com/store/{store}`

### Common gotchas
- Headline rates like "16% cashback" often apply to non-hotel categories (e.g., Klook TCB rate is "US Tours" — hotels may be 0.5%)
- Localized OTAs (楽天トラベル/じゃらん in Japan, MakeMyTrip in India, regional Booking.com) typically have NO US cashback portal coverage
- Regional hotel categories on portals may have lower rates than headline
- Some portals exclude non-US site versions (e.g., Expedia.co.jp vs Expedia.com)
- Promo rates ("Ends in X Hours") may expire before you book

## Step 5: Check Airline Hotel Portals

Search each portal for the hotel, set dates, record price + miles/points earned. Value at CPP from preferences or [defaults](cpp-valuations.md).

| Portal | URL | Currency | Notes |
|--------|-----|----------|-------|
| AA Hotels | `aadvantagehotels.com` | AA miles | Often 100-1800 mi/stay |
| Alaska Hotels | `alaskaair.com/hotels` | Atmos points | Search by city, filter by name. ~1 pt/$1 |
| Delta Hotels | `delta.com/flight-hotel/search` | SkyMiles | Search by location |
| United Hotels | `united.com/en-us/hotels` | MileagePlus miles | Search by location |

Record room type, breakfast, and whether price is before or after tax.

## Step 6: Calculate Effective Cost & Build Comparison Table

```
Effective Cost = Base Price (after tax)
              - Cashback/Gondola Value (on pre-tax)
              - Loyalty Points Earned × CPP (on pre-tax)
              - Hotel CC Bonus Value (on pre-tax, direct/Gondola only)
```

### Conversion rules
- **Cashback**: applied to **pre-tax price**. If only after-tax known, estimate pre-tax as ~85-90% of after-tax.
- **Gondola Cash**: pre-tax × tier rate, face value ($1 = $1)
- **Portal points/miles**: rates from CashbackMonitor × pre-tax × CPP valuation
- **Hotel loyalty points**: earned on pre-tax at direct rate (tier-dependent). Full rate only for direct/Gondola.
- **Hotel CC bonus**: incremental multiplier × pre-tax × CPP. Only on **direct booking or Gondola**.
- **Currency conversion**: use WebFetch to fetch `https://www.xe.com/currencyconverter/convert/?Amount={amount}&From={currency}&To=USD` — rate is server-rendered in HTML. Note FX fee risk for non-USD bookings.
- All final prices: **USD after-tax**. All earning: **pre-tax**.

### Comparison table

| Option | Room Type | Breakfast? | Base (after tax) | Est. Pre-Tax | Prepaid? | Portal | CB/Gondola Rate | Card Bonus | Value Back | **Effective Cost** |
|--------|-----------|-----------|-----------------|-------------|----------|--------|-----------------|------------|------------|-------------------|

Sort by effective cost ascending. Include ALL viable options.

## Step 7: Recommendation

### 1. Cheapest Option
Lowest effective cost with full booking instructions (portal to click through, card to use, site to book on).

### 2. Best Flexible Option
Cheapest option that is **prepaid with free cancellation** or **pay at hotel**. Skip if cheapest is already flexible.

### 3. BRG Opportunity
If any OTA < direct for a major chain, flag it:
> "You can BRG this — book direct at [chain], then submit [OTA] price within 24 hours. You'd get the lower rate + [bonus]. Deadline: [pre-arrival min]."

See [brg-reference.md](brg-reference.md) for exact terms per chain.

### Additional flags
- **Direct booking perks** — if direct is within ~$10 of cheapest, flag loyalty benefits as potentially worth the premium
- **Points posting reliability** — some portals are slow or unreliable
- **$5 threshold** — if top option is within ~$5 of a simpler alternative, flag hassle vs. savings

## Step 8: Save Preferences

If new preferences were learned during this run (credit cards, loyalty status, CPP valuations, Gondola tier, browser state saved):

**If running in main group**: Write or update `/workspace/global/hotel-preferences.md` with the new data. Merge with existing content — don't overwrite previously saved preferences.

**If running in a non-main group**: Global is read-only. Include the new preferences in your response and tell the user: "These preferences can't be saved from this group. To persist them, ask me to save hotel preferences from the main group."

## Notes

- Stacking: ONE cashback portal + credit card points OK, but not two portals
- Gift card stacking (e.g., Fluz) — note but don't assume stackable
- **Locale/currency**: all prices in English / USD. For Google Travel, fix via settings. For other sites, attempt to switch. If can't, flag clearly with conversion note.

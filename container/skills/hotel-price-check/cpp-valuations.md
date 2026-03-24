# Default CPP (Cents Per Point) Valuations

**Always check memory first** for user-specific overrides before using these defaults.

| Currency | Default CPP |
|----------|------------|
| Amex MR | 1.4 |
| AA AAdvantage miles | 1.4 |
| Alaska Mileage Plan / Atmos | 1.4 |
| United MileagePlus miles | 1.4 |
| JetBlue TrueBlue points | 1.3 |
| Virgin Atlantic Flying Club miles | 1.3 |
| Southwest Rapid Rewards points | 1.3 |
| Delta SkyMiles | 1.2 |
| Air France/KLM Flying Blue miles | 1.2 |
| Emirates Skywards miles | 1.1 |
| Wyndham Rewards points | 0.7 |
| Cash back | 1:1 |

## Notes

- mi/$ and pt/$ **earning rates** are always pulled live from CashbackMonitor — never hardcode them
- CPP valuations are subjective and should be overridden by user preference when available
- If the user provides new valuations during a session, **save them to memory** for future runs
- Gondola Cash is valued at face value ($1 = $1) — it's future booking credit, not liquid cash

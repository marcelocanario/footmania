# Multiplayer Transfer Market Overhaul — Full Implementation Plan

## 1. Goals

Replace the current fragmented transfer logic with a multiplayer-safe market where:

* Human and AI clubs use the same market infrastructure.
* Auctions are the only way a contracted player is permanently transferred between clubs.
* Free agents have their own competitive signing market.
* Loans remain a separate first-come, first-served market with no loan fee.
* Sellers cannot select buyers.
* Clubs cannot privately transfer arbitrary amounts of money to one another.
* Disposable/multi-account teams cannot easily funnel players or money into another team.
* AI clubs make rational squad-management decisions and never knowingly commit to transactions that make them financially insolvent.
* AI never has access to hidden bid information or hidden player-development information.
* Board confidence and manager-sacking mechanics are removed.
* The concepts of star players and club reputation are removed from transfer-market behavior and, where they still exist elsewhere, removed from the game entirely.
* Existing `player.value` remains the single reference valuation used by the market.

---

# 2. Final Market Structure

Keep the existing transfer-page separation:

```text
┌────────────┬─────────────┬─────────┬───────────────┐
│ Auctions   │ Free Agents │ Loans   │ List for Sale │
└────────────┴─────────────┴─────────┴───────────────┘
```

These are deliberately different markets.

### Auctions

```text
Contracted player
→ owner lists player
→ public proxy-bid auction
→ human + AI clubs compete
→ winner pays selling club
```

### Free Agents

```text
Unowned player
→ system lists player
→ public proxy-bid signing process
→ human + AI clubs compete
→ winner pays system
```

### Loans

```text
Contracted player
→ owner lists player for loan
→ public exposure period
→ listing becomes claimable
→ first eligible club to claim gets player
→ no loan fee
```

There must be no alternative player-transfer route.

---

# 3. Remove the Current Fragmented Transfer Paths

Remove or replace the responsibilities currently handled by:

```text
/transfers/bid
evaluateBid()
counterOffer()
findBuyer()
aiBuyListings()
spawnAuction()
AI-only auction eligibility
fixed salePrice purchases
direct AI → AI transfers
direct human → AI transfers
direct AI → human transfers
```

Also remove the current rule that prevents humans from participating in AI auctions.

Humans and AI must be equally eligible.

`aiSellSurplus()` may remain conceptually, but its only job should become:

```text
Decide whether AI should create a public listing.
```

Likewise, `aiBid()` should no longer implement its own bidding mechanics. It should only calculate an AI maximum bid and call the shared market API.

---

# 4. No Direct Transfers or Expressions of Interest

There must be no:

* direct human-to-human offers;
* direct human-to-AI offers;
* direct AI-to-human offers;
* direct AI-to-AI offers;
* expressions of interest;
* negotiated transfer prices;
* seller-selected buyer;
* fixed-price player transfer.

An unlisted contracted player is simply unavailable.

If an AI owns a player that a human wants:

```text
The human must wait until the AI independently decides to list him.
```

The same applies in reverse.

This is intentional.

It prevents private coordination between accounts and creates one transparent marketplace.

---

# 5. Existing Player Value Is the Market Reference

Do **not** create a second Fair Market Value system.

Use:

```ts
player.value
```

as the reference for:

* auction opening prices;
* auction maximum permitted prices;
* free-agent starting bids;
* loan-related informational display;
* AI valuation;
* recent-market-price calculations.

For example:

```text
Charlie Smith

Value: $5.8M
```

The market should derive its pricing from that $5.8M.

---

# 6. Remove the Star Player Concept

The star-player concept is being removed entirely.

Remove:

* star flags/properties where no longer required;
* star-specific valuation multipliers;
* star-specific auction/listing restrictions;
* star-specific AI behavior;
* star-specific youth modifiers;
* star-specific UI;
* star-specific transfer logic;
* any code that prevents an AI from selling a player because he is classified as a star.

In particular, update `calcValue` so the existing star multipliers no longer affect `player.value`.

AI squad importance must instead be inferred from actual football/squad context.

---

# 7. Remove Club Reputation from Transfer Logic

There must no longer be logic such as:

```text
AI club reputation >= 3
```

for participating in auctions.

Remove reputation from:

* bidding eligibility;
* player pricing;
* transfer willingness;
* AI buying behavior;
* AI selling behavior.

If club reputation is still represented elsewhere in the game, complete the previously planned removal of that concept rather than retaining transfer-specific compatibility logic.

---

# 8. Shared Marketplace Architecture

Separate **decision-making** from **market execution**.

Recommended structure:

```text
TransferMarket
│
├── TransferAuctionService
│   ├── createListing()
│   ├── submitMaxBid()
│   ├── resolveAuction()
│   └── completeTransfer()
│
├── FreeAgentMarketService
│   ├── createListing()
│   ├── submitMaxBid()
│   ├── resolveSigning()
│   └── signPlayer()
│
├── LoanMarketService
│   ├── createListing()
│   ├── exposeListing()
│   ├── claimListing()
│   └── completeLoan()
│
├── ProxyBidEngine
│   ├── validateMaxBid()
│   ├── calculateCurrentPrice()
│   ├── determineLeader()
│   └── extendDeadline()
│
├── MarketFinanceService
│   ├── reserveFunds()
│   ├── releaseFunds()
│   ├── getAvailableMarketBudget()
│   └── validateCommitment()
│
└── MarketHistoryService
    ├── recordTransaction()
    └── calculateRecentPriceAnchor()
```

AI behavior remains separate:

```text
AITransferStrategy
│
├── evaluateSquad()
├── calculateSellScore()
├── calculatePositionNeeds()
├── evaluateAuction()
├── evaluateFreeAgent()
├── calculateMaxBid()
├── evaluateLoanOut()
└── evaluateLoanClaim()
```

The AI decides.

The market service executes.

---

# 9. Auctions — Listing Rules

Only the owning club can list a contracted player.

The seller does **not** choose the starting price.

Calculate:

```ts
normalAuctionFloor = player.value * AUCTION_FLOOR_MULTIPLIER
```

Initial configuration:

```text
AUCTION_FLOOR_MULTIPLIER = 0.85
```

Example:

```text
Player value:    $10.0M
Opening bid:      $8.5M
```

The owner therefore makes only one decision:

> Am I willing to sell this player knowing that $8.5M is the minimum possible sale price?

If not, do not list him.

---

# 10. Auction Maximum Price

For club-to-club transfers, introduce a market-integrity ceiling to prevent disposable clubs from intentionally sending absurd amounts of money to another team.

Initial configuration:

```text
AUCTION_MAX_MULTIPLIER = 1.50
```

Therefore:

```text
Player value:      $10.0M
Opening price:      $8.5M
Maximum bid:       $15.0M
```

These are configuration parameters and must be easy to rebalance.

Do not scatter `0.85` or `1.50` constants throughout the engine.

---

# 11. eBay-Style Proxy Bidding

Players submit a private:

```text
MAXIMUM BID
```

They do not repeatedly submit visible incremental bids.

Example:

```text
Opening price: $8.5M

Club A max:   $10.0M
Club B max:   $12.0M
Club C max:    $9.5M
```

Club B wins.

The visible/current bid should be approximately:

```text
secondHighestMaximum + bidIncrement
```

subject to the leader's own maximum.

Therefore:

```text
Current price ≈ $10.1M
Leader = Club B
```

Club B does not immediately pay $12M.

---

# 12. Proxy Bid Calculation

Conceptually:

```ts
if (bidCount === 0) {
    currentPrice = openingPrice;
}

if (bidCount === 1) {
    currentPrice = openingPrice;
}

if (bidCount >= 2) {
    currentPrice = Math.min(
        highestMaxBid,
        secondHighestMaxBid + bidIncrement
    );
}
```

Always enforce:

```ts
currentPrice >= openingPrice;
```

---

# 13. Equal Maximum Bids

If two clubs submit the same maximum:

```text
earliest submitted maximum wins
```

Example:

```text
Club A: $10M at 12:00
Club B: $10M at 12:05
```

Club A remains leader.

At a tied ceiling:

```text
Current price = $10M
```

---

# 14. Bid Increment

The increment should scale with player value rather than use one universal number.

Starting implementation:

```ts
rawIncrement = player.value * 0.01;
```

Round the result to sensible monetary increments.

Examples:

```text
$500K player  → roughly $5K
$5M player    → roughly $50K
$20M player   → roughly $200K
```

The exact rounding bands should live in configuration/helper logic.

---

# 15. Maximum Bids Are Private

Never expose:

```text
Club A max bid
Club B max bid
Club C max bid
```

to:

* other players;
* sellers;
* AI;
* client-side code.

Clients should receive only what they need:

```text
Current bid
Whether my club is currently leading
My own maximum bid
Bidder count
Deadline
```

Do not send all maximum bids to the frontend and rely on UI hiding.

---

# 16. Bidder Identity

During the auction, preferably expose only:

```text
Current price: $8.7M
Bidders: 4
```

Do not expose the identities of competing clubs.

Once the auction ends, the winning club can become public.

This makes coordinated/shill bidding more difficult without changing market behavior.

---

# 17. Auction Duration

Initial configuration:

```text
AUCTION_DURATION = 24 hours
SOFT_CLOSE_WINDOW = 5 minutes
SOFT_CLOSE_EXTENSION = 5 minutes
```

Use real server timestamps rather than matchday counters.

Store deadlines in UTC.

---

# 18. Anti-Sniping Soft Close

If a competitive bid arrives near the deadline, extend it.

Example:

```text
Original deadline: 15:00

Competitive bid: 14:58
New deadline:     15:03

Competitive bid: 15:02
New deadline:     15:07
```

A bid should trigger an extension only if it:

* changes the leading bidder; or
* increases the actual current auction price.

A current leader merely increasing its hidden maximum must **not** be able to extend the auction repeatedly.

Automatic proxy-bid changes also do not independently extend the auction.

---

# 19. Bid Commitments Cannot Be Withdrawn

Once submitted:

```text
maxBid = $8M
```

the bidder cannot:

* withdraw;
* decrease the amount.

It may only:

```text
increase maximum bid
```

This prevents price manipulation.

---

# 20. Seller Cancellation

Before receiving any valid bid:

```text
seller may cancel listing
```

After the first valid bid:

```text
seller may not cancel
```

This applies equally to human and AI sellers.

---

# 21. Seller Cannot Bid on Own Player

Enforce at the service/database level:

```text
bidderClubId !== sellerClubId
```

Do not rely on the UI.

---

# 22. Auction Resolution Must Be Atomic

When the deadline expires:

1. lock the auction;
2. ensure it is still active;
3. determine winning bidder;
4. calculate final clearing price;
5. deduct final price;
6. credit seller;
7. transfer player;
8. preserve existing contract/salary;
9. record transaction history;
10. release excess reserved bid funds;
11. mark auction complete;
12. publish result/news event.

There should be no state where payment succeeds but player transfer fails or vice versa.

---

# 23. Reserve Maximum-Bid Funds

A club must not be able to win several auctions that exceed its available funds.

When currently leading:

```text
reservedAmount = club's private max bid
```

Not merely the current visible price.

Example:

```text
Cash: $20M

Leading Auction A:
max bid = $8M

Leading Auction B:
max bid = $6M

Reserved: $14M
Available before other financial commitments: $6M
```

If outbid beyond its maximum:

```text
reservation is immediately released
```

At auction settlement:

```text
final price = $5.4M
reserved max = $8M

$5.4M paid
$2.6M reservation released
```

---

# 24. Central Financial Commitment Validation

Both humans and AI must use the same financial validation service when placing market commitments.

Conceptually:

```ts
MarketFinanceService.validateCommitment(
    club,
    proposedMaxBid,
    playerSalaryCommitment
);
```

At minimum it must account for:

```text
current cash
- existing market reservations
- proposed maximum bid
- near-term committed payroll
```

The longer-term economy overhaul can expand this into the full solvency forecast.

Do not implement a bidding system that knows only:

```ts
club.cash >= bid
```

because that is the reason payroll can currently bankrupt teams after otherwise "affordable" decisions.

---

# 25. AI Must Never Knowingly Bid Itself Into Insolvency

AI bid calculation must be capped by:

```text
safe market budget
```

The AI must account for:

* transfer fee;
* existing salary inherited with the player;
* current payroll;
* other winning auction commitments;
* minimum required cash/payroll reserve.

An AI must never submit a maximum that its own financial forecast considers unsafe.

This requirement applies before later economy work is implemented.

---

# 26. Human Financial Protection Against Disposable-Team Abuse

The marketplace should also reject commitments that are clearly unsupported by the club's finances.

This prevents a disposable account from pledging all available money while ignoring upcoming unavoidable payroll.

Humans and AI use the same financial-validation backend.

The AI differs only because it chooses its own maximum bid automatically.

---

# 27. Existing Contract Is Preserved During Transfers

A permanent transfer does not recalculate salary.

The buyer inherits the player's current contract.

Do not invoke a new salary calculation merely because ownership changed.

Also preserve the previously agreed contract rule:

> Existing player salaries should not be automatically recalculated every season.

Salary changes should occur through the contract system, not an annual global recalculation.

This is important because AI financial forecasting requires committed wages to be stable and predictable.

---

# 28. AI Auction Buying — Position Need

AI clubs should first determine whether they actually need a player.

Calculate:

```ts
needScore(position)
```

Possible factors:

```text
No viable starter                  +50
Below required positional depth    +40
Starter well below desired level   +25
Weak backup                        +15
Ageing starter needing replacement +10
Already strong/deep                -40
```

Exact weights are configurable.

AI should not buy players simply because it has cash.

---

# 29. AI Auction Player Evaluation

For each relevant auction:

```text
Does this player solve one of my squad needs?
Would he improve my squad?
Can I afford his existing salary?
Is his current price below what I am willing to pay?
```

If the answer is no, ignore the listing.

---

# 30. AI Maximum Bid Formula

Base AI valuation on visible/legitimate information.

Conceptually:

```ts
calculatedMax =
    player.value
    * needMultiplier
    * upgradeMultiplier
    * deterministicValuationNoise;
```

Possible starting ranges:

```text
Need multiplier       0.90 – 1.25
Upgrade multiplier    0.90 – 1.15
Valuation noise       0.95 – 1.05
```

Then:

```ts
maxBid = Math.min(
    calculatedMax,
    auctionMaximum,
    safeMarketBudget
);
```

---

# 31. Do Not Double-Count Existing Value Factors

`player.value` already incorporates important player characteristics.

Do not massively apply the same factors again.

In particular:

* overall can affect whether a player improves the squad;
* age can affect squad-planning suitability;

but avoid strongly multiplying price again based on overall/age if `player.value` already incorporates them.

Otherwise AI valuations will exaggerate the underlying value formula.

---

# 32. Deterministic AI Valuation Noise

Small valuation variation prevents every AI from reaching identical conclusions.

Use deterministic seeded variation based on something such as:

```text
clubId
playerId
listingId
```

This ensures:

```text
same AI + same auction = same valuation
```

Reloading/restarting the server should not randomly change an AI's willingness to pay.

---

# 33. AI Submits Its Maximum Once

This is a strict fairness rule.

Once the AI decides to bid:

```ts
market.submitMaxBid(aiClubId, auctionId, calculatedMax);
```

It is done.

The AI must not:

* inspect another club's hidden maximum;
* react to an opponent's maximum;
* repeatedly increase its own calculated limit;
* snipe;
* receive special information;
* bypass the normal proxy engine.

The proxy-bid system handles competition automatically.

---

# 34. AI Auction Evaluation Timing

AI should evaluate each eligible auction at most once unless its prior bid submission failed before becoming valid.

Record something such as:

```text
AI_MARKET_EVALUATION
clubId
listingId
evaluatedAt
decision
```

This prevents repeated recalculation from effectively turning the AI into a reactive bidder.

The exact evaluation time can be distributed across the auction window to avoid every AI bidding at listing creation.

---

# 35. AI Selling — Remove Random Auction Generation

Delete the current behavior where auctions are spawned merely because:

```text
there are fewer than 3 auctions
```

Do not randomly select a non-star player.

The transfer supply must emerge from AI squad management.

---

# 36. AI Sell Score

Every AI club periodically evaluates its squad.

Conceptually:

```ts
sellScore =
    positionalSurplus
    + lowCurrentImportance
    + ageingWithReplacement
    + contractSituation
    + poorWageEfficiency
    + oversizedSquad
    + financialPressure
    + marketOpportunity
    - starterImportance
    - positionalDepthRisk;
```

Suggested starting ranges:

```text
Surplus at position               +0..30
Backup / rarely needed            +0..25
Older with adequate replacement   +0..15
Contract nearing expiry           +0..10
Poor salary/value efficiency      +0..10
Squad above desired size          +0..10
Financial pressure                +0..30
Good market opportunity           +0..10

Primary starter                   -30
Only adequate player at position  -40
Position already thin             -30
```

Exact weights require simulation and tuning.

---

# 37. No Hidden Development Potential in AI Decisions

AI transfer decisions must **not** inspect hidden development trajectory/potential.

Do not use:

* hidden growth curve;
* hidden decay date;
* hidden future overall;
* hidden potential rating.

Otherwise AI transfer behavior would leak information to human players.

Example of information leakage to avoid:

> The AI immediately sells one 19-year-old while protecting another because it secretly knows their future development.

AI should operate on information that could reasonably be inferred from visible/current player data.

---

# 38. No Star Flag in AI Decisions

Because the star-player concept is being removed, there must be no:

```ts
if (player.star) ...
```

inside the new sell/buy logic.

Squad importance comes from:

* current ability;
* position;
* depth;
* playing role;
* age;
* contract;
* salary;
* replacement options.

---

# 39. AI Selling Decision Is Binary

AI does not privately negotiate price.

The system already determines the minimum.

The AI asks:

```text
Would I accept the possibility that this player sells at the generated opening bid?
```

If yes:

```text
create public auction
```

If no:

```text
keep player
```

The marketplace decides the actual sale price.

---

# 40. Market Opportunity Can Encourage AI Supply

To keep the market liquid without fake/random listings, incorporate a small `marketOpportunityScore`.

Examples:

```text
Few players available at this position
Several clubs currently have this positional need
Seller has excessive depth at this position
```

This can make an otherwise borderline player more likely to be listed.

It should not override serious squad-depth problems.

---

# 41. Free Agents Remain a Separate Tab

Do not merge them into Auctions visually.

Free agents use competitive bidding infrastructure internally but remain a separate market and separate UI.

Conceptually:

```text
FREE AGENTS

Player
Value
Salary
Contract
Current signing bid
Your max
Bidders
Deadline
```

---

# 42. Free-Agent Signing Bids

When a player becomes a free agent, automatically create a Free Agent market listing.

Starting price should be a small fraction of `player.value`.

Initial configuration:

```text
FREE_AGENT_START_MULTIPLIER = 0.10
```

Example:

```text
Player value: $5.8M

Opening signing bid:
$580K
```

A range around 10–20% can be tested during balancing.

---

# 43. Free Agents Use Proxy Bidding

Free-agent bidding should reuse:

* private maximum bidding;
* scaled bid increments;
* tie-breaking;
* soft-close;
* financial reservations;
* irreversible maximum commitments.

But it remains presented as a **signing competition**, not a club transfer auction.

---

# 44. Free-Agent Money Leaves the Economy

There is no selling club.

The winning amount is paid to:

```text
SYSTEM
```

and removed from the economy.

Example:

```text
Winning signing bid: $1.4M

Club cash: -$1.4M
No club receives $1.4M
```

This provides a natural money sink.

---

# 45. AI Treats Free Agents as Real Market Opportunities

AI clubs must evaluate free agents using essentially the same squad-need logic as transfer auctions.

A valuable player starting at 10% of value should attract AI clubs that actually need him.

Do not leave free agents cheap simply because AI only searches the auction market.

AI considers:

* positional need;
* squad improvement;
* player value;
* salary;
* contract;
* safe financial capacity.

---

# 46. Free-Agent Contract Terms

Do not auction several contract dimensions simultaneously.

The free agent should arrive with generated contract demands such as:

```text
Salary:       $42K / season
Contract:     2 seasons
```

All bidders are bidding only on the signing amount.

Submitting a bid means accepting:

```text
winning signing fee
+
predefined salary
+
predefined contract duration
```

This keeps AI and human comparisons straightforward.

---

# 47. Prevent Free-Agent Arbitrage Without a Resale Ban

Do **not** solve the problem using:

```text
Cannot sell this player for X days
```

or:

```text
Cannot sell this player this season
```

for the initial free-agent signing.

Instead record the actual market transaction.

Add:

```ts
lastMarketPrice
lastMarketDate
lastMarketMatchday
lastAcquisitionType
lastAcquisitionClubId
```

For a free agent:

```text
Player value:        $5M
FA winning price:    $600K

lastMarketPrice = $600K
```

---

# 48. Recent Market Price Anchor

Normally:

```ts
normalAuctionFloor =
    player.value * AUCTION_FLOOR_MULTIPLIER;
```

But a recently acquired player should initially be anchored to what the market actually paid.

Conceptually:

```ts
maturity =
    clamp(
        matchdaysSinceAcquisition /
        RESALE_ANCHOR_MATURITY_MATCHDAYS,
        0,
        1
    );

auctionFloor =
    lerp(
        recentMarketAnchor,
        normalAuctionFloor,
        maturity
    );
```

Immediately after acquisition:

```text
maturity ≈ 0

floor ≈ recent actual market price
```

Later:

```text
maturity → 1

floor → normal 85% player.value
```

---

# 49. Example — Cheap Free Agent

Suppose:

```text
Value:                  $5.0M
FA signing price:       $600K
Normal auction floor:   $4.25M
```

If immediately listed:

```text
Opening auction bid ≈ $600K
```

not:

```text
$4.25M
```

Therefore signing the player cheaply does not automatically manufacture millions in guaranteed resale value.

---

# 50. Genuine Free-Agent Profit Is Allowed

There is no cap tied to the acquisition price.

If the player is immediately listed for approximately $600K and real market demand produces:

```text
$600K
$1.0M
$2.5M
$4.5M
```

then the seller can legitimately make a profit.

That represents actual market demand.

The goal is to eliminate **guaranteed mechanical arbitrage**, not legitimate speculation.

---

# 51. Use Matchdays for Resale Maturity

The recent-market anchor should mature according to game progression, not wall-clock time.

Use:

```text
matchdays since acquisition
```

rather than:

```text
real-world days
```

This keeps behavior consistent if season cadence changes.

Expose the maturity length as configuration:

```text
RESALE_ANCHOR_MATURITY_MATCHDAYS
```

Tune after economic simulations.

---

# 52. Apply Recent-Market History Generally

The transaction history system can also apply to normal auction acquisitions.

Example:

```text
Value:             $10M
Bought for:        $8.7M
Normal floor:      $8.5M
```

Immediate relisting would start around the actual recent market price.

The effect is small under normal circumstances but creates a consistent rule.

---

# 53. Club-to-Club Transfer Cooldown for Circular Abuse

Keep a hard anti-circular-transfer protection for completed **club-to-club transfers**.

A player who was purchased from another club should not be permanently transferred again during the same season.

Purpose:

```text
Club A → Club B → Club A
```

must not become a mechanism for repeatedly moving cash.

### Important exception

A player newly signed from the **free-agent system** is not blocked from being listed immediately.

That is where the recent-market-price anchor is used instead.

Once that player subsequently moves through a club-to-club auction, the normal club-transfer cooldown applies.

---

# 54. Unsold Free Agents

If a free agent receives no bids, automatically relist him.

Progressively reduce the system opening multiplier.

For example, configurable stages:

```text
10%
7.5%
5%
2.5%
nominal minimum
```

The purpose is to prevent weak free agents from remaining permanently stranded.

This does not create player-to-player abuse because the signing fee is paid to the system.

---

# 55. Loans Remain a Separate FCFS Market

Loans do **not** use auctions.

Loans have:

```text
Loan fee: $0
Allocation: first come, first served
```

Flow:

```text
Owner lists player
        ↓
Player appears publicly
        ↓
Exposure period
        ↓
Player becomes claimable
        ↓
First eligible claim wins
```

---

# 56. Loan Terms Should Be Standardized

Initial multiplayer loan rules:

```text
Loan fee:           $0
Duration:           until end of current season
Borrower wages:     100%
Purchase option:    none
Mandatory purchase: none
Recall:             none
```

Do not introduce negotiated:

* wage split;
* duration;
* future purchase fee;
* loan fee;
* purchase option.

These create unnecessary multi-account exploit surfaces.

---

# 57. Public Loan Exposure Period

Pure instant listing creates an obvious coordination exploit:

```text
Alt lists player
Main account already waiting
Main claims instantly
```

Instead:

```text
Player listed
→ immediately visible to everyone
→ not yet claimable
→ becomes claimable after public exposure
```

Example configurable starting value:

```text
LOAN_EXPOSURE_PERIOD = 30 minutes
```

UI:

```text
AVAILABLE FOR LOAN

Becomes claimable in:
18m 24s
```

Once exposure begins, the lender should not be able to cancel the listing.

This prevents timing a listing privately for another account.

---

# 58. Loan Claim Must Be True Server-Side FCFS

Once claimable:

```text
first valid server-side claim wins
```

Use an atomic database operation.

Conceptually:

```sql
UPDATE loan_listing
SET borrower_club_id = ?
WHERE id = ?
  AND status = 'AVAILABLE';
```

Only one transaction may succeed.

Do not choose the borrower client-side.

Do not let the seller approve the claimant.

---

# 59. Loan Eligibility

Before completing a claim, validate:

* borrower is not the owner;
* player is still available;
* borrower can afford the player's salary;
* player is not already loaned;
* borrower is otherwise eligible under normal squad rules;
* player movement does not violate current contract/status restrictions.

Any future limits on loans in/out should be introduced only if gameplay data shows they are necessary rather than adding arbitrary hard limits immediately.

---

# 60. AI Must Not Have Server-Priority on FCFS Loans

An AI running directly on the server must not automatically claim the player at the exact first claimable millisecond.

That would give AI an unfair infrastructure advantage.

AI loan claims should:

1. evaluate the listing;
2. decide whether it wants the player;
3. schedule a normal claim attempt after a small configured reaction delay;
4. invoke the exact same `claimLoan()` service humans use.

No special reservation or priority.

---

# 61. AI Loan-In Decision

AI should claim only when:

```text
player fills a real squad need
player improves useful depth
salary is affordable
loan does not make squad construction worse
```

No hidden development data.

---

# 62. AI Loan-Out Decision

Loan-out logic should evaluate players who:

```text
are not sufficiently needed this season
but are not desirable permanent-sale candidates
```

Factors may include:

* squad depth;
* current ability;
* age;
* current playing importance;
* salary;
* available cover.

Do not inspect hidden development potential to decide whether a player is worth keeping long-term.

---

# 63. No Loan Purchase Options Initially

Do not implement:

* loan-to-buy;
* optional purchase;
* mandatory purchase;
* pre-agreed future transfer prices.

They create private value transfers that bypass the auction system.

They can be reconsidered later only if they can be routed through the public marketplace safely.

---

# 64. List for Sale Tab

Keep the existing tab.

Replace custom sale-price behavior with public auction creation.

For each eligible squad player show:

```text
PLAYER
Value: $5.8M

Generated opening bid:
$4.93M

[ List for Auction ]
```

If recent-market anchoring applies:

```text
Value: $5.8M
Recent market price: $1.2M
Generated opening bid: $1.4M

[ List for Auction ]
```

The seller cannot enter an arbitrary price.

---

# 65. Auction UI

Example:

```text
Charlie Smith
GK · 25 · OVR 47

Value: $5.8M

Current bid: $5.1M
Your max bid: $6.2M
Bidders: 4
Ends in: 04:31:22

YOU ARE LEADING

[ Increase Maximum Bid ]
```

If not yet bidding:

```text
Maximum bid:
[________]

[ Place Bid ]
```

Never display competing maximums.

---

# 66. Free-Agent UI

Example:

```text
Charlie Smith
GK · 25 · OVR 47

Value: $5.8M
Salary: $42K / season
Contract: 2 seasons

Current signing bid: $850K
Your max: $1.2M
Bidders: 3
Ends in: 08:14:02

[ Place / Increase Maximum ]
```

Make it clear that:

```text
Signing fee is paid to the system.
```

---

# 67. Loan UI

Before availability:

```text
Charlie Smith
GK · 25 · OVR 47

Value: $5.8M
Salary: $42K / season

Loan until end of season
Loan fee: $0
Borrower pays 100% salary

Claimable in:
18:21
```

After availability:

```text
[ Claim Loan ]
```

---

# 68. Data Model — Transfer Auction

Conceptually add/ensure:

```ts
TransferAuction {
    id
    playerId
    sellerClubId

    playerValueAtListing
    openingPrice
    maximumAllowedBid
    bidIncrement

    currentPrice
    leadingClubId

    createdAt
    deadline
    originalDeadline

    status
    completedAt
    winningClubId
    finalPrice
}
```

Do not rely on recalculating historical auction values from a player's current value later.

Store the relevant snapshot.

---

# 69. Data Model — Market Bid

Store:

```ts
MarketBid {
    id
    marketType
    listingId
    clubId

    maxBid

    createdAt
    updatedAt
}
```

One effective maximum per club/listing.

Increasing the maximum updates the commitment while preserving the initial tie-priority semantics as appropriate.

Do not expose `maxBid` publicly.

---

# 70. Data Model — Free-Agent Listing

Conceptually:

```ts
FreeAgentListing {
    id
    playerId

    playerValueAtListing
    openingPrice
    bidIncrement

    currentPrice
    leadingClubId

    relistStage

    createdAt
    deadline

    status
    completedAt
    winningClubId
    finalPrice
}
```

No `sellerClubId`.

---

# 71. Data Model — Loan Listing

Conceptually:

```ts
LoanListing {
    id
    playerId
    lenderClubId

    listedAt
    claimableAt

    status

    borrowerClubId
    claimedAt

    loanEndSeason
}
```

No transfer/loan fee field is required unless retained explicitly as zero for compatibility.

---

# 72. Player Market History

Add market-history fields or preferably a dedicated transaction table.

Recommended transaction record:

```ts
PlayerMarketTransaction {
    id
    playerId

    type:
        TRANSFER
        FREE_AGENT_SIGNING
        LOAN

    fromClubId?
    toClubId?

    price

    season
    matchday
    timestamp
}
```

This becomes the source for:

```text
lastMarketPrice
last acquisition type
last acquisition matchday
transfer cooldown
recent-price anchor
```

A dedicated history table is preferable to packing all historical data into `Player`.

---

# 73. Financial Reservation Data

Track active commitments durably.

Conceptually:

```ts
MarketReservation {
    clubId
    listingId
    marketType

    amount
    createdAt
}
```

Reservations must survive:

* server restart;
* process crash;
* background worker restart.

Do not keep them only in memory.

---

# 74. API / Backend Endpoints

Recommended conceptual API:

### Auctions

```text
GET  /transfers/auctions
POST /transfers/auctions
POST /transfers/auctions/:id/bid
POST /transfers/auctions/:id/cancel
```

### Free agents

```text
GET  /transfers/free-agents
POST /transfers/free-agents/:id/bid
```

### Loans

```text
GET  /transfers/loans
POST /transfers/loans
POST /transfers/loans/:id/claim
```

Exact route naming may follow the current project conventions.

All frontend and AI actions must ultimately call the same domain services.

---

# 75. Restrict Direct Use of `transferPlayer`

`transferPlayer` should no longer be an easy generic path that AI or API handlers can invoke to bypass the market.

Make player movement happen only through approved workflows:

```text
TransferAuctionService.completeTransfer()
FreeAgentMarketService.signPlayer()
LoanMarketService.completeLoan()
```

plus legitimate non-market lifecycle operations such as generated/youth players.

This is important for preserving multiplayer integrity as future code is added.

---

# 76. Concurrency Requirements

Multiplayer bidding requires real transactional locking.

Protect against:

```text
two simultaneous bids
two simultaneous auction resolutions
bid arriving while auction resolves
two simultaneous loan claims
two workers resolving same listing
```

Use database transactions/row locking or equivalent atomic mechanisms.

Never resolve based purely on stale application-memory state.

---

# 77. Background Processing

The current matchday/daily processing is insufficient for minute-based auction deadlines.

Add real-time market processing.

For example:

```text
Market deadline resolver:
every 30–60 seconds
```

Responsibilities:

```text
resolve expired auctions
resolve expired free-agent listings
activate loan listings whose exposure period ended
release stale reservations
trigger/reconcile AI market actions
```

Also resolve lazily when a user requests a listing whose deadline has already passed, so a delayed worker cannot leave an expired auction active indefinitely.

---

# 78. AI Scheduling

Replace current jobs such as:

```text
aiBidDuringWindow
aiBuyListings
spawnAuction
findBuyer
```

with:

```text
evaluateAISquadMarketState
evaluateAITransferListings
evaluateAIFreeAgents
evaluateAILoanListings
```

AI sell/loan squad evaluation can remain tied to game progression.

Real-time bid/listing resolution must not depend on a matchday happening.

---

# 79. Multi-Account Abuse — Structural Protections

The system should assume multiple accounts cannot always be detected.

Therefore protect the economy through market rules.

### Protection 1 — no buyer selection

Seller cannot choose the destination club.

### Protection 2 — public market

Every permanent transfer is public.

### Protection 3 — system-generated floor

Seller cannot give away a $10M player for $1.

### Protection 4 — transfer maximum

A disposable club cannot pay $100M for a $1M player.

### Protection 5 — proxy clearing price

A single account entering an absurd maximum does not automatically transfer that full amount.

### Protection 6 — maximum funds reserved

Disposable clubs cannot make unsupported simultaneous commitments.

### Protection 7 — financial capacity validation

Clubs cannot simply ignore unavoidable payroll commitments.

### Protection 8 — hidden bidders

Coordination is less convenient.

### Protection 9 — irreversible bids

Shill bids carry real risk.

### Protection 10 — club-to-club transfer cooldown

The same player cannot be ping-ponged repeatedly to move money.

### Protection 11 — free-agent recent-price anchor

Cheap system acquisition does not automatically create a high resale floor.

### Protection 12 — public loan exposure

A lender cannot privately time an FCFS listing for a second account.

---

# 80. Audit Data

Even though the primary protection is structural, preserve enough history to detect later abuse.

Log:

* listing creation;
* all max-bid changes;
* bidder;
* timestamp;
* final clearing price;
* seller;
* buyer;
* market price/value ratio;
* transfer history;
* repeated club-pair transactions;
* loan claims.

This data can later support anti-cheat detection without redesigning the market.

Do not make IP/device detection a core economic requirement.

---

# 81. Board Confidence Removal

Remove board confidence entirely.

Search all references rather than editing only the known lines.

Known current behavior to eliminate includes:

### `settlePayroll` — `season.ts`

Remove:

```text
board confidence -10 while negative
```

Remove:

```text
overdraft penalty triggered by low board confidence
```

There should be no recurring 2% negative-balance penalty.

### Season warnings

Remove:

```text
"watch the transfer budget"
```

warnings driven by board-confidence thresholds.

### Season reset

Remove:

```text
boardConfidence = 50
```

from season initialization/reset.

### Models/API/UI

Remove:

* field;
* serialization;
* UI displays;
* news rules;
* persistence/migrations;
* tests.

---

# 82. Remove Manager Sacking

Coaches/managers cannot be sacked under the new multiplayer model.

Remove the current AI-only `"financial ruin"` firing path.

If `maybeFireManager()` exists only to fire AI managers, remove it entirely.

Otherwise remove all firing behavior while preserving unrelated manager logic.

Financial problems belong to the club, not the coach.

---

# 83. Do Not Implement the Rejected Financial Mechanics

Do **not** add:

* emergency financing;
* emergency loans;
* automatic overdraft loans;
* points deductions;
* financial relegation;
* bankruptcy game-over;
* manager firing;
* board confidence.

The broader insolvency/recovery system will be designed after the transfer economy is stable.

---

# 84. Interim Negative-Cash Behavior

Payroll can currently make `club.cash` negative.

Until the later economy overhaul:

* remove the board-confidence consequences;
* remove the overdraft penalty;
* preserve income flows;
* prevent AI from creating new unsafe commitments;
* do not invent a temporary emergency-financing mechanic.

Existing clubs that are already financially unsustainable may still require the later economy phase to recover properly.

---

# 85. Market Configuration

Centralize all balance parameters.

Example:

```ts
marketConfig = {
    transferAuction: {
        durationHours: 24,
        floorMultiplier: 0.85,
        maxMultiplier: 1.50,
        bidIncrementRate: 0.01,
        softCloseMinutes: 5,
        extensionMinutes: 5,
    },

    freeAgents: {
        startMultiplier: 0.10,
        durationHours: 24,
        relistMultipliers: [0.10, 0.075, 0.05, 0.025],
    },

    resaleAnchor: {
        maturityMatchdays: /* tuned value */,
    },

    loans: {
        exposureMinutes: 30,
        borrowerWageShare: 1.0,
    },
};
```

No important market multiplier should be duplicated throughout business logic.

---

# 86. Migration of Existing Listings

When deploying the overhaul:

1. stop creating old-format auctions;
2. migrate or cancel existing active auctions;
3. remove fixed-price listings;
4. remove AI direct-sale listings;
5. convert current free agents into new free-agent listings;
6. migrate existing loans if compatible;
7. clear obsolete temporary bid state;
8. reconstruct valid financial reservations;
9. ensure no old endpoint can still invoke direct transfers.

For an early-development game, cancelling/rebuilding active listings may be safer than trying to preserve incompatible semantics.

---

# 87. Migration of Existing Players

For historical players without market history:

```text
lastMarketPrice = null
```

Therefore use:

```text
normal value-based auction floor
```

until their first transaction under the new system.

Do not fabricate old transaction prices.

---

# 88. Migration of Star/Reputation Fields

If safe:

* remove obsolete schema columns.

If immediate schema deletion risks compatibility:

1. stop reading the fields;
2. migrate all logic away;
3. remove UI/API exposure;
4. remove fields in a later schema migration.

There must be no active game logic depending on them after this overhaul.

---

# 89. Unit Tests — Proxy Bidding

Cover at least:

```text
no bidders
one bidder
two bidders
three bidders
equal max bids
leader increases own maximum
challenger below leader maximum
challenger above leader maximum
bid exactly at auction cap
bid above auction cap
bid below required amount
bid after deadline
seller tries to bid
bid withdrawal attempt
bid decrease attempt
```

---

# 90. Unit Tests — Soft Close

Verify:

```text
bid outside window → no extension
competitive bid inside window → extension
leader raises hidden max only → no extension
proxy price movement alone → no second extension
multiple late competitive bids → repeated extension
```

---

# 91. Unit Tests — Financial Reservations

Verify:

```text
winning max creates reservation
outbid club releases reservation
increasing max increases reservation
settlement consumes final price
unused maximum is released
multiple auctions sum correctly
server restart preserves reservations
insufficient safe budget rejects bid
```

---

# 92. Unit Tests — AI Fairness

Verify AI:

* cannot read competing private maximums;
* submits at most one calculated maximum per listing;
* obeys normal auction cap;
* obeys financial capacity;
* cannot use hidden potential;
* cannot use removed star state;
* cannot use club reputation;
* cannot directly transfer players;
* uses the same bid service as humans.

---

# 93. Unit Tests — AI Selling

Construct squads where:

```text
position has excessive depth
position has minimal depth
player is important starter
player is unused backup
player has expensive salary
club is under financial pressure
```

Verify sell score behaves sensibly.

Most importantly:

```text
AI must never sell its only viable player at a position merely because the market needs listings.
```

---

# 94. Unit Tests — Free Agents

Verify:

```text
FA automatically appears on market
opening price uses configured fraction
proxy bidding works
payment goes to system
existing contract terms are applied
AI can compete
unsold FA relists correctly
```

---

# 95. Unit Tests — Free-Agent Resale Anchor

Example test:

```text
Value = $5M
FA acquired = $500K
Normal floor = $4.25M
```

Immediately:

```text
resale floor ≈ $500K
```

Midway through maturity:

```text
resale floor between $500K and $4.25M
```

After maturity:

```text
resale floor ≈ $4.25M
```

Also verify legitimate competitive bidding can raise the actual sale far above the opening price.

---

# 96. Unit Tests — Transfer Cooldown

Verify:

```text
free-agent signing
→ immediate resale allowed

club-to-club auction purchase
→ same-season permanent resale rejected
```

Also verify the restriction expires at the intended season boundary.

---

# 97. Unit Tests — Loans

Verify:

```text
loan has zero fee
listing enters exposure state
claim before claimableAt rejected
claim after claimableAt succeeds
simultaneous claims produce exactly one winner
seller cannot choose borrower
borrower takes 100% salary
loan expires at end of season
no purchase option exists
no recall exists
```

---

# 98. Integration Tests — Multi-Account Abuse

Explicitly model adversarial scenarios.

### Cheap superstar transfer

```text
$10M player
seller tries to transfer for $1
```

Expected:

```text
impossible
```

### Excessive money transfer

```text
$1M player
alt tries $50M bid
```

Expected:

```text
rejected by market maximum
```

### Single alt huge maximum

```text
opening $850K
alt max $1.5M
no other bids
```

Expected:

```text
clears near opening price, not $1.5M
```

### Circular transfer

```text
Main → Alt → Main
```

Expected:

```text
second club-to-club transfer blocked by cooldown
```

### Cheap free-agent flip

```text
FA value $5M
signed $500K
immediately listed
```

Expected:

```text
auction opening remains near recent market price,
not automatically $4.25M
```

### Coordinated loan

```text
Alt lists player
Main attempts immediate claim
```

Expected:

```text
cannot claim during public exposure period
```

---

# 99. Economy Simulation Before Production

Run automated multi-season simulations involving many AI clubs.

Track:

```text
number of listings
percentage of auctions sold
average sale/value ratio
median sale/value ratio
percentage hitting 150% cap
free-agent signing/value ratio
number of free agents receiving no bids
loan listing/claim rate
AI squad positional balance
AI cash levels
AI payroll burden
frequency of AI financial distress
market concentration
```

Particular warning signs:

```text
Most auctions end at opening price
→ too much supply / too little demand

Most auctions hit 150%
→ cap too low or values too low

Very few AI listings
→ sell thresholds too strict

AI constantly replaces players
→ need scoring too aggressive

Free agents always sell at 10%
→ AI not evaluating them properly

Free agents constantly hit transfer-like prices
→ maybe expected and healthy, inspect demand

Loans always claimed instantly
→ supply too low or AI claims too aggressive
```

---

# 100. Recommended Implementation Order

## Phase 1 — Cleanup

* Remove board confidence.
* Remove financial manager sacking.
* Remove overdraft penalties.
* Remove club-reputation transfer gating.
* Remove star-player transfer behavior.
* Remove star factors from `player.value`.
* Ensure existing salaries are not automatically recalculated as part of transfers.

## Phase 2 — Core Market Infrastructure

Implement:

* transaction history;
* market reservations;
* shared financial validation;
* ProxyBidEngine;
* atomic market operations.

## Phase 3 — Contracted Player Auctions

Implement:

* system-generated opening price;
* player-to-player maximum;
* private max bids;
* proxy price;
* soft close;
* irreversible bids;
* hidden bidder identity;
* settlement;
* cooldown.

Remove old fixed/direct transfer paths.

## Phase 4 — Human UI

Update:

* Auctions;
* List for Sale;
* bid modal;
* max-bid state;
* countdown;
* leading/outbid state.

## Phase 5 — AI Selling

Implement:

* squad evaluation;
* sell score;
* market opportunity;
* financial pressure;
* public auction creation.

Remove random auction spawning.

## Phase 6 — AI Buying

Implement:

* position needs;
* player evaluation;
* maximum calculation;
* deterministic noise;
* one-time maximum submission;
* financial guardrails.

## Phase 7 — Free Agents

Implement:

* separate free-agent listings;
* low starting bid;
* proxy bidding;
* system payment;
* predefined contracts;
* AI participation;
* relisting.

## Phase 8 — Recent-Market Resale Anchoring

Implement:

* transaction price storage;
* matchday maturity;
* blended auction floor;
* free-agent immediate resale behavior.

## Phase 9 — Loans

Implement:

* separate Loans tab logic;
* zero-fee listings;
* public exposure;
* atomic FCFS claim;
* full wage assumption;
* season-end return;
* AI loan-in/out logic.

## Phase 10 — Remove Remaining Legacy Code

Delete/deprecate:

```text
evaluateBid
counterOffer
findBuyer
aiBuyListings
random spawnAuction
fixed salePrice purchases
AI-only bid eligibility
old free-agent signing path
direct transfer endpoints
```

## Phase 11 — Simulation and Balancing

Tune:

```text
85% auction floor
150% auction cap
1% bid increment
10% FA opening
auction duration
soft-close duration
recent-price maturity
AI scoring weights
loan exposure period
```

Do not treat these initial values as permanently fixed game rules.

---

# 101. Final Invariants

After implementation, the engine should guarantee:

```text
1. A contracted player cannot permanently move directly between clubs.

2. Every permanent club-to-club move goes through a public auction.

3. Seller cannot choose buyer.

4. Seller cannot choose an arbitrary transfer price.

5. Human and AI clubs use the same bid execution system.

6. AI never sees hidden maximum bids.

7. AI submits one maximum and walks away.

8. AI does not use hidden development potential.

9. Star-player logic no longer exists.

10. Club reputation does not influence transfers.

11. Free agents have their own competitive signing market.

12. Free-agent signing money goes to the system.

13. Cheap free-agent acquisitions do not immediately receive a full-value resale floor.

14. Free agents may still be resold immediately.

15. Genuine market-driven resale profit remains possible.

16. Loans remain separate from auctions.

17. Loans have no transfer/loan fee.

18. Loans are first come, first served after public exposure.

19. Borrower pays the full salary during the loan.

20. Loan seller cannot select borrower.

21. No private loan-to-buy arrangement exists.

22. Market commitments reserve money.

23. AI cannot knowingly make a transfer decision that makes the club insolvent.

24. Board confidence no longer exists.

25. Financial manager sacking no longer exists.

26. No emergency financing is added.

27. No financial points penalty is added.

28. No financial relegation is added.

29. No bankruptcy/game-over mechanic is added in this phase.

30. The new market becomes the foundation for the later full club-economy overhaul.
```

# Footmania — Business Rules

This document explains how Footmania actually works: every rule, formula, and
mechanic that governs clubs, players, matches, money, and competitions. It describes
the game as it behaves today. Where an earlier design intention turned out
differently once built, this document describes what actually happens, and the
meaningful gaps are collected in [§14](#14-known-gaps--partially-built-features).

Numbers quoted throughout (percentages, multipliers, day counts, thresholds) are the
values currently in use. Anything called out as "tunable" can be adjusted by the
game's designers at any time without changing how the rule itself works — so treat
the *shape* of a rule as durable and the exact number as a snapshot.

## Contents

1. World & Competitive Structure
2. Clubs
3. Players
4. Match Simulation
5. Energy & Injuries
6. Transfer Market
7. Club Finance & Economy
8. Season Calendar & Lifecycle
9. Standings, Promotion, Relegation & Club Ratings
10. Multiplayer Lifecycle
11. Tactics Automation
12. Live Matches & Notifications
13. Admin, Analytics & Pro Features
14. Known Gaps & Partially-Built Features

---

## 1. World & Competitive Structure

Footmania takes place in one single, shared, always-running world. Every human-owned
club and every AI-controlled club competes inside the same pyramid of divisions —
there's no separate solo or offline mode.

### 1.1 The tier/division pyramid

- Every division holds exactly **8 clubs**.
- Divisions are organized into tiers shaped like a pyramid that doubles in width every
  level down: tier 1 has exactly one division (8 clubs total); tier 2 has two
  divisions (16 clubs); tier 3 has four (32 clubs); tier 4 has eight (64 clubs); and
  so on.
- Divisions are named by tier and, below tier 1, a group number — e.g. "1", "2.1",
  "2.2", "3.1", "3.2"…
- A tier is never allowed to hold more human clubs than its divisions can fit at 8 per
  division — the game won't let the human population outgrow the pyramid's shape at
  that depth.
- Whenever a division has fewer than 8 clubs, it's topped up with freshly generated AI
  clubs so it's always full. AI clubs only ever fill leftover slots — human clubs are
  always placed first.
- The world begins as a single, all-AI Division 1, before any human has joined.

### 1.2 Season calendar

A season is built entirely from a small set of settings: how many divisions and
rounds there are, how much rest sits between matches, and how long the off-season
lasts. With today's settings, that works out to:

- 14 league rounds per season (a double round-robin against every other club in the division).
- 2 days between each round.
- A 35-day season: 28 days of active league play followed by a 7-day close season.

Within that close season, the first 2 days are a short buffer right after the last
round before end-of-season processing begins, and the remaining 5 days are the actual
off-season window, during which promotion/relegation, division rebuilding, budgets,
retirements, academy intake, and next season's fixtures are all worked out (§8).

### 1.3 Fixture scheduling

Which day a fixture falls on is fixed purely by the round-robin schedule; the kickoff
*time* within that day is decided separately and later.

- **Which day**: clubs are randomly (but reproducibly) shuffled once at the start of
  the season, then paired off round by round in a standard round-robin rotation,
  followed by a mirrored second half of the season with home and away reversed for
  every pairing.
- **Home/away balance**: the game chooses which leg of each pairing is played first
  specifically to avoid long runs of consecutive home or away matches for any one
  club, and to keep each club's overall home/away split as even as possible.
- **Kickoff time**: each human club can set a preferred 8-hour daily window (in
  half-hour increments) for when it likes to play. For every fixture, the game picks
  the kickoff time that best serves both clubs' stated preferences, with ties broken
  in a fixed, reproducible way so nobody can game the system by resubmitting. Clubs
  with no stated preference simply go wherever best serves the other clubs'
  preferences.
- **Final round**: the very last round of a division's season is scheduled so that
  every match in it kicks off at the same time — mirroring how real leagues often
  synchronize the final day.
- Once a fixture's kickoff time is set, it never changes — even for a club that joins
  partway through the season.

---

## 2. Clubs

### 2.1 New human clubs

A brand-new human club starts with no history: it's provisionally placed at the
bottom of the pyramid until real placement happens, is funded solely by its starting
season budget (§7.1 — its starting cash is otherwise zero), and its opening squad is
generated at bottom-division quality. Its default kit colors are red and white unless
the owner chooses their own; a coach name is auto-generated unless the owner supplies one.

### 2.2 AI-controlled clubs

AI clubs exist purely to fill out divisions and last exactly one season each — they're
regenerated from scratch every season, never carried forward.

- **Name**: a city name plus "FC" (drawn from a fixed list of 32 well-known cities
  worldwide), with a matching stadium name.
- **Country**: chosen at random from a curated list of about 50 well-known footballing nations.
- **Kit and tactics**: generated automatically (§2.3 for kits). Its tactical setup —
  formation, playing style, pressing intensity, and attacking direction — is drawn
  from its own weighted odds: for example, a fairly defensive "4-5-1" formation is the
  single likeliest outcome (roughly a 1-in-3 chance), a balanced playing style is far
  more common than an aggressive or counter-attacking one, and light pressing is more
  common than heavy pressing.
- **Finances**: permanently zero — an AI club never spends, earns, or holds money
  (§10.3).
- **Squad**: a full 35-player senior squad, generated the exact same way a human
  club's squad is, but with no youth academy at all.

### 2.3 Club identity: names, kits, crests, squad numbers

**Player and coach names** are drawn from country-specific first-name and surname
pools; a generic fallback pool is used for any country without its own data. Whether a
surname gets appended to a first name follows a simple rule of thumb: single first
names almost always get a surname added, two-word names get one about half the time,
and longer names never do — and only if the combined result stays a reasonable length.

**Nicknames** can be 1 to 24 characters, letters/numbers/spaces/apostrophes/hyphens
only, and are rejected if they contain — anywhere, not just as an exact match — a
small list of blocked words (a few profanities plus "admin"/"moderator"). Setting a
nickname is a Pro-only benefit (§13.2); clearing one back to nothing is free for everyone.

**Kits** consist of a primary color, secondary color, accent color, shirt-number
color, and a visual pattern (over 40 pattern choices exist), separately for home,
away, and goalkeeper kits.

AI clubs get their kit generated automatically and consistently (the same club always
looks the same):
1. Two distinct colors are drawn from a fixed 12-color palette.
2. A pattern is drawn from a smaller, visually calm subset of six patterns (solid,
   stripes, broad stripes, hoops, halves, sash).
3. A coin flip decides which of the two colors becomes the lighter kit and which
   becomes the darker one, each nudged lighter or darker as needed until it's clearly
   light or clearly dark.
4. The goalkeeper kit uses the same color family as the home kit but with inverted,
   clamped brightness and boosted saturation so it's always visually distinct, always
   in a hooped pattern.

Human clubs that haven't designed their own kit get a simpler fallback: home kit
striped in the club's own colors, away kit a lightened or darkened variant depending
on how bright the home color already is, goalkeeper kit following the same
brightness-inversion rule as AI clubs.

**Match-day kit selection** is automatic and contrast-aware, applied identically to
the live match view and the fixture-list badges:
1. The home team wears its home kit; the away team wears whichever of its two designs
   contrasts best against the home shell (shells compared by perceptual luminance
   distance, minimum 90 of 255 to count as decent contrast, light-vs-dark pairings
   preferred on ties).
2. If no away design reaches that minimum against the home kit, the home team
   switches to its away kit and both away designs are retried the same way.
3. If nothing qualifies even then, the classic pairing is used: home team home kit,
   away team away kit.

Each side's goalkeeper always wears that side's goalkeeper design, regardless of the
outfield pairing. Selection is a pure deterministic function of the two clubs'
designs — it never rerolls and is recomputed from current designs whenever the view
is built.

**Crests**: there's no automatic crest generation — only the ability to upload a
custom image (PNG, JPEG, or WEBP, under 256KB). A size limit on the uploaded image's
dimensions is currently enforced only by the app the club owner is using to upload it,
not by the game itself — so a technically savvy user could in theory bypass that
particular limit today.

**Squad numbers** run 1 to 99. A club's best goalkeeper (by ability) is always given
#1; its second-best goalkeeper is always given #12; everyone else gets a random unused
number, preferring numbers 2 through 40 before falling back to any other free number.
Manually changing a player's number always succeeds — if the chosen number already
belongs to a teammate, the two players simply swap numbers rather than the change
being blocked.

### 2.4 Countries & nationality

Every club has a home country drawn from a large built-in list of real countries; AI
clubs are assigned one at random from roughly 50 well-known footballing nations, with
each equally likely regardless of how strong that country's football reputation is
meant to be. Every player generated for a club currently shares that club's single
country — there's no mechanism yet for a club's roster to include a mix of
nationalities on its own.

---

## 3. Players

### 3.1 Attributes & overall rating

Every player has seven underlying skills, each rated 1 to 100: goalkeeping, pace,
technique, passing, defending, aerial ability, and finishing. Players are generated
for one of five roles: goalkeeper, full-back, center-back, midfielder, or forward.

A player's single "overall" rating is a weighted average of their seven skills, with
the weighting different for each role — a goalkeeper's overall is dominated by
goalkeeping ability (about 80% of the weight), a forward's by finishing (about 46%),
and so on — then scaled back up onto the familiar 1–100 range, since a player's skills
outside their main role sit at a low baseline that would otherwise drag the raw
average down.

A separate, more detailed rating is used behind the scenes to judge how well a player
fits a *specific* tactical slot on the pitch (e.g. a center-back asked to play
right-back) — this is distinct from their general overall rating and factors in
exactly how suited their natural position is to the role they've been asked to play.

When a club sets a training focus for a player, the game slightly emphasizes one
extra skill during development: their single most important skill for their role,
their second-most-important skill, or — if the focus is meant to shore up a weakness —
whichever relevant skill they're currently weakest in.

### 3.2 How new players are generated

Every new player, whether joining a human club, an AI club, replacing someone, or
arriving through the youth academy, is generated through the same underlying process.

The key idea is that a player is generated **as a point on a career**, not as a
standalone ability score. Before working out how good he is *today*, the game draws
the whole shape of his career, then asks where his generated age puts him on it. That
is why a generated 18-year-old and a generated 28-year-old of the same underlying
quality look nothing alike: the teenager is early on his curve with most of his
improvement still ahead of him, while the 28-year-old is at or just past his best.

- **Division quality**: divisions form a quality gradient from the very best
  (Division 1) to the weakest, with the average ability level declining smoothly as
  you go down the pyramid, and with some deliberate spread of talent within any one
  division.
- **Career profile first**: every player is given a hidden career shape — how much
  total improvement he has in him, how front-loaded that improvement is, the exact age
  he peaks at, how much decline he suffers afterwards, and how quickly that decline
  arrives. All of it is invisible and permanent. Crucially, "how much" and "how fast"
  are separate: a fast developer reaches his ceiling earlier, but he does not reach a
  *higher* ceiling than a slow developer with the same potential.
- **The career peak is what gets anchored on the division**, not current ability. A
  senior generated in a division is heading for a peak somewhat above that division's
  all-round average, because a real squad is a mix of players still improving, players
  at their best, and players on the way down — and that mix averages back down to the
  division's figure.
- **Youth players** are anchored on their club's **academy pedigree** — a blend of the
  club's current division and the strongest division it has *ever* reached (a
  permanent ratchet: once a club has been in Division 1, that stays in its academy's
  favour forever). Pedigree lifts the *career peak* a prospect is heading for, never
  his ability on the day he arrives. A strong academy therefore produces better
  **prospects**, not ready-made first-team stars.
- **Academy recruits are always 16 to 19 years old.** No intake path ever produces a
  20-year-old academy player, because everyone is promoted by then (§3.7).
- **Senior ages** are drawn from a survivorship curve: the realistic chance that a
  player who entered the senior population at the promotion age is *still in the game*
  at each later age, accounting for both retirement and players who quietly drop out
  of the game after going unsigned. The same curve is reused for academy intake
  planning and for the admin analytics view, so those three can never disagree.
- A player's actual seven skills are then shaped, through a short trial-and-improve
  process, to land as close as possible to his intended overall rating for his role.
  His overall is always recomputed *from* those skills — the game never writes an
  overall rating directly.
- There's a small (5%) chance a new player is given a different nationality than the
  club generating him, drawn from anywhere else in the world, so rosters aren't
  entirely homogeneous.
- New rosters follow a standard positional mix: roughly 10% goalkeepers, 14%
  full-backs, 18% center-backs, 32% midfielders, 26% forwards.
- Generation is fully reproducible: regenerating "the same" player (say, after an
  interruption mid-process) always produces the exact same result rather than a new
  random roll.

Adjacent divisions overlap substantially by design — an exceptional lower-division
player really can be useful several tiers up. There is deliberately **no** notion of a
player "belonging" to a division: the game never labels a player with a division,
recommends one, refuses a contract because of one, or lists a human club's player for
it. Managers judge players on what they can see.

### 3.3 Growing older: development, growth, and decline

A player's whole career is described by five hidden numbers, fixed once at generation
and never changed:

- how much **total improvement** he has available;
- how **front-loaded** that improvement is;
- the exact **age he peaks** at;
- how much **total decline** he suffers afterwards;
- how **quickly** that decline arrives.

Improvement and decline each work as a *budget*. Potential sets the size of the
budget; speed only changes when it gets spent. A fast developer and a slow developer
with the same potential end up in the same place — the fast one just gets there
sooner. There is deliberately no second ceiling, no growth tier, and no separate
development-rate multiplier anywhere in the system: any of those would let the same
improvement be granted twice.

Peak age is personal, drawn from a bell curve centered in the late twenties with real
tails in both directions. Before it, a player spends from his improvement budget;
from that age onward he spends from his decline budget instead. **Improvement not
realized before his peak is simply lost** — it is never banked for later.

How much of the budget a player actually realizes depends on how much he plays, based
on his minutes over his last five matches (weighted toward the most recent). Regular
starters realize more of their improvement; bench players realize less. Veterans who
keep playing decline more slowly than veterans who don't. Note the direction of that
effect carefully: sitting on the bench makes a young player realize **less** of his
potential — it never moves him closer to his peak.

Whatever a player is due in a given period is expressed as an amount of *overall
rating*, then converted into actual skill progress before anything changes. That
conversion accounts for how much each skill is worth to his role, so an identical
budget produces comparable overall movement whichever position a player plays — a
midfielder and a goalkeeper improve at the same rate for the same budget, even though
their overall ratings weigh completely different skills.

The progress is spread across his seven skills in proportion to how important each is
to his role, with extra weight on whichever skill his club's training focus targets.
If a skill is already pinned at its maximum, its share is **redistributed** across the
skills that can still move — otherwise a training focus aimed at an already-maxed
skill would quietly waste most of a player's development. Running out of *career
budget* is a different matter entirely: there, progress simply stops, because there is
no capacity left to spend anywhere.

Progress accumulates fractionally and only turns into a whole skill point when it
crosses the threshold, and the player's overall rating is always recomputed from his
skills afterwards.

**Long-term injuries** can permanently take some of this away: part of the ability
lost to a serious injury is burned out of the player's remaining improvement budget,
so his career curve never simply regrows the whole loss.

**Retirement**: below age 33, a player never retires. From 33 onward, each season
carries a rising chance of retirement that climbs steeply with age — modest in the
mid-30s, common by the late 30s, and near-certain deep into a player's 40s.
Goalkeepers get an effective three-year grace period compared to outfield players,
reflecting how much longer keepers typically play.

### 3.4 What a player is worth (transfer value)

A player's market value is driven purely by three things — their overall ability,
their age, and how much of their contract remains — with nothing else (form, position,
or club) factored in:

```
Value = what one season of that ability costs, read off the season-budget curve
        × a career multiplier for their age
        × a small contract-length adjustment (more contract time left is worth slightly
          more, capped at a ±10% swing)
```

**Ability** is priced in the same currency the pyramid pays out. A player is placed on
the *same* tier-budget curve that decides how much money each division receives (§7.1):
a player exactly at the top division's average ability sits at tier 1, and every
population standard deviation of ability above or below that moves one continuous step
along that curve. What he costs is then the slice of that tier's season budget that one
meaningful first-team signing is expected to eat. Prices are therefore always
commensurate with what a club can actually earn, and because the anchor is the *top*
division's average, they don't shift when the pyramid gains or loses divisions. Value
still grows steeply with ability — the budget curve is exponential — so an elite player
costs far more than proportionally more than an average one.

**Age** is priced by asking how much career the player still has left to give. He is
projected forward along the game's *population-average* career curve — average growth,
average decline, average peak age — and each future season is discounted by the chance
he has retired by then (averaged across positions, so the goalkeepers' three-year
retirement grace is included without value ever becoming position-dependent). That
expected remaining output is compared against what the *same* ability would be worth at
the average peak age, which is why a player at the peak age is exactly neutral. The
comparison is deliberately tempered (by default its square root is used) so that sheer
longevity cannot outweigh present ability. The consequence is that at equal ability the
younger player is always worth more, and the age effect is substantially stronger than
the contract effect.

Crucially, this projection uses the *public* career curve, never the player's own hidden
one. His real growth potential, growth speed, personal peak age, decline profile,
current form, position and club are never consulted — so two players with the same
visible rating and age are always worth exactly the same, and a price can never leak
scouting information.

The contract adjustment's neutral point — the length that leaves a player's value
unchanged — is not configured separately: it is derived as the midpoint between the
shortest possible deal (one season) and the longest allowed one
(`maxContractSeasons`), so the per-season adjustment lands exactly on both ends of the
configured ±10% range at the extremes. Remaining contract length is deliberately kept
*out* of the career projection, so it is never also counted as extra expected service.

A player's value is recalculated automatically any time their ability, age, or remaining
contract length changes, and is re-derived from scratch whenever the world is rebuilt, so
a change to the pricing model or its configuration reaches the existing population
instead of leaving stale prices behind. Prices already fixed by an open transaction are
the exception: the value snapshot taken when a transfer, free-agent or loan listing was
opened stays frozen for that listing's lifetime, so a repricing can never move an
auction underneath the clubs already bidding in it.

A player's **release clause** — the fixed price at which any club can buy them out
unilaterally — is set to half of their remaining nominal wages for the rest of their
contract.

### 3.5 What a player is paid (salary)

Salary follows the same shape as value — it grows steeply with overall ability and is
adjusted by an age curve that peaks in the mid-20s — with a guaranteed floor so no
senior player, however weak, is paid nothing.

The salary formula's baseline figures are calibrated against a "reference" season
length and automatically rescaled if the game's actual season length is ever
configured differently — so changing how long a season lasts doesn't accidentally
change how much money flows through the game each day.

**Academy wages** are a configurable small fraction (about a tenth) of what the *same
player* would be paid under the complete professional contract calculation, for his
own current ability, age, and exact contract length. No professional floor is
reapplied on top, so that fraction is exact. One deliberate consequence: because a
release clause is derived from salary, an academy-origin contract also carries a very
low release clause — that is an intentional mobility mechanism for a promoted
homegrown player whose club doesn't value him enough to put him on professional terms,
and it is never quietly swapped for a professional-sized clause.

### 3.6 Contracts and renewals

**Every** newly negotiated professional contract in the game goes through one shared
calculation — a club renewal, the renewal of a promoted academy player's retained
deal, the contract attached to a winning transfer bid, a free-agent signing, and the
first contract of a generated player. It takes the player's *current* ability and age,
the number of complete seasons the deal covers beyond the current one, and how much of
the current season is left.

The annual figure a player asks for is built from three parts: a floor that everyone
gets, a component that rises steeply with his visible ability, and a **youth premium**
that peaks just before first-team age and fades to nothing through the mid-twenties.
That premium reads visible age *only* — never a player's hidden potential — because
feeding hidden information into a public salary quote would leak scouting information.
Its effect is to make locking a promising young player into a long deal genuinely
expensive, without erasing the advantage of promoting and using him in the first place.

That annual figure is then levelled into a single flat salary across the exact
contract horizon, rather than a rising, compounding one. This has a quirk worth
knowing: renewing right at the very start of a season works out slightly cheaper per
season than renewing right at the end, even though the earlier renewal actually covers
more playing time. That is intentional pro-rating, not a bug.

**Contract length always means complete seasons *in addition to* the remainder of the
current one.** A five-season academy deal signed at the season boundary is the current
season plus four more — never six seasons of service.

**Nobody ever takes a pay cut to stay or to move.** Two of the paths above apply a
no-pay-cut floor, meaning the new deal can never be worth less per season than the
player already earns:

- a **club renewal** — so a player who has improved a lot since signing can no longer
  be kept on a stale cheap deal, and one who is being paid above his worth keeps it;
- a **transfer** — a player under contract does not accept less to change clubs, so a
  buying club must at least match what he already earns.

A **free-agent signing** is the exception. An expired salary does not follow a player
into free agency, so a player can quite legitimately reject a renewal at one price and
later ask for less once his contract has actually run out.

Once signed, a salary is fixed. Daily development never silently re-prices a contract;
the player's current ability is consulted again only when the *next* contract is
negotiated.

### 3.7 The youth academy

Academy players are always aged 16 to 19. An academy contract's length is **derived**,
not configured: it always runs to the age-21 boundary, so a 16-year-old gets five
seasons, a 17-year-old four, an 18-year-old three, and a 19-year-old two. An academy
contract can never be renewed or extended while the player is still in the academy.

**Promotion is a status change, not a negotiation.** It accepts no contract term and
makes no salary offer: the player's wage, contract start, expiry date, and remaining
duration all carry over exactly. That is what gives a lower-division club a real
window to use an excellent homegrown player on academy wages before an ordinary
professional renewal turns it into a genuine keep-or-sell decision.

- A manager may **voluntarily** promote a player from age 18, provided there's a free
  senior squad slot.
- At the age-20 boundary, **every** remaining academy player is promoted
  automatically. This is mandatory and cannot be blocked by a full senior squad.

If a full squad receives a mandatory promotion, the club goes into a temporary
**overflow** — it is never resolved by releasing, listing, replacing, or overwriting
anybody. While a club is over the squad limit it may not submit or settle transfer
bids, bid for or sign free agents, take a player on loan, voluntarily promote another
youth player, or renew any senior contract. Selling, loaning out, and releasing all
stay available, so the manager always has a way out. Settlement re-checks the limit,
so a bid placed before the overflow arose still can't sneak through afterwards.

Once promoted, a player is an ordinary senior in every respect. A renewal may be
offered only *after* promotion, and it uses exactly the same shared salary calculation
and validation as any other senior renewal (§3.6). If his retained contract reaches
age 21 unrenewed, it expires through the ordinary senior route and he becomes a free
agent — there is no separate academy expiry path and no age-21 youth state, because
everybody was already promoted by 20.

A manager can also **dismiss** a youth player. That never entitles the dismissing club
to a replacement of its own — but it doesn't permanently shrink the world either. See §3.8.

### 3.8 Keeping the player population stable

The game actively manages the total number of persistent players so the world neither
quietly drains away nor inflates over time.

Only the **active** world counts: players owned by active clubs, plus professional
free agents still inside their retention window. Filler AI clubs, temporary
provisional teams, and dormant clubs and their frozen squads are all outside that
boundary. When a club goes dormant, its target contribution and its frozen squad leave
the boundary *together* — that's a change of boundary, not destruction, so it needs no
compensation. Reactivation brings the same stock back.

The target is a per-club figure for owned players plus an expected free-agent pool.
The pool expectation is **measured, not assumed**: no rates are configured for how
often contracts expire or how quickly players get signed. Instead the game records
every professional that enters the listed free-agent pool (countered in the same step
as the listing) and, at each season snapshot, multiplies the trailing window's expiry
count by the average time the *currently listed* free agents have spent in the pool —
a stock = flow × residence estimate from realized data. A faster market therefore
lowers the expectation and a slower one raises it, so the benchmark self-calibrates
instead of drifting away from reality. The free-agent pool is part of the target, not
an untracked surplus sitting on top of a club-only one.

Every structural event that changes the population increments a durable counter *in
the same step that performs the change*, and nothing generates a player on the spot.
The single seasonal academy intake is the only thing that ever converts those counters
into new players. That includes:

- **expected retirements**, which set the smooth baseline;
- **actual minus expected retirements**, so an unusually heavy retirement season is
  fully replenished and an unusually light one creates no permanent surplus;
- **free agents deleted** after going unsigned for their whole retention period;
- **youth dismissals**, which are replenished through the *global* pool at the very
  next season-boundary intake — the extra recruit is shared out among all clubs by the
  usual seeded split, so a club can never dismiss and reroll a better prospect for
  itself, while the world still doesn't lose a player permanently;
- **players created outside the academy** (senior-squad top-ups, financial-rescue
  replacements), which *reduce* the next intake;
- **clubs genuinely joining or returning**, counted as their target contribution minus
  whatever squad arrives with them.

Academy promotion is never a population event — it only reclassifies a player who was
already there. Neither are transfers, signings, or loans: those change ownership, not
population.

The resulting correction is **signed** and can legitimately be negative. Generated
intake never is: every active club is guaranteed a configurable minimum number of new
prospects every season even during a surplus, and any negative balance that can't be
worked off because of that floor is carried forward rather than forgotten.

Because players are indivisible, the exact global total is resolved **first** and only
then split across clubs: everyone gets the whole-number share, and the leftover goes
to a seeded-random selection of clubs — one extra player each at most. Twenty-one
players across ten clubs is two each plus exactly one club getting the twenty-first.
The same world seed, season, and intake produce the same recipients every time, and
the result doesn't depend on what order clubs happen to be processed in. Slots blocked
by a full academy carry forward into the correction rather than being rerolled or
silently lost.

The whole intake — consuming the counters, generating the players, recording the carry
and the seeded allocation — commits atomically, so a retry sees either all of it or
none of it and can never convert the same deletion into players twice.

---

## 4. Match Simulation

Matches aren't simulated as a single random final score — they're played out as a
sequence of individual passages of possession, each resolved on its own, the way a
real match actually unfolds: a team wins the ball, tries something with it, and either
keeps possession, loses it, wins a set piece, or gets a shot away, over and over until
full time.

### 4.1 How a decision gets made

At every decision point (what a team with the ball tries next, whether a tackle
succeeds, whether a shot goes in), the game weighs several inputs together into one
combined likelihood for each possible outcome:
- A baseline likelihood for that situation, drawn from realistic football statistics
  for that specific game state (score, zone of the pitch, phase of play).
- How much the two teams' actual player quality favors one outcome over another.
- How much each team's tactical setup favors one outcome over another.
- A little randomness, representing the unpredictability of the real game.

By design, roughly 40% of the outcome comes down to raw team quality, 35% to tactics,
and 25% to luck — these three weights are the single dial that governs how
"skill-driven" versus "chaotic" matches feel overall, and can be retuned by the game's
designers.

Every one of these inputs is applied through exactly one shared calculation, so no
single factor (say, a team's overall quality) accidentally gets counted twice toward
the same decision.

### 4.2 What makes a team strong

There's no single number representing "how good is this team" — team strength is
built entirely, moment to moment, from the specific players currently on the pitch,
compared statistically against the whole player population. A team's effective
quality in any given phase of the match is the weighted average ability of whichever
players are actually involved in that part of the pitch at that moment — weighted by
their fitness in the moment (§5.3) and by how well-suited their natural position is
to the tactical role they've been asked to play.

Crucially, if a team is missing a player — sent off, or injured without an available
substitute — that specific area of the pitch the missing player used to cover gets
measurably weaker, rather than the team simply taking a flat, blanket penalty. A team
playing a player down also suffers extra, separate fatigue on its remaining players
from covering more ground (§4.5) — a deliberately distinct effect from the "weaker
area of the pitch" effect above, so the disadvantage of playing short-handed isn't
counted twice.

### 4.3 Tactics

Each club sets four tactical choices before and during a match: **formation**,
**playing style** (possession-based control, aggressive pressing, or fast
counter-attacking), **pressing intensity**, and **attacking direction** (through the
middle or down the wings). Each one nudges the match in its own distinct way:

- **Formation** determines how many players naturally support each area of the pitch,
  and therefore how outnumbered — or not — a team is in any given zone relative to its
  opponent.
- **Playing style**: a possession-based team is rewarded for safer, lower-risk
  actions; a counter-attacking team is specifically rewarded for quickly advancing the
  ball when transitioning from defense to attack; an aggressive-pressing team gets its
  main benefit through the pressing dial below rather than through style directly.
- **Pressing intensity** raises the chance the opponent gives the ball away under
  pressure, but also raises the pressing team's own risk of committing a foul, and
  disrupts the opponent's shape more severely right after winning the ball back.
- **Attacking direction** biases which side of the pitch (middle vs. flanks) a team
  tries to progress the ball through.

How well a team actually *executes* its chosen tactics — as opposed to simply choosing
them — depends heavily on **familiarity** (§4.6): a team that has drilled a particular
tactical setup for a full season performs it noticeably better than a team trying the
exact same setup cold for the first time.

### 4.4 What happens during a match

- **Pace of play**: rather than a fixed number of events per minute, each passage of
  play takes a realistically variable amount of time, so the match clock advances
  naturally and unevenly, the way a real 90 minutes does. Stoppage time at the end of
  each half responds to what actually happened in that half — goals, substitutions,
  injuries, and cards all add a little.
- **Quality-normalized event volume**: the action model is anchored to the accepted
  neutral reference XI. When generated squads are materially stronger than that
  reference, only the neutral pass-intent weight and action pacing are interpolated
  toward the calibrated high-quality setting. This prevents the new generation scale
  from inflating pass counts and total actions; it does not directly modify goals,
  xG, or win probability, which remain emergent from the possession engine.
- **Short-handed execution**: a missing support player lowers local formation
  density. Pass execution uses its own calibrated density sensitivity because
  passing relies on nearby support more directly than shot quality; shot density
  is calibrated separately. Both effects are local and emergent, and neither is
  a direct win, score, or xG modifier.
- **Shots**: who takes a shot, from where, and how likely it is to result in a goal
  are all driven by the specific players on the pitch — the shooter's finishing
  ability versus the opposing goalkeeper's shot-stopping ability is the one place a
  goalkeeper's individual quality goes head-to-head against an individual attacker,
  rather than being folded into a general zone strength.
- **Fouls and cards**: yellow and red card odds are calibrated against a realistic
  target number of fouls per match, then shifted up or down by how aggressively a team
  is pressing, how tired and undisciplined its players are, and how dangerous the
  situation is.
- **Injuries**: every passage of play carries a small, combined chance that someone on
  the pitch gets injured, weighted by each individual player's own fatigue, recent
  workload, and age — calibrated so that, across a whole match and both teams, the
  expected number of injuries lands at a realistic target (currently about a third of
  an injury per match on average).
- The whole simulation is fully reproducible: given the same starting conditions,
  replaying a match (say, catching up after a delay) produces an identical result
  rather than a different random one.

### 4.5 Playing a player down

A player sent off, or injured with no one to bring on, doesn't directly reduce the
team's chance of winning through some separate penalty — that disadvantage emerges
naturally and entirely from the team simply having one fewer player contributing to
the pitch-strength calculation described in §4.2. What *is* applied directly and
separately is extra fatigue: the remaining players tire faster the fewer teammates
they have around them, since they're covering more ground.

### 4.6 Familiarity with a tactical setup

A club builds up familiarity with each specific combination of formation, style,
pressing, and direction it actually uses — not with "tactics" in general. A completely
new combination starts at a neutral, middling familiarity — never as a penalty, just
an unpolished starting point. The more matches a club plays under one setup, the
better its players execute it, approaching (but never quite reaching) full mastery
over the course of a season. Familiarity fades slowly if a setup goes unused for a while.

Switching tactics — even mid-match — costs some of that familiarity, though a portion
carries over if the new setup is similar to the old one (same formation shares, same
style, similar pressing level). What actually matters on the pitch is never one side's
familiarity in isolation — only the *relative* gap between the two sides' familiarity
with their own respective setups. Two evenly-matched, equally well-drilled teams get
no advantage from familiarity either way.

### 4.7 Home advantage

Playing at home gives a team two distinct, separate boosts: a better chance of
advancing the ball into dangerous attacking areas, and a slightly higher chance of
converting the shots it does get. There is currently no separate mechanic that
suppresses a big comeback based on the two teams' relative strength — despite an old
setting existing for exactly that idea, it was never actually wired into how matches
are simulated (§14).

### 4.8 Following a match live

A live match plays out in real time at a pace the game controls — currently, a
90-minute match takes about half an hour of real time to complete, whether anyone is
watching or not. Human-versus-human matches pause briefly at half-time (up to five
real minutes, or less if both clubs signal they're ready to continue); matches with no
human involved play straight through without pausing. Both sides share the same cap on
how many substitutions they can make in a match — currently five — no matter whether
those substitutions are made manually, automatically (§5.6), or through automation
rules (§11). Changing style, pressing, or direction mid-match is locked out for a short
cooldown (currently ten match-minutes) after the last change; formation changes are
only allowed before kickoff or at half-time.

---

## 5. Energy & Injuries

### 5.1 Getting tired during a match

Every player on the pitch loses energy continuously through the match, at a rate that
depends on:
- Their **role** — midfielders work hardest, defenders moderately, forwards a bit
  less, goalkeepers barely at all.
- How hard their team is **pressing** — heavier pressing tires everyone faster.
- Their own **fitness** — physically stronger players tire more slowly.
- Their **age** — players past their late 20s tire noticeably faster, with the effect
  compounding the older they get.
- Their **current energy level** — tiredness snowballs: the more depleted a player
  already is, the faster they tire further.
- How **involved** they are in that specific passage of play — energy drains faster
  when a player is actually near the ball or central to the tactical picture than when
  they're peripheral.
- Whether their team is playing a player down — the remaining players absorb extra
  fatigue in that case (§4.5).

### 5.2 Recovering energy

Between matches, every player recovers some energy each day, at a rate that depends on
their physical fitness, their age, and how heavy their recent match workload has been
(heavier recent workload slows recovery). Recent workload itself fades gradually day
by day rather than resetting instantly. A player who's currently injured — or has
recently recovered from one — has a *temporarily lowered ceiling* on how much energy
they can regain, roughly proportional to how serious the injury was; that ceiling
returns to normal once the injury has fully run its course.

### 5.3 How fatigue affects performance

A tired player performs worse across the board — technique, pace, physicality,
finishing, goalkeeping, and discipline are all scaled down the lower a player's
current energy is. This is a smooth, continuous effect rather than a simple "tired"
on/off switch, and it updates constantly through the match as energy drains.

### 5.4 The chance of getting injured

**During a match**, every passage of play carries a small combined chance that a
participating player gets injured, individually weighted by that player's current
energy (a much more depleted player is considerably more likely to get hurt), their
recent workload, and their age (risk rises somewhat with age, peaking around the late
20s). The whole model is calibrated so that, averaged over an entire match and both
teams combined, roughly a third of an injury happens per match — which, spread across
roughly 22 players on the pitch, works out to a low single-digit percentage chance for
any one individual player in any one match, shifted up or down from that baseline by
their own condition.

**During training** (on non-match days), each club has a small, independent chance of
a training injury each day, similarly weighted toward whichever of its players
currently carry the heaviest workload or are older — calibrated so that a club with an
average roster experiences roughly one and a half training injuries per season.

### 5.5 How severe an injury is

Most injuries are minor (a bit over 4 in 10, lasting roughly a week or so) or moderate
(a bit over half, lasting several weeks); a small fraction (about 1 in 50) are severe,
sidelining a player for a couple of months or more. Older players tend to take
slightly longer to recover than younger ones. A small proportion of longer injuries
(capped at a 1-in-5 chance, and only for injuries serious enough) leave a
**permanent** mark — a small, lasting reduction in the player's skills and ceiling
that never fully heals. This is the only way a player's ability can be permanently
reduced by anything other than natural aging.

### 5.6 Replacing an injured player automatically

If a player is injured badly enough to need to come off, the game automatically brings
on the best available same-position substitute from the bench (or, failing that, the
best available outfield substitute) — using up one of the team's substitution slots,
the same shared cap described in §4.8. If there's no substitution slot left, or no
suitable replacement on the bench, the team simply plays the rest of the match a
player short.

### 5.7 Who's available to play

A player who's currently injured or suspended simply cannot be selected into a
lineup — by a human manager or by the game's own automatic squad-picking — until their
injury has fully healed or their suspension has been served.

### 5.8 Discipline: bookings and suspensions

Discipline is purely a downstream consequence of match events — the card model in the
match engine is never influenced by any of these rules, so no rebalancing of match
simulation is required when they change.

- **Yellow cards are counted per league turn** (a turn is one complete pass through all
  opponents, i.e. half of a double round-robin; with 8 teams and 2 turns, rounds 1–7 form
  one turn and rounds 8–14 the other). A player booked twice inside the same turn is
  automatically suspended (currently for one fixture), after which their per-turn counter
  starts fresh. Bookings never carry across a turn boundary, and the season-total yellow
  count used for season history keeps accumulating independently.
- **Red cards go to a tribunal.** The ban length is drawn from a log model over a uniform
  1–100 roll (`games = round(5.1748 − 0.9884 · ln(X))`, configured in
  `game.config.jsonc` under `discipline`), yielding roughly 59% ×1, 27% ×2, 9% ×3,
  4% ×4, and 1% ×5 fixtures. Exactly one RNG draw is consumed per red card at
  finalization, keeping replays deterministic.
- **Serving**: suspensions tick down once per club fixture that is finalized, whether or
  not the suspended player would have taken part.
- **Squad warning**: the squad screen's condition column shows a yellow-card icon for a
  player booked in the same league turn as the club's next fixture while they sit one
  booking below the per-turn limit — i.e. another yellow in the following match means an
  automatic ban. The icon deliberately does not appear when the next match falls into a
  new turn.

---

## 6. Transfer Market

> **The transfer market — auctions, free agents, and loans — currently only involves
> human-owned clubs.** AI-controlled clubs never list a player for sale, never bid,
> never sign a free agent, and never claim a loan. A full design for AI clubs actively
> buying and selling exists on paper (scoring how badly a club needs a player, how
> eager it should be to sell a surplus one, and so on) but hasn't actually been built
> yet — see §14.

### 6.1 Selling a player at auction

A club listing a player for open auction picks an asking price anywhere from 60% to
100% of the player's calculated market baseline (defaulting to the full 100% if they
don't specify), and the auction runs for 24 hours from listing. A handful of
safeguards apply: a youth-academy player can't be listed for open sale; a very new
club can't sell anyone until it's played a few of its own league matches (an
anti-abuse measure, §10.1); and a player who was just bought is locked from being
immediately resold, both for the rest of that season and for a couple of weeks
afterward regardless of season — a signing made purely to flip for profit isn't possible.

**The maximum price a buyer can pay** depends on the gap between the two clubs'
divisions: a buyer at the same level or a weaker division than the seller can bid up
to 1.5× the player's calculated value; the strongest possible buyer taking from the
very weakest possible seller can bid up to 3× — with every division gap in between
smoothly interpolated. This keeps the biggest clubs from hoovering up talent from
clubs at their own level while still letting a big club occasionally raid a much
weaker one at a real premium.

**Bidding** works like a standard sealed-maximum auction: each bidder sets their own
private ceiling, and the visible price only rises as far as needed to stay just ahead
of the next-highest bidder — nobody ever pays more than they had to. Bids can only go
up, never down, and a bidder can never bid more than they can actually afford right
now. If a competitive bid comes in with less than 30 minutes left on the clock, the
deadline extends by another 30 minutes — with no limit on how many times this can
happen, so a genuine bidding war can run as long as it needs to.

**The contract the winner signs** is calculated from the player's ability and age as
frozen at listing time, and honours the no-pay-cut floor (§3.6): a player under
contract will not accept less per season to change clubs, so the buying club must at
least match what he already earns. A bidder's term and salary are both locked in the
moment their first bid lands, so nobody ever finds out what they committed to only at
settlement.

When the auction settles, **5% of the final price is deducted as a transaction fee
that simply leaves the economy entirely** — it isn't paid to anyone; it's the game's
main way of keeping the total money in the world from spiraling upward over time. The
buyer still pays the full agreed price; only the seller's payout is reduced by the fee.

### 6.2 Signing a free agent

An unattached player is listed for 24 hours at a time at a fraction of their
calculated market value — starting around 10%, and getting cheaper (down to as little
as 2.5%) each time a listing period passes with no bids. If nobody signs a player
within about a month of their very first listing, they leave the game's pool
entirely. Bidding works the same sealed-maximum way as an open auction, with no upper
price limit beyond what a club can actually afford.

A free agent's likely contract length is longer for younger players and shorter for
players nearing the typical age of decline, following a smooth sliding scale centered
on the early 30s — a fresh-faced 20-year-old free agent will typically be offered
close to the maximum contract length, while a 34-year-old will typically only get the
shortest one on offer.

Unlike a transfer, a free-agent contract carries **no** no-pay-cut floor: an expired
salary doesn't follow a player into free agency, so a player who turned down a renewal
may quite legitimately end up asking for less once his contract has actually run out
(§3.6).

Unlike an open auction, money paid to sign a free agent doesn't go to any club — it's
paid directly out to the wider game economy, since there's no selling club on the
other side of the deal.

### 6.3 Loaning a player

A club can loan out a player it owns, choosing a fee for whoever eventually borrows
him — somewhere between 10% and 30% of his value — locked in at the moment of
listing. A newly listed loan can't be claimed for the first 30 minutes (giving
everyone a fair chance to see it), and loans are always structured to run through to
the end of the current season.

Two guards stop a loan listing that could never make sense:

- **The listing itself must finish inside the player's contract.** A listing whose
  public exposure window would outlast his deal could only ever be claimed after he
  had already left, so it is refused outright.
- **A player in his final contractual season can't be listed once the season is
  past the join threshold.** At that point he is on course to leave as a free
  agent at the rollover unless he's renewed — and he can't be renewed while
  he's listed, whether for loan or for open sale. The club has to sort out his
  contract first. A club can only borrow up to five players on loan at
once, and the same senior-roster-size limits that apply to every other way of
acquiring a player apply here too. Whoever borrows a player pays that fee immediately
and takes over paying his full wages for as long as the loan lasts; loans don't count
toward the resale-price history that governs listing behavior elsewhere. Anyone still
out on loan and unclaimed gets automatically recalled to his own club when the season ends.

### 6.4 How an asking price is calculated

If a player was bought or sold outright in the recent past, his opening price for a
*new* auction listing starts anchored close to what he last sold for, then gradually
fades back toward his current calculated market value the more league matches get
played — by around six rounds later, the old sale price has no influence left at all,
and it's purely his current value. (A loan doesn't count as a sale for this purpose.)
With no recent sale on record, the opening price is simply based on his current market
value from the start.

### 6.5 Behind the scenes: contract terms and market updates

Every open listing freezes a winning bidder's contract terms the moment their bid is
placed, rather than negotiating them only at the very end — so a bidder always knows
exactly what they're agreeing to before they commit. Every club currently involved in
an active listing gets notified the moment anything about it changes — a new bid, a
closing-time extension, a sale completing — but a club is only ever told whether *it
itself* is currently in the lead, never what any other club has bid.

---

## 7. Club Finance & Economy

### 7.1 Season budgets

The **Division 1 season budget is the anchor of the entire money economy**. It is a
single configured figure, and both seasonal allocations and every player's market value
(§3.4) are derived from it, so prices and incomes can never drift apart. It is
configuration only: there is no database copy and no admin override, so the same
configuration always reproduces the same economy — and a configuration rollout can't be
silently overridden by a stale saved value. Previously the Division 1 budget was itself
derived from player values, which were in turn derived from a separate price curve; that
circular definition is gone.

Every club receives a budget once per season, added on top of whatever cash it
already has — it's never a reset to zero. Division 1 gets the largest budget; every
tier below it gets a progressively smaller one, shrinking exponentially as you go down
the pyramid but never falling below 30% of Division 1's figure (both that floor and
the rate of shrinkage are tunable). Actual allocations are clamped at Division 1 and
never extrapolate above it; the same curve *is* extended past that point, but only as
the pricing scale for players better than a typical top-division player (§3.4). There's
deliberately **no other source of guaranteed income** — no gate receipts, no ticket
sales, no sponsorship — the seasonal budget plus whatever a club earns on the transfer
market is its entire income.

A brand-new club starts with **zero** cash of its own; its only funding is this same
seasonal budget. A club joining before the season's roster lock gets a full budget for
the tier it joins; one joining mid-season (after the lock) gets a budget scaled down
to however much of the season is left, and is guaranteed to receive exactly one such
budget — never accidentally double-paid.

### 7.2 How much a club can actually spend right now

Every club's true financial position accounts for money that's already spoken for,
not just the number sitting in its account:

```
Real financial cushion = current cash
                          − money locked up in the club's own active bids
                          − wages still owed for the rest of the season on the current squad
                          − wages the club would owe if it wins whatever auction(s) it's currently leading
```
No projected future income — prize money, a hoped-for sale, anything not already in
hand — ever counts toward what a club can spend. That last item (wages it would owe if
it wins a bid it's currently leading) disappears automatically the moment the club
gets outbid, since the commitment was only ever contingent.

A separate, simpler figure — cash on hand minus only the money locked in active bids —
is what actually gates any brand-new spending decision (a release-clause payment, a
loan fee, a free-agent bid), since committed future wages aren't due *today*.

There's no separate rule preventing a human-run club from spending itself into a
negative cushion — a human owner can do that, and simply gets a warning about it. AI
clubs never go negative, but only because they never spend or hold money in the first
place (§10.3) — there isn't a special extra safeguard just for them.

### 7.3 Paying wages

Every club pays its full squad's wages on a fixed weekly cycle. The amount owed each
cycle is calculated as a running, cumulative total rather than a fixed slice,
specifically to avoid rounding errors quietly building up over the course of a
season. New clubs that haven't been formally activated yet don't pay wages at all
until they are; AI clubs never pay wages, ever, since they hold no money.

If a club is still short of cash immediately after a wage payment — and was already
short *before* that payment too — the game automatically steps in (below).

### 7.4 When a club can't pay its bills

If a club can't cover its obligations, the game intervenes automatically, in a fixed
order designed to be firm but never punitive beyond what's needed:

1. Any player the club currently has up for open sale gets sold off immediately at
   whatever the current going bid is (or the listing is simply cancelled if nobody had bid).
2. The game calculates exactly how much extra cash the club needs to get back to zero.
3. If that's not enough, the game sells off a carefully chosen handful of the club's
   own players — always at a firm floor price (60% of their calculated value, never
   full value, specifically so this can never be exploited as a way to cash out at
   full price by going deliberately broke) — replacing each one with a freshly
   generated player of similar ability in the same position, so the club isn't left
   with an unfairly thin squad.
4. The exact players sold are chosen to cover the shortfall as precisely as possible
   with as few sales as needed. If even selling everything eligible still isn't
   enough, the club is left with whatever shortfall remains rather than the game
   inventing money or repeatedly selling the very replacements it just created.
5. A sold-off player becomes a free agent that his old club is specifically barred
   from re-signing — so a club can't use this as a backdoor way to quietly discount
   its own wage bill and buy the same player straight back.

This never happens more than once for the same club in the same wage-payment cycle.

### 7.5 Keeping pace with the season length

Certain figures — most notably base salary levels — are calibrated against a
standard "reference" season length, then automatically scaled up or down if the
game's actual season length is ever different. That way, changing how long a season
lasts doesn't accidentally speed up or slow down the pace at which money moves through
the game. A player's transfer value and release clause are deliberately *not*
rescaled this way, since those are one-time prices rather than an ongoing flow.

The season budget is not rescaled either: it is configured directly as the amount a
Division 1 club receives per season, whatever the season's length. Since player prices
are derived from that same figure (§3.4), transfer values and the budgets that pay for
them always move together, and neither is quietly rescaled out from under the other.

### 7.6 Where money leaves the economy

Every completed club-to-club transfer has a 5% transaction fee taken out of the final
price before the selling club is paid — money that simply disappears from the economy
rather than going to anyone. This is currently the main structural way the total
amount of money in the game doesn't just keep climbing forever, and it naturally hits
the busiest, richest clubs hardest since it scales with how much they're spending. If
the selling club happens to be an AI club, none of that sale money is even briefly
credited to it — the whole amount is treated as leaving the economy.

---

## 8. Season Calendar & Lifecycle

### 8.1 The calendar's phases

See §1.2 for the day-by-day shape of a season. In short: an active league-play window
of round-by-round matches, followed by a short buffer, followed by the actual
off-season window where everything below happens.

### 8.2 What happens every day

Every single day, regardless of whether it's a match day: clubs that have gone quiet
for too long get flagged as potentially abandoned (§10.2); every player's energy
recovers a little and any current injury countdown ticks down; on non-match days
specifically, there's a small chance of a training injury; and every player's
development or decline for the day is applied (§3.3).

On top of that, once a week: full wages are settled for every club (triggering a
financial rescue if needed, §7.4), and any player whose contract has fully run out
formally leaves their club.

Players belonging to a **dormant** club are skipped entirely — they don't develop or
decline at all while their club is frozen (§10.2).

Nothing related to aging a full year, retirement, youth academy intake, or
end-of-season awards happens during the regular season at all — those are strictly
end-of-season events, described next.

### 8.3 The end-of-season sequence

At the end of every season, a fixed sequence of steps runs, each one safe to retry on
its own if anything gets interrupted partway through:

1. **Finalize the season**: lock in final standings and permanently archive them
   (including each club's name exactly as it was at that moment), hand out trophies to
   division winners, and calculate end-of-season awards — top scorer, top assister,
   player of the season, and a best XI. Awards are computed independently for every
   division+group (never aggregated across groups), and a player is only eligible if he
   appeared in at least `awards.minAppearanceFraction` (default 40%) of his club's
   league games that season (a match with at least one minute on the pitch counts as an
   appearance). Assists are recorded by the match engine purely as bookkeeping: the
   passer of the last completed pass/cross of a possession is credited when a teammate
   scores from open play; turnovers, fouls, restarts, penalties and shootouts never
   produce assists. The best XI stores each member's player id, club id and name so
   clients can still link members to their player card while they exist in the world.
2. **Promotion and relegation**: work out which clubs move up, which move down, and
   which stay — see §9.3. Clubs that have gone quiet and unresponsive for too long are
   formally marked dormant at this point.
3. **Rebuild the divisions**: tear down the old season's divisions and any AI clubs in
   them, then rebuild fresh divisions for the new season based on the
   promotion/relegation results.
4. **Settle waiting clubs**: any club that had joined after the roster lock and was
   waiting in the wings gets placed into its new division.
5. **Hand out next season's budgets**.
6. **Wrap up contracts**: age every player by a full year, count down every remaining
   contract by a season, roll the dice on retirement for players 33 and over, and
   formally release anyone whose contract has now fully expired. Expected retirements
   are measured before the dice are rolled so the difference can be replenished
   exactly (§3.8). Dormant clubs are skipped completely — their players don't age,
   retire, or lose contract time.
7. **Youth academy intake**: promote every academy player who has reached the
   automatic promotion age (§3.7), resolve the exact global intake total and its
   per-club allocation (§3.8), generate each club's share, and top up any club whose
   senior squad has fallen below a healthy minimum size. Those top-ups are recorded so
   they reduce the *next* season's intake rather than the one just settled.
8. **Open the new season for joining**.
9. **Generate next season's fixtures** for every division.
10. **Double-check** that every division's fixture list is complete and correctly
    balanced before the season is allowed to actually begin.

The whole process is built to survive an interruption partway through — if it's ever
restarted mid-rollover, it simply picks back up exactly where it left off rather than
repeating or skipping a step, and it never rewrites a match result that's already been
recorded.

---

## 9. Standings, Promotion, Relegation & Club Ratings

### 9.1 League tables

Standard football points: 3 for a win, 1 each for a draw, 0 for a loss. When clubs are
level on points, ties are broken in this order: most wins, then best goal difference,
then most goals scored, then (only as an unusual last resort before an arbitrary but
consistent final tiebreak) a club's internal rating — below.

### 9.2 Club ratings

Behind the scenes, every human-owned club carries a hidden skill rating (in the
well-known Elo style used for chess and many sports) that rises when it beats a
similarly-rated opponent and falls when it loses to one, moving more sharply after an
upset than after an expected result, with a modest boost baked in for whichever club
is playing at home. This rating only ever moves for matches between two human-owned
clubs — a match involving an AI club never affects anyone's rating. Between seasons,
every club's rating drifts 10% of the way back toward a neutral starting point, so
ratings don't just keep drifting further and further apart forever.

The raw rating, rating changes, rating history and rated-match count are deliberately
never shown through the club's public profile or anywhere else players can see. The
public Footmania ranking is the one permitted derivative: it publishes only the
ordinal order of active human-managed clubs, with no rating values. AI, provisional and
dormant clubs are not eligible for that ranking. It plays no role at all in actually
simulating a match (§4.2) — a highly-rated club doesn't get any direct boost in a match
itself; the rating only reflects and orders past results.

### 9.3 Promotion and relegation

At the end of every season, from the top of the pyramid down:

1. **Relegation**: in every division below the very top tier, the bottom two clubs (by
   final standing) drop down one tier. AI-controlled clubs are simply skipped over
   entirely in this process — they never occupy a promotion or relegation slot either way.
2. **Promotion**: working back up from the bottom, each division above fills however
   many slots it has open (accounting for who's staying and who's dropping in from
   relegation) by pulling in the best-ranked eligible human clubs from the tier below —
   never an AI club. If more clubs qualify for promotion than there are open slots, the
   ones who get in are decided by: club rating first, then points-per-match, then
   goal-difference-per-match, then goals-scored-per-match, then win rate — all
   measured *per match played*, so it's fair even if different divisions played
   slightly different numbers of matches.
3. If an entire tier ends a season with no active human clubs left in it anywhere,
   that tier is simply removed from the pyramid rather than artificially kept alive —
   the tier above it becomes the new bottom of the active pyramid and, for that one
   season, doesn't relegate anyone downward into the gap.
4. The whole result is double-checked before being accepted: no club can end up
   unassigned, double-assigned, or assigned while inactive — if anything looks wrong,
   the process stops rather than risk corrupting the pyramid.

### 9.4 How divisions are grouped

When divisions are rebuilt each season, the game first works out the fewest possible
divisions needed to fit every human club at no more than 8 per division — human
density always comes first. Within that fixed number of divisions, clubs are then
grouped together according to a strict order of priorities: real-life friends who've
specifically opted to play together come first, friends-of-friends next, then how
well clubs' preferred match times overlap with each other, and — only as the lowest
priority, purely to keep things fair — how evenly matched clubs' ratings are within a
division. Which specific sub-group number ("2.1" vs "2.2") a club lands in is never
preserved season to season — only the tier itself carries over; the grouping within a
tier is worked out completely fresh every time.

---

## 10. Multiplayer Lifecycle

### 10.1 Joining, and joining late

Once roughly half of a season's rounds have already been played, the door closes for
that season specifically — new clubs founded after that point are held in a waiting
state until next season begins, never based on the calendar date, only on how much of
the season has actually been played.

- **Joining before the door closes**: the new club takes over an existing AI club's
  slot in whichever division sits at the current bottom of the pyramid — inheriting
  that slot's position in the table, but only its *future* matches get rewritten;
  anything already played stays exactly as it was. The new club is playable immediately.
- **Joining after the door closes**: the club is fully playable in every other
  respect — it can manage its squad, buy players, and play unranked practice matches —
  but doesn't compete in the real season until next season begins. Its players still
  age and develop normally in the meantime; nothing about its contracts or wages moves
  forward until it actually goes active.
- **A brand-new club can't immediately sell anyone it just bought or start listing
  players for auction or loan** until it's actually played a handful of its own real
  league matches — a deliberate speed bump against using a disposable brand-new club
  as a laundering shortcut.
- **Practice matches** a club plays while waiting to go active are truly
  consequence-free: they're simulated on a private copy of the club and its players,
  so nothing that happens in one — no stats, no injuries, no card accumulation — ever
  carries over to the club's real, persistent squad.

### 10.2 Going quiet, and coming back

Each tier has its own threshold for how long a club can go without any meaningful
activity before it's flagged as potentially abandoned — a bit under two months at the
very top of the pyramid, a bit under a month everywhere else. Being flagged never
removes a club mid-season: a club flagged during a season stays fully active right
through to the end of it. It's purely a heads-up that gets acted on only at the next
end-of-season sequence. Any renewed activity clears the flag immediately.

When a still-flagged club is finally marked dormant, it leaves its division and group
and is **frozen whole**:

- its players don't age, develop, decline, retire, or reach contract expiry;
- contracts, wages, payroll, cash and budgets don't move;
- it receives no academy intake, no automatic promotions, and no replacement players;
- it plays no fixtures and takes no part in the market;
- and none of this is caught up on later — there is no offline back-pay or back-growth.

Anything it was still involved in on the market is settled or withdrawn *before* the
frozen snapshot becomes authoritative — its own listings are cancelled, its bids are
withdrawn and their reservations released, and any loan boundary involving it is
closed. That way no deadline can ever fire later against a club whose clocks have
stopped.

A dormant club can return at any time — but always re-enters at the very bottom of the
current pyramid, never back at whatever tier it left from, and doesn't receive a fresh
new-club starting budget on its return (its existing finances, whatever they were,
simply pick back up).

### 10.3 AI clubs come and go every season

AI clubs are disposable by design: each one exists for exactly one season, with a
fixed 35-player squad, no youth academy, and permanently zero money — they never buy,
sell, loan, borrow, or release a single player of their own accord. When an AI club is
removed — either because a human takes over its slot mid-season, or because the whole
pyramid gets rebuilt at season's end — the game carefully tidies up anything that club
was involved in first: any bid it had placed elsewhere is withdrawn, any of its own
players still up for sale get sold off immediately to whoever the current leading
bidder is (or the listing is simply cancelled if there were no bids), and only once
all of that is settled is the club itself actually deleted. This guarantees nothing
left behind in the market ever points to a club or player that no longer exists.
Every season, whatever slots are still empty after every human club has been placed
get filled with entirely fresh AI clubs — none ever carry over from one season to the next.

---

## 11. Tactics Automation

A club can save an automation preset — a small set of rules that adjust tactics or
make substitutions automatically during a live match, without the owner needing to be
actively watching. A preset is tied to one specific formation; regular clubs get one
preset overall, while clubs with Pro benefits get one preset for *each* formation they
use.

Each individual rule is built from three parts:
- **A trigger**: a specific match minute, half-time, a goal scored, a goal conceded,
  or a red card.
- **A condition**: any situation, currently winning, currently losing, currently
  drawing, winning by two or more, or losing by two or more.
- **An action**: either a substitution (swap a specific player out for a specific
  player in) or a tactical change (formation, style, pressing, and/or direction).

Every rule fires **at most once** per match — it won't repeat itself over and over
even if its trigger condition keeps being true. If a rule's planned substitution
becomes impossible to actually carry out (say, the intended replacement gets injured
or sold before the rule ever fires), the rule is simply retired for that match rather
than trying — and failing — the same impossible action every single minute. A
tactical change made by an automation rule only affects that one live match; it never
overwrites the club's own saved default tactics. Every automated tactical change is
priced exactly the same familiarity cost as if the manager had made the change by hand
(§4.6), and an automated formation change is only allowed at the same moments a manual
one would be — before kickoff or at half-time.

---

## 12. Live Matches & Notifications

### 12.1 Watching a match live

While a match is in progress, its state updates roughly once every second for anyone
watching, without needing to manually refresh — a full picture is sent whenever the
match crosses a major moment (kickoff, half-time, full-time), and only what's actually
changed (the latest events, the current score and minute) is sent the rest of the
time, so watching stays lightweight even over a slow connection. Any match, at any
time, is open for anyone to watch — but only the two clubs actually playing in it can
make substitutions, change tactics, or adjust the lineup while it's underway.

### 12.2 Notifications

A club's owner gets notified when one of their matches kicks off and when it
finishes, regardless of whether they have Pro benefits. Being notified the moment a
goal happens — theirs or the opponent's — is currently a Pro-only benefit. Right now,
all notifications arrive inside the game itself; the ability to send a notification to
a phone or browser outside the game exists in a limited, preparatory form (a player
can register to receive one) but the game doesn't yet actually send anything through
it — see §14.

### 12.3 Keeping in sync

Beyond notifications, a handful of lightweight, in-the-moment signals keep a connected
player's view up to date automatically — for example, telling their screen to quietly
refresh itself the moment something relevant changes elsewhere (a market bid
resolving, an admin announcement going up) rather than making them notice and refresh
manually.

### 12.4 Club news

Everything a manager needs to know about their club and the world around it arrives as
written messages in the existing dashboard news section, not as bare one-line
statements or a separate inbox page. Messages are immersive: the stored body itself
contains the player names, days remaining, amounts, and context needed to understand
what happened and why it matters. Structured facts remain persisted for deterministic
grouping and auditability, but are not rendered as a separate list.

Grouping rule: events of the same subject landing on the same season day for the same
audience merge into one message instead of spamming the feed — e.g. every contract
entering its renewal window today is one message listing each player with his days
remaining; multiple training injuries at one club on one day are one treatment-room
update; all contract expiries processed at season rollover are one departure report.
Retried jobs can never duplicate a fact inside a grouped message.

Visibility rule: club-internal matters (own contracts, finances, academy moves,
inactivity warnings) are visible only to that club's manager. Public items attributed
to a club are shown only in that club's dashboard news; unattributed broadcasts and
admin announcements are global. Admin announcements stay pinned above everything else.

Pre-season report: on the first day of every new season each human-managed club
receives one briefing covering its division placement and last-season finish, cash
and financial cushion, contracts approaching expiry, senior/academy squad sizes,
rollover movement (promotions, new intake, replacements), the first fixture, and the
season budget. The report is written once per club per season — rollover retries
cannot duplicate it.

---

## 13. Admin, Analytics & Pro Features

### 13.1 Behind-the-scenes health monitoring

The game's administrators have access to a diagnostic view comparing the real,
current player population against what the game's own generation formulas would
predict in a perfectly balanced world — average ability by division, financial
distress across clubs, squad sizes, how the mix of positions compares to the intended
template, how actual salaries compare to the formula, the age spread of the whole
population versus a theoretical steady state, and the health of the free-agent pool.
The projected age spread comes from the very same survivorship model that generates
initial senior ages and plans academy intake, so a real-versus-projected gap always
means the living world has drifted — never that two models disagree.

Alongside those stocks, the view reports the **flows** behind them season by season:
expected and actual retirements, free agents deleted after going unsigned, youth
dismissals recorded but not yet converted by an intake, players created outside the
academy, the raw, floor-clamped and final intake totals, and the signed balance carried
forward. An observed gap against the target is expected to reconcile exactly against
that ledger plus the not-yet-converted youth dismissals; anything else is a bug, not a
bonus.

None of this feeds back into how the game actually plays — it exists purely so
administrators can spot the population quietly drifting out of balance over time and
step in if needed.

### 13.2 Pro benefits

A club's owner has Pro benefits if they've been specifically granted Pro status, or if
they hold administrator privileges (administrators automatically receive every Pro
benefit on top of their admin powers). Pro status, once granted, doesn't expire on its
own. The benefits currently gated behind it are:

1. An extra automation preset per formation, instead of just one overall (§11).
2. Uploading a custom club crest (choosing between the game's built-in crest designs,
   however, stays free for everyone).
3. Giving a player a nickname (removing one, however, stays free for everyone).
4. Seeing a player's or listing's detailed history, and a player's exact underlying
   skill numbers, when that player belongs to someone else's club (this restriction is
   waived automatically for a player currently up for auction or loan, so everyone can
   scout an active deal).
5. Renaming a club's coach (a club may only do this once per season regardless of Pro status).
6. Seeing a match's detailed statistics after it finishes.
7. Being notified the instant a goal happens, live (§12.2).

### 13.3 Announcements

Administrators can post short announcements (currently capped at 280 characters) that
every connected player sees; posting one immediately prompts every connected player's
screen to refresh so they see it right away. Every announcement ever posted is kept
permanently — there's no way to edit one after posting, only to remove it.

---

## 14. Known Gaps & Partially-Built Features

A few things worth knowing that either aren't finished yet, or exist as leftover
settings with no real effect today:

- **AI clubs don't buy or sell on the transfer market at all** (§6). A full design
  exists on paper for how an AI club should decide it needs a player or has a surplus
  one to sell, but none of it has actually been built — every AI club today is simply
  a bystander in the market.
- **A setting exists to suppress big comebacks based on the two teams' relative
  strength, but it was never actually connected to the match engine** (§4.7) — no such
  suppression currently happens in a real match.
- **A setting exists to switch how kickoff times are chosen** (a single fixed hour for
  everyone, versus each division's own local preference), **but fixture scheduling
  never actually reads it** — kickoff times are always chosen by the preferred-time-window
  method described in §1.3, regardless of how that setting is configured.
- **Push notifications to a phone or browser outside the game aren't actually sent
  yet** — a player can register their device to receive one, but nothing currently
  triggers an actual push; all real notifications today arrive only inside the game
  itself (§12.2).
- **A 30-day cutoff for how long old in-game notifications should be kept exists as a
  stated intention, but nothing currently deletes anything** — old notifications
  simply accumulate.
- **A notification type for a periodic "league results" digest is defined but has
  never actually been used** — it's a planned Pro benefit that was never built out.
- **Every country in the game has a "footballing strength" rating attached to it, but
  nothing currently uses it** — when an AI club's home country is chosen, it's picked
  with equal likelihood from the featured list, not weighted by this rating at all.
- **The separate "potential ceiling" a player used to carry is gone.** Improvement is
  now bounded by a single career budget (§3.3) rather than by a second, separately
  growing ceiling. Nothing in the game grows a player's capacity a second time, and
  nothing exposes a potential figure.
- **The old hidden "growth tier" and per-player development-rate multiplier are also
  gone**, for the same reason: they were additional capacity authorities sitting
  alongside the career budget.
- A handful of numbers quoted in earlier design notes turned out slightly different
  from what actually shipped (for example, an illustrative example figure for how
  strong Division 1 players should be) — where this document's numbers disagree with
  an older note, trust this document.

## Authentication (Google-only)

- **The only way to create an account or log in is Google Sign-In** (better-auth,
  `backend/src/auth.ts`). There is no username/password registration or login;
  legacy password accounts were wiped by the `better_auth` migration.
- **The verified Google email is the account key** (`User.email`, unique). The
  Google display name (`User.name`) is the manager identity: it is the default
  coach name when a human joins the world (`POST /api/mp/join` without
  `coachName`), and it is shown in the header and admin user list.
- **Same user across providers**: a future provider (e.g. Facebook) whose
  verified email matches an existing user links to the SAME account
  (better-auth account linking, enabled by default). One person never maps to
  two accounts.
- **Admin by email**: the Google account matching `ADMIN_EMAIL` is promoted to
  admin at every sign-in (promote-only, never demotes).
- **Sessions**: better-auth issues a signed `better-auth.session_token` cookie
  (30-day expiry). WebSocket handshakes read the raw token part of the signed
  cookie. Bans revoke sessions and block new authentication.
- **Invite links**: the token is stashed client-side before the Google redirect
  and redeemed via `POST /api/account/invite/accept` once the session exists
  (friendship creation rules unchanged).

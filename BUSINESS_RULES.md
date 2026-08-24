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

- **Division quality**: divisions form a quality gradient from the very best
  (Division 1) to the weakest, with the average ability level declining smoothly as
  you go down the pyramid, and with some deliberate randomness/spread of talent within
  any one division.
- **Senior signings** are given a target ability level drawn from a bell curve
  centered on their division's average, with a random age between roughly 18 and 38,
  weighted toward the mid-20s.
- **Youth players** get a target ability level based on where they'd expect to land at
  age 21 if they developed naturally from a lower starting point, further boosted by
  "academy pedigree" — a measure of how strong the generating club's division has been
  recently, so stronger clubs tend to produce more promising youth prospects.
- Each new player also receives a hidden, invisible "growth tier" (from a wide range
  down to an unlucky one) that quietly influences how much further their ceiling can
  rise as they develop — this tier is never shown to anyone and can't be inferred from
  anything visible, so a scout can't game it.
- A player's actual seven skills are then shaped, through a short trial-and-improve
  process, to land as close as possible to their intended overall rating for their role.
- There's a small (5%) chance a new player is given a different nationality than the
  club generating them, drawn from anywhere else in the world, so rosters aren't
  entirely homogeneous.
- New rosters follow a standard positional mix: roughly 10% goalkeepers, 14%
  full-backs, 18% center-backs, 32% midfielders, 26% forwards.
- Generation is fully reproducible: regenerating "the same" player (say, after an
  interruption mid-process) always produces the exact same result rather than a new
  random roll.

### 3.3 Growing older: development, growth, and decline

Each player has their own hidden "development profile," set once when they're
generated and never changed: the age at which their decline begins (typically
somewhere between 24 and 38, centered around 30); how fast they develop relative to
other players their age (some players simply improve faster or slower than others
with identical attributes); and how much random week-to-week noise their progress has.

A player's growth or decline in any given period follows a smooth curve: growth is
strongest right after age 18 and fades gradually to nothing by the time their personal
decline age arrives; from that point on, decline accelerates the longer they stay past
it. There is no single universal "peak age" — it's personal to each player, driven by
their own decline age.

How much a player actually improves or worsens in a given stretch also depends on how
much they've been playing: players getting regular minutes develop faster and decline
slower than players warming the bench, based on their playing time over their last
five matches (weighted toward the most recent).

Whatever growth or decline a player is due gets spread across their seven skills in
proportion to how important each skill is to their role (§3.1), with extra weight on
whichever skill their club's training focus targets. A skill can never rise past the
point where the player's overall rating would exceed their personal potential
ceiling, and no skill ever drops below the minimum.

A young player's *potential ceiling itself* also creeps upward over time — fastest for
teenagers, slower through their late teens, and frozen entirely once they turn 21 —
with an extra boost for players who drew a luckier hidden growth tier at generation (§3.2).

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
Value = base value for their overall rating
        × an age multiplier (peaks in the mid-20s, tapers off toward the late teens and late 30s)
        × a small contract-length adjustment (more contract time left is worth slightly
          more, capped at a ±10% swing)
```
The base value itself grows steeply with ability — going from an average player to an
elite one is worth far more than proportionally, since the underlying formula raises
overall rating to a high power. A player's value is recalculated automatically any
time their ability, age, or remaining contract length changes.

A player's **release clause** — the fixed price at which any club can buy them out
unilaterally — is set to half of their remaining nominal wages for the rest of their
contract.

### 3.5 What a player is paid (salary)

Salary follows the same shape as value — it grows steeply with overall ability and is
adjusted by an age curve that peaks in the mid-20s — with a guaranteed floor so no
player, however weak, is paid nothing. Youth academy players are paid a small fraction
(about a tenth) of what an equivalent senior player of their ability and age would earn.

The salary formula's baseline figures are calibrated against a "reference" season
length and automatically rescaled if the game's actual season length is ever
configured differently — so changing how long a season lasts doesn't accidentally
change how much money flows through the game each day.

### 3.6 Renewing a contract

When a club renews a player's contract, the size of the pay raise depends on how good
the player is (better players demand more, and the effect grows sharply once a player
is genuinely elite rather than merely good) and their age (young, developing players
push for much bigger raises than players in their thirties), within a floor of about
2% and a ceiling of about 15% per season.

When a renewal covers several seasons at once, that raise is converted into one flat,
constant salary figure for the whole new deal rather than a rising, compounding one —
which has a quirk worth knowing: renewing right at the very start of a season works
out slightly cheaper per season than renewing right at the end, even though the
earlier renewal actually covers more playing time. This is an intentional, accepted
feature of how the math works, not a bug to be fixed.

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

Unlike an open auction, money paid to sign a free agent doesn't go to any club — it's
paid directly out to the wider game economy, since there's no selling club on the
other side of the deal.

### 6.3 Loaning a player

A club can loan out a player it owns, choosing a fee for whoever eventually borrows
him — somewhere between 10% and 30% of his value — locked in at the moment of
listing. A newly listed loan can't be claimed for the first 30 minutes (giving
everyone a fair chance to see it), and loans are always structured to run through to
the end of the current season. A club can only borrow up to five players on loan at
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

Every club receives a budget once per season, added on top of whatever cash it
already has — it's never a reset to zero. Division 1 gets the largest budget; every
tier below it gets a progressively smaller one, shrinking exponentially as you go down
the pyramid but never falling below 30% of Division 1's figure (both that floor and
the rate of shrinkage are tunable). There's deliberately **no other source of
guaranteed income** — no gate receipts, no ticket sales, no sponsorship — the seasonal
budget plus whatever a club earns on the transfer market is its entire income.

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
financial rescue if needed, §7.4), every player's long-term potential ceiling gets its
periodic nudge upward (§3.3), and any player whose contract has fully run out formally
leaves their club.

Nothing related to aging a full year, retirement, youth academy intake, or
end-of-season awards happens during the regular season at all — those are strictly
end-of-season events, described next.

### 8.3 The end-of-season sequence

At the end of every season, a fixed sequence of steps runs, each one safe to retry on
its own if anything gets interrupted partway through:

1. **Finalize the season**: lock in final standings and permanently archive them
   (including each club's name exactly as it was at that moment), hand out trophies to
   division winners, and calculate end-of-season awards — top scorer, top assister,
   player of the season, and a best XI.
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
   formally release anyone whose contract has now fully expired.
7. **Youth academy intake**: promote any eligible academy prospects up to the senior
   squad, generate a fresh batch of new academy recruits for the season ahead, and top
   up any club whose senior squad has fallen below a healthy minimum size.
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

This rating is deliberately never shown to anyone through the club's public profile or
anywhere else players can see — it exists purely as an internal tool for the
standings tiebreak above, for deciding who gets promoted when several candidates are
tied (below), and for keeping divisions evenly matched when they're rebuilt each
season. It plays no role at all in actually simulating a match (§4.2) — a highly-rated
club doesn't get any direct boost in a match itself; the rating only reflects and
orders past results.

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
removes a club mid-season — it's purely a heads-up that gets acted on only at the next
end-of-season sequence, at which point a still-flagged club is formally marked
dormant, with its squad, finances, and progress completely preserved exactly as they
were, frozen in place. Any renewed activity clears the flag immediately.

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

---

## 13. Admin, Analytics & Pro Features

### 13.1 Behind-the-scenes health monitoring

The game's administrators have access to a diagnostic view comparing the real,
current player population against what the game's own generation formulas would
predict in a perfectly balanced world — average ability by division, financial
distress across clubs, squad sizes, how the mix of positions compares to the intended
template, how actual salaries compare to the formula, the age spread of the whole
population versus a theoretical steady state, and the health of the free-agent pool.
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
- Player potential growth and retirement (§3.3–§3.4) went further than an earlier
  design note suggested they would — both are fully present and active in the game
  today, more so than that note anticipated.
- A handful of numbers quoted in earlier design notes turned out slightly different
  from what actually shipped (for example, an illustrative example figure for how
  strong Division 1 players should be) — where this document's numbers disagree with
  an older note, trust this document.

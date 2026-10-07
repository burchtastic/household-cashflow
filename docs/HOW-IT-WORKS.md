# How it works

This is the specification: what every number on screen means and the rules that produce
it. The forecast logic lives in `src/engine/` and is pure (no database, no clock), so
everything here is covered by `tests/engine.test.ts`.

## The goal

Keep **checking at or above the floor** (Settings → Checking floor, default $500) on every
day, while keeping as little extra cash in checking as possible. Shortfalls are covered by
transfers from savings; surpluses can be swept back. Savings has its own floor (default
$4,000) used for the runway.

## Building blocks

| Thing | What it is |
|---|---|
| **Bill** | A recurring item, in or out, identified forever by a short **code** (`MORT`, `PAY`, `XFER`). History matches on the code, never the name. Schedule: *monthly on day N* (29–31 clamp to month end), *every N days from an anchor date* (bi-weekly pay), or *none* (a type for one-offs only). |
| **Amount mode** | *Fixed*: always the bill's amount. *Auto*: estimated from that code's payments in the lookback window (default 240 days), the average or worst case per Settings, never below the bill's minimum. With no history, the bill's amount. |
| **Transaction** | Something that happened: date, code, amount, direction, note. Imported from your spreadsheet, then recorded here. |
| **Known amount** | An amount entered ahead of time for one occurrence (e.g. the card statement), keyed by month (or by date for interval bills). |
| **One-off** (planned item) | An unscheduled item with a date and amount. Status *planned*, *done* (it has a transaction), or *skipped*. |
| **Balance snapshot** | A checking or savings balance on a date, entered by hand. |
| **Note** | Free text on an upcoming occurrence (kept when it's paid), a transaction, or a one-off. |

## The forecast

1. **Start from the latest checking balance.** Anything dated **on or before** that
   balance's date is assumed to already be in it, so it doesn't move the forecast.
   *(This is why the date on an entry matters: a $500 expense dated before the balance
   date changes nothing unless you also say the balance doesn't include it; see One-offs.)*
2. **List every scheduled occurrence** of each active bill, from 45 days before the
   balance date through the horizon (default today + 60 days).
3. **Match each occurrence to a real payment** with the same code, within ±15 days
   (monthly) or about half the interval (bi-weekly pay: ±6 days). Each payment matches at
   most one occurrence. A matched occurrence is *posted* at the payment's real date and
   amount.
4. **Otherwise** it uses the known amount if one is set, else the bill's estimate.
5. **Add** one-offs still *planned*, and any recorded transaction that didn't match an
   occurrence (including done one-offs, on their own date).
6. **Walk the days forward.** Within a day, money in comes before money out, then the Bills
   table's order. The result is an end-of-day balance for every day.

### Statuses

| Chip | Meaning | Amount shown |
|---|---|---|
| **✓ Paid / ✓ Received** | Posted: it happened. | Real amount |
| **✓ Set up** | Posted, but dated in the future: e.g. a transfer you've scheduled at the bank. Counted on its date. | Real amount |
| **known** | You entered the amount ahead of time. | Known amount |
| **scheduled** | A fixed-amount bill not yet paid. | Fixed amount |
| **estimated** | An auto bill not yet paid: a guess from history. | Grey |
| **planned** | A one-off not yet done. | Planned amount |

### Advice (the Dashboard decision card)

- **Transfers needed:** looking from today forward, at the first day checking would dip
  below the floor, move enough to cover the lowest point of the **following two weeks**,
  rounded **up** to Settings → Round transfers (default $50). Then repeat for later dips.
  Transfers come in pay-cycle-sized chunks instead of daily slivers. Shown as *Move $X from
  savings by date*, with any later ones listed.
- **Trim the next draw:** if a transfer from savings is already planned (codes in
  `savingsDrawCodes`, default `XFER`) and checking would still clear the floor with less,
  the card offers **Change plan to $X** or **Skip it**. Trimming lowers every day from the
  draw's date onward by the same amount, so the slack is the lowest balance from that date
  on, minus the floor, rounded **down**. Shown only for at least $100.
- **No transfers needed:** checking clears the floor through the horizon.
- **Sweep to savings:** only when *not* drawing from savings (no planned draw and no
  ongoing monthly shortfall): the amount that could leave today and still clear the
  lowest future point. It is never suggested while savings is covering a shortfall.

Past days never affect the advice: the lowest point and transfers look only from today.

### Never below $0

Overdrawing checking is the outcome this app exists to prevent. If any day from today on
goes below $0, the Dashboard shows it everywhere at once:

- **Banner:** a solid red banner at the top gives the day it goes negative, how low it
  gets, and the least to move from savings before then. It also gives the amount that
  clears the floor too.
- **Chart:** the area below $0 is shaded red, and the line turns red there.
- **Tile:** the Lowest point tile is outlined in red.
- **Ledger:** every row with a negative balance is highlighted and marked ⚠.

All of it clears as soon as a fixing transfer is added under One-offs.

### Bank matching

Each sync, the checking account's activity (from the day after its bank was connected) is
matched to what the ledger expects, **by amount**:

- A payment out, or a deposit in, within the item's usual date window (±15 days for monthly
  bills, ±7 for one-offs) that is **at most the expected amount and no more than 10% under
  it** marks that item paid or received. Expected means the known amount if there is one
  (such as a card statement), else the estimate. Closest amount wins, then closest date.
- If you already marked it paid by hand, the bank transaction is linked to your entry
  instead of adding another.
- Pending transactions count. When one posts, the entry follows it; if it disappears
  without posting, the entry goes (a one-off goes back to planned).
- Anything that matches nothing is listed under **To review** on the Dashboard. **File** it
  under any code (with an optional note), or **Dismiss** it. Deleting an automatic match
  sends that bank transaction to review instead of matching it again.
- Credit card purchases are never matched one by one; the card's statement covers them.

### Bank balance check

When a bank account is set as **Checking** (or **Savings**) on Bank connections, the
Dashboard compares the bank's balance with the ledger's for today. Checking uses the
bank's *available* balance, which already takes out pending charges. If they differ, a
notice shows both and the difference, and lists anything due by today that isn't marked
done yet, since the bank may not have it. **Use the bank's balance** records it as today's
balance: the same as typing it in, so everything dated today or earlier counts as done.
**Dismiss** hides the notice until either figure changes. Nothing is replaced automatically.

### The chart

The chart is a step line of the end-of-day balance, from 14 days back (faded) to the
horizon. It shows the floor and its red zone, today, and the low point.

**Transfers in from savings** (codes in `savingsDrawCodes`) are marked in teal: a dotted
line on the day and a label such as "↑ $1,450 from savings". Paychecks and other items
aren't marked. Hovering over a day lists what happens on it.

### Savings runway

Savings today = the latest savings balance minus savings draws recorded after it.
Runway = (savings today − savings floor) ÷ the forward schedule's average monthly
shortfall, ignoring the draws themselves. No shortfall means no runway date.

## Using it

### Marking things paid

The Dashboard offers **Paid… / Received…** on anything already due and on the next
occurrence of each item up to **14 days ahead**. It won't let you mark bills paid months in
advance. Confirming records a transaction with the real date and amount and carries the
occurrence's note over.

A payment **set up with the bank ahead of time** (e.g. the mortgage scheduled for the 15th)
can be marked with a future date, up to its due date: the button reads **Paid / set up…**.
It shows as **✓ Set up** and counts on that date; when it lands, the bank sync links it.
Income can only be marked once it has arrived.

**Planned** one-offs show a gold chip. The pencil next to one edits it (date, amount, type,
note) or deletes it, right on the Dashboard.

### Amounts

- **Fixed** items have a pencil to edit this occurrence's amount and note.
- **Estimated** items have **Set amount** to enter the known amount (e.g. the statement
  balance).
- Leaving a scheduled amount unchanged doesn't create a known amount; it just saves the
  note.
- **Card statements fill these in.** On Bank connections, each credit card picks the bill
  that pays it. Each sync, the card's latest statement balance becomes the known amount for
  that bill's scheduled payment nearest the statement's due date (within the bill's
  matching window). Cards paid by the same bill are added together. An amount you typed in
  yourself is never overwritten. If you clear one that came from a statement, the next sync
  sets it again; unlink the card from the bill to stop that.
- **Never below what's already on the card.** For a card linked to its bill, the bill's
  next payment that has no known amount yet is never estimated below the charges already
  on the card: Plaid's current balance, less any statement not yet paid (that one is due
  first). When this raises an estimate, the row says so in amber: *"est. $3,000 · raised:
  $4,000 already on the card"*. It still shows as an estimate.

### One-offs

- **Add expense** and **Add income** open the same quick form. Amount first; **What was it?**
  autocompletes from past notes. Picking a past one fills in its type (and amount, if
  empty).
- **Type** chips are the schedule-less bills for that direction, most-used first.
  **+ New type** creates one on the spot.
- **When:** Today, Yesterday, or a date.
- **Already happened** logs it as done in one step.
- **Already set up with the bank** (future dates): saves it done on its own date, shown as
  ✓ Set up, and counted on that date.
- **Is it already in your balance?** For a done item dated on or before the latest
  checking balance, the form asks. If the balance doesn't include it yet, the app adds a
  new balance snapshot on the same date, adjusted by the amount, so the forecast moves.
- **Done** on a planned item records it on **its own date**, not today. Deleting a done
  one-off also deletes its transaction.

### Editing what's recorded

- **Where:** anything already recorded (✓ Paid, ✓ Received or ✓ Set up) has a pencil on
  the Dashboard, in History, and under One-offs → Done.
- **What:** the pencil changes the date, amount or note. A one-off and its transaction
  always change together.
- **Set up for later:** History's date ranges end today, so transfers set up for later
  get their own section at the top of History.
- **Undo:** on the Dashboard, Undo removes the record instead.

### Notes

Add a note to an upcoming occurrence in its Edit dialog ("plumbing repair" on a big card
bill). It stays with the payment when you mark it paid and shows in History, where any
note can be added or edited inline.

### History

A date range picker with presets (Today, Last 7/28/30/90 days, This/Last month, Last
12 months, This/Last year…) and a two-click calendar for custom ranges. Defaults to the
last 90 days. Category totals for the range sit alongside.

## Demo mode

**Settings → Demo mode** disguises every amount, for showing the app to someone. Paychecks
show at about 70%, card bills 50%, housing 75%, and everything else (balances, other bills,
floors) 60%, each nudged by a small fixed amount per bill or account so the real figures
can't be worked out. The forecast runs on the disguised numbers, so everything still adds
up. Bank activity shows categories instead of merchants, account numbers are hidden, and
the bank balance check is off. Notes keep their text.

It's for that browser only (a cookie): another device keeps showing the real numbers. While
it's on, a DEMO banner shows at the top and nothing can be changed, so disguised numbers
can never be saved. **Turn off** in the banner or in Settings.

## What changed from the spreadsheet

- Runway ignored the current window's savings draws, so it overstated the cushion.
- "Lowest point" included past days, so "safe to sweep" stuck at $0.
- Manual roll-forward, the M1/M2/M3 grid, Apps Script archiving, and slot caps (16 bills,
  15 one-offs, 95 events) are gone.

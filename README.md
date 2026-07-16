<div align="center">
    <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/blindmikey/spendwise/main/docs/spendwise.svg">
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/blindmikey/spendwise/main/docs/spendwise-light.svg">
        <img alt="Spend Wise" height="64" src="https://raw.githubusercontent.com/blindmikey/spendwise/main/docs/spendwise-w-bg.svg">
    </picture>
    <div><a href="https://www.npmjs.com/package/@blindmikey/spendwise"><img alt="npm" src="https://img.shields.io/npm/v/%40blindmikey%2Fspendwise?label=npm&color=009967"></a></div>
    <h2>A Simple and easy-to-use envelope-budgeting app.</h2>
    <div><a href='https://ko-fi.com/G0G2231VF9' target='_blank'><img height='36' style='border:0px;height:36px;' src='https://storage.ko-fi.com/cdn/kofi3.png?v=6' border='0' alt='Buy Me a Coffee at ko-fi.com' /></a></div>
    <div><span>&nbsp;</span></div>
</div>

<div align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/blindmikey/spendwise/main/docs/screenshot-light.png">
        <img alt="Spend Wise" src="https://raw.githubusercontent.com/blindmikey/spendwise/main/docs/screenshot-light.png">
    </picture>
</div>

Spend Wise is envelope budgeting that runs where you
want it - as a desktop app, or as a small server you host yourself and reach
from any browser. Same app, same single data file.

**No account. No cloud. No subscription. No telemetry.** Your finances are a
JSON file on your own disk, and the app works with the network unplugged.

The one request it ever makes is a public read of this project's latest release
tag, so it can tell you an update exists - no identifier, nothing about your
money, and one checkbox in Settings turns it off for good.

## What it does

**Budget in envelopes.** Each budget is a little savings account: it gets a
monthly allotment, and unspent money stays in it. Groceries left over in May is
still there in June - no zeroing out, no starting over.

**Spending flows in on its own.** Assign an expense to an envelope and it draws
from that balance instead of counting against the month twice. Every envelope
shows what's left at a glance: a full green line when untouched, amber when it's
nearly gone, red when it's overdrawn.

**Save up for the big, irregular stuff.** Goal budgets fill toward a target -
the annual insurance bill, a vacation - and stop contributing once they're full.
Give one a due date and it works out the monthly deposit for you. Spend from it
and contributions resume automatically.

**Fund budgets from a percentage.** Point an envelope at other groups and it
takes a cut of them, live - freelance tax savings at 33% of self-employment
income minus expenses, recalculated as you type and carried forward every month.

**Close out the month** when you're done: balances roll over, recurring lines
copy forward, savings gets a snapshot, and next month is waiting for you.

**See where it actually went.** Tag anything; the Insights view turns those tags
into spending and income trends, per-tag averages, and your savings trajectory
over the years.

**Budget together.** Two people editing the same month merge field by field
rather than one clobbering the other - you both keep your edits.

**Change your mind later.** Past months are view-only until you unlock them.
Edit one and every later month's balances and savings history recompute
correctly, after taking a backup and showing you exactly what changed.

## Install

### Desktop Releases

Grab the latest Windows installer or portable `.exe` from
[Releases](https://github.com/blindmikey/spendwise/releases). That's the whole
setup - it keeps its database in `%APPDATA%/Spend Wise/db.json`.

On macOS or Linux, run it from source (see
[docs/development.md](docs/development.md)) or host the web version below.

## Web Version

### NPM

If NPM is your thing - Electron is never installed, just one process owns the
database, so everyone editing through it merges cleanly.

```bash
npm i -g spendwise
spendwise-server --set-password   # everyone signs in with this
spendwise-server                  # → http://localhost:4180
```

### Docker

Or with Docker:

```bash
docker build -t spendwise .
docker run -d --name spendwise -p 4180:4180 \
  -v /srv/spendwise:/data -e FINANCES_PASSWORD=change-me spendwise
```

The server speaks plain HTTP and has no TLS of its own. On a LAN that's fine;
before putting it on the internet, read
**[docs/hosting.md](docs/hosting.md)** - reverse proxy configs for Caddy, nginx
and Apache, every setting, and an account of the security model.

### No server? No problem.

The desktop app can share itself. Set an app password, flip on **Web access**,
and phones and laptops on your network open the printed URL and edit the same
live data - until you close the app.

## Docs

- **[Hosting](docs/hosting.md)** - self-hosting, Docker, reverse proxies, TLS, configuration, security model.
- **[Development](docs/development.md)** - how the money math works, architecture, scripts, tests.

## License

MIT - see [LICENSE](LICENSE).

Icons are [Font Awesome Free](https://fontawesome.com) (CC BY 4.0).

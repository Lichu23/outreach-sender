# Outreach Sender

Paste a list of emails, write one message, and press start. It sends a separate plain-text email to each person, one at a time, from your own email account.

It runs only on your computer, at `http://localhost:4310`.

## Run it

Needs Node.js 22.9 or newer.

```bash
npm install
npm start
```

It starts in **practice mode**, so nothing is sent. Use this to try the whole flow.

## Send real emails

1. Copy `.env.example` to `.env`.
2. Fill in your name, email and SMTP settings.
3. Set `DRY_RUN=false`.
4. Restart with `npm start`. The top of the page will say **Live**.
5. Press **Send test to myself** and check your inbox and spam folder.

**Gmail:** turn on 2-Step Verification, create an [App Password](https://myaccount.google.com/apppasswords), and use it as `SMTP_PASS`. Don't use your normal password. Cold email from a personal Gmail account can get that account restricted, so a separate address on your own domain is safer, with SPF, DKIM and DMARC set up.

Never commit or share `.env`. It's in `.gitignore`.

## How it works

- **Pasting:** accepts commas, spaces, new lines, `Name <email>` and rows copied from `leads-argentina.md`. Duplicates are removed and invalid addresses are shown separately.
- **Pace:** one email every 90-150 seconds, up to 20 a day. If the list is longer, it continues the next day as long as the app stays open. You can raise the daily limit to at most 50 in `.env`.
- **No repeats:** anyone you've really emailed is skipped from then on. Practice runs don't count.
- **Opt-out:** every email ends with your name and a line telling people to reply BAJA to stop.
- **Safety stops:** it pauses at once if your login is rejected, and after 3 failures in a row.
- **Restarts:** the send pauses until you press Resume. An email that was mid-send is never retried.

## See what you've sent

Open the **Sent** tab. Every send is saved with its category, subject and message, so **New send** no longer erases anything.

- **Categories:** each send needs one. Pick Cafés, Dentists or Barbershops, or type your own. Spellings like `cafes` and `Cafés` count as one category.
- **Filter and search:** click a category or search by email. Practice runs stay hidden unless you tick **Show practice runs**.
- **See the message:** click an email to see exactly what that person received, or why it failed.
- **Results:** the app can't read your inbox, so set the Result dropdown yourself when someone replies. The summary then shows how many in that category were interested.

## What it doesn't do

- **It doesn't read your inbox.** Replies go to your normal email. When someone replies, set the result in the Sent tab. If they reply BAJA, or an address bounces, add it to the do-not-contact list yourself.
- **It doesn't send follow-ups or personalize messages.** Everyone gets the same text.
- **It doesn't track opens.**

Your data is in `data/state.json`, which holds your sent history and do-not-contact list. Deleting it means the app forgets who you've already emailed.

## Before you send

Check the rules for where you and your recipients are. Argentina's Ley 25.326 (art. 27) covers advertising use of contact data, but how it applies to cold business email is not confirmed here. This is not legal advice.

## Tests

```bash
npm test
```

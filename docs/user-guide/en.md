# Kesher – User Guide

*Deutsche Fassung: [de.md](de.md)*

This guide is for everyone who uses Kesher during a service or an event:
audio, lighting, video, camera, stage, production. No technical knowledge is
needed.

- **Part A** explains how to use it – for everyone who talks on Kesher.
- **Part B** is for the person who sets Kesher up and looks after it (tech
  lead).

Labels are written exactly as they appear on screen, e.g. **"Hold to talk"**.

---

## Contents

**Part A – Using Kesher**

1. [What is Kesher?](#1-what-is-kesher)
2. [Key terms](#2-key-terms)
3. [Which device can I use?](#3-which-device-can-i-use)
4. [Connecting and logging in](#4-connecting-and-logging-in)
5. [The main screen](#5-the-main-screen)
6. [Talking](#6-talking)
7. [Listening and volume](#7-listening-and-volume)
8. [Calling and answering calls](#8-calling-and-answering-calls)
9. [Chat](#9-chat)
10. [The simple view (phone)](#10-the-simple-view-phone)
11. [Settings](#11-settings)
12. [Stream Deck](#12-stream-deck)
13. [Raspberry Pi station](#13-raspberry-pi-station)
14. [Tips for live use](#14-tips-for-live-use)
15. [When something doesn't work](#15-when-something-doesnt-work)

**Part B – Setting up and managing**

16. [Installing the server](#16-installing-the-server)
17. [First-run setup](#17-first-run-setup)
18. [The admin area](#18-the-admin-area)
19. [Setting up roles and party lines](#19-setting-up-roles-and-party-lines)
20. [Approving stations and Stream Decks](#20-approving-stations-and-stream-decks)
21. [Backup, PIN and other settings](#21-backup-pin-and-other-settings)
22. [Network – what the tech lead needs to know](#22-network--what-the-tech-lead-needs-to-know)

---

# Part A – Using Kesher

## 1. What is Kesher?

Kesher is an **intercom system**: the tech team uses it to talk to each other
during an event – like walkie-talkies, but over your existing network (wired
or Wi-Fi).

- You listen and talk through a **headset** (headphones with a microphone).
- You talk on **party lines** (talk channels) such as "FOH" or "Stage", or
  **directly** with one person.
- You can use Kesher in a **browser**, in the **desktop app**, on a **phone**,
  with a **Stream Deck**, or at a fixed **Raspberry Pi station**. Everyone
  hears everyone, whatever device they use.

## 2. Key terms

| Term | Meaning |
| --- | --- |
| **Party line** | A talk channel for a group, e.g. "FOH", "Stage", "Livestream". If you listen, you hear everyone who talks on it. |
| **Role** | Your job, e.g. "Audio", "Video", "Camera". Your role decides which party lines you may talk and listen on. Several people can share a role. |
| **Direct talk** | You talk to exactly one person. Only they hear you. |
| **Broadcast channel** | One button that talks on several party lines at once – for announcements to everyone, e.g. "All Tech". |
| **Call** | A signal to get someone's attention – like a doorbell. It flashes yellow. |
| **Push-to-talk** | You only talk while you hold the button down. This is the normal way. |
| **Always on** | Your microphone stays open, without a button. |
| **Place** | The device you are at (this browser, this desktop app, this station). A Stream Deck belongs to a place, not to a person. |

### What the colors mean

Every color in Kesher has exactly one meaning – on screen and on the Stream
Deck:

| Color | Meaning |
| --- | --- |
| 🟢 **Green** | You hear something / someone is talking |
| 🔴 **Red** | **Your microphone is on air.** A red frame means: this line is selected for talking. |
| 🟡 **Yellow** | Someone is calling |
| 🟠 **Orange** | Attention, a problem (e.g. no microphone) |
| 🔵 **Cyan** | Selection only, never a status |

Rule of thumb: **red = people can hear you.**

## 3. Which device can I use?

| Device | Good for | Note |
| --- | --- | --- |
| **Desktop app** (Windows, Mac) | Fixed positions: audio, video, lighting, production | Best sound, lowest delay. **Recommended.** |
| **Browser** (Chrome, Edge, Firefox, Safari) | When no app is installed | Works everywhere, a little more delay |
| **Phone / tablet** (browser) | Camera, stage, anyone moving around | Always push-to-talk; best added to the home screen |
| **Raspberry Pi station** | Fixed places without a screen, e.g. side stage | Plug in the headset, done. Set up by the tech lead |
| **Stream Deck** | Fast keys instead of a mouse | In addition to the app or browser |

**Headset:** use a headset with a microphone whenever possible. With speakers
and a room microphone the others hear themselves as an echo.

## 4. Connecting and logging in

### 4.1 In a browser

1. The tech lead gives you the address, e.g. `https://192.168.1.50:8443`.
2. The first time, the browser shows a **security warning** (the certificate
   is self-made). That is normal on your own network:
   - Chrome/Edge: **"Advanced"** → **"Proceed to … (unsafe)"**
   - Firefox: **"Advanced…"** → **"Accept the Risk and Continue"**
   - Safari/iPhone: **"Show Details"** → **"visit this website"**
3. When the browser asks whether Kesher may use the **microphone**: **Allow**.

> Important: the address must start with **https**. With `http://`, browsers
> on other devices do not allow the microphone.

### 4.2 In the desktop app

On start the app shows the screen **"Server-Verbindung einrichten"** (this
screen is in German).

- Under **"Im Netzwerk gefunden"** (found on the network) the Kesher server
  usually appears by itself. Click **"Verbinden"** (connect).
- If nothing appears: click **"Erneut suchen"** (search again). If that does
  not help, type the address the tech lead gives you into
  **"Server-Adresse"** (e.g. `192.168.1.50:8080`) and click
  **"Speichern und verbinden"** (save and connect).
- The app remembers the address; next time it is already filled in.
- To change it later: click **"Netzwerk"** at the top of the app.

### 4.3 On a phone

Same as the browser (4.1). Afterwards it is best to **add Kesher to the home
screen** (iPhone: Share icon → "Add to Home Screen"; Android: menu ⋮ → "Add to
Home screen"). Sound then keeps running more reliably while the screen is off.

### 4.4 Logging in

There are no passwords. On the login page:

1. **"Display name"** – your name as others see it, e.g. `Tim` or `TimFOH`.
   Spaces are removed automatically.
2. **"Role"** – choose your job, e.g. "Audio".
3. Click **"Join Intercom"**.

**"Role currently in use":** some roles may only be used by one person at a
time (e.g. "Producer"). If it is taken, Kesher asks. **"Confirm takeover"**
takes over the role – the other person is logged out. **"Cancel"** stops.
Only take over when it has been agreed.

**Logging out:** click the **lock icon** at the top right ("Log out and
lock").

## 5. The main screen

After login you see the **station view**. It has these areas:

```
┌──────────────────────────────────────────────────────────────┐
│ ● Tim  Audio · connected   [mic status]          ⚙  🔒        │  top bar
├────────────────────────────────────────┬─────────────────────┤
│ Talk channels   (party lines)          │ Chat                │
│ Direct communication   (people)        │                     │
│ Broadcast channels                     │                     │
├────────────────────────────────────────┴─────────────────────┤
│ [Reply to caller]   [Hold to talk]   Always on ○              │  talk bar
└──────────────────────────────────────────────────────────────┘
```

### Top bar

- **Dot and name:** your name, below it your role and the connection state
  ("connected").
- **Mic status:** shows whether your microphone is on air (**"On air"**,
  red), off (**"Mic off"**) or has a problem (**"Mic problem"**, orange). The
  bar shows your level. Clicking it opens the sound settings.
- **Gear** ("Settings"): settings.
- **Lock** ("Log out and lock"): log out.

### Connection notice

If the connection drops for a moment, a notice appears at the top:
**"Reconnecting..."** or **"Connecting..."**. Kesher reconnects by itself –
you don't need to do anything. If it says **"Offline"**, you were logged out
(e.g. because someone took over your role). Log in again.

### "Talk channels" – the party lines

Each party line has a card with its name and its state below:

| Shows | Meaning |
| --- | --- |
| **On air** | You are talking on this line |
| **Tim is talking** | Someone is talking (green) |
| **Selected for talk** | This line is selected for talking (red frame) |
| **Listening · 4** | You are listening; 4 people listen on this line |
| **Always listening · 4** | You always listen – the tech lead set it that way |
| **Not listening** | You are not listening right now |
| **Talk only** | You may only talk here, not listen |
| **No access** | Your role may not use this line |

Below each card are small buttons:

- 🎧 **Headphones** ("Listen"): listening on/off.
- 🔔 **Bell** ("Call"): call everyone on this line.
- 📌 **Pin** ("Add to favorites"): mark as a favorite.
- **"0 dB"**: volume of this line (see chapter 7).

A letter next to the name shows how important the line is: **L** = low,
**H** = high, **C** = critical. Normal lines have no letter.

### "Direct communication" – people

Everyone else who is logged in, sorted by role. Hold a person to talk to them
only (chapter 6).

### "Broadcast channels"

Only shown if broadcast channels exist. They talk on several party lines at
once, e.g. an announcement to everyone ("All Tech"). **"RX"** means you are
receiving such an announcement right now.

## 6. Talking

### 6.1 Talking on a party line (normal)

1. **Select the line:** click the party line's card once. It gets a red frame
   ("Selected for talk"). Only **one** line is selected at a time – a new
   selection replaces the old one. After login your role's default line is
   often already selected.
2. **Talk:** **hold** the **"Hold to talk"** button at the bottom and speak.
   The card turns red ("On air").
3. **Let go** when you are done. The microphone closes immediately.

Instead of the mouse you can use the **space bar**: hold = talk. (You can
change the key, see 11.2.)

> Tip: if you prefer pressing the card directly, turn on **"Hold a party line
> to talk on it"** in the settings. You then talk while you hold a line's
> card.

### 6.2 Talking directly to one person

Under **"Direct communication"**, **hold** the person's card and speak. Only
that person hears you; their screen shows "Talking to you".

### 6.3 Answering ("Reply to caller")

When someone has called you or talked to you directly, the **"Reply to
caller"** button shows their name. **Hold** it and you answer exactly that
person without looking for them. "No active caller" means nobody has
addressed you yet.

### 6.4 Announcements on several lines

Under **"Broadcast channels"**, **hold** the channel and speak. If it is
greyed out, your role may not use it.

### 6.5 Open microphone ("Always on")

With the **"Always on"** switch at the bottom your microphone stays open
without a button. Only useful if you must talk constantly (e.g. the director
during a broadcast).

- Turn it off again when you are not talking – otherwise everyone hears your
  background noise.
- On **phones and tablets** there is no open microphone; you always use
  push-to-talk there.
- If you hold a person's card while "Always on" is active, the open
  microphone pauses briefly and comes back afterwards.

## 7. Listening and volume

- **Listening on/off:** click the 🎧 headphones below a party line. Green
  means you are listening.
- With **"Always listening"** you cannot switch listening off – the tech
  lead decided this line is important.
- **Volume of a line or a person:** click the dB value (e.g. "0 dB") below the
  card. A fader appears. **Double-click** the fader to reset to 0 dB. This
  setting only applies on this device.
- Set the **overall volume** as usual on your computer, phone or headset.

**Favorites:** use the 📌 pin to mark lines and people you need often. Turn on
**"Only favorites"** in the settings and you see only those – handy when
things get busy.

## 8. Calling and answering calls

- **Calling someone:** click the 🔔 bell below a party line (calls everyone on
  it) or below a person (calls only them).
- **When you are called:** the screen briefly flashes yellow with
  **"Incoming group call"** (a call on a party line) or
  **"Incoming direct signal"** (a call to you personally), plus the name.
- **Answering:** hold **"Reply to caller"** and speak.

## 9. Chat

On the right is the **chat** for short text messages – useful when you can't
talk (e.g. camera during a quiet moment).

1. Under **"To"**, choose who gets the message: your talk line (default),
   another party line, one person or a whole role.
2. Type the message. Shortcut: **@** plus a name for a person or role, **#**
   for a party line. Kesher suggests names; pick with the arrow keys and
   **Enter**.
3. Press **Enter** or click send.

- New messages appear **at the top**.
- Click a sender's name to reply to that person.
- **"Confirm"** (if enabled): asks the recipient to confirm they read it. You
  then see **"Waiting for confirmation"** or **"Confirmed by …"**. If you get
  such a message, click **"Confirm"**.
- **"Not delivered: …"**: the message did not arrive, e.g. "nobody in this
  role is online". Your text is put back in the field.
- You see messages on party lines you listen to and all messages to you.

## 10. The simple view (phone)

For some roles (e.g. "Camera") Kesher shows a **simple view** with big
buttons, made for phones:

- **"Hold to talk"** – hold to talk. Below it you see which line you talk on.
- **"Reply to caller"** – hold to answer whoever addressed you last.
- **"Microphone"** / **"Speaker output"** – choose microphone and speaker.
- **"Background audio assist"** – keeps sound running while the screen is
  off. Leave it on.
- **"Keep device awake while connected"** – keeps the screen on.
- **"Logout"** – log out.

The tech lead decides per role whether you get the simple or the full view.

## 11. Settings

The **gear** at the top right opens the settings. They only apply on this
device. Close with **X**, **Esc** or by clicking outside.

### 11.1 "Sound" – microphone and speaker

**Microphone**

- **"Device"** – which microphone (choose your headset).
- **"Level"** – shows your level while you talk. If it says **"Too loud:
  lower the gain"**, it is too loud.
- **"Gain"** – microphone louder/quieter. Double-click resets to 0 dB.
- **"Hear yourself"** – you hear yourself in the headphones. Ideal for placing
  the headset microphone in front of your mouth and setting the level. Put on
  headphones first! Stop with **"Stop test"**.
- **"Noise gate"** – mutes quiet background noise between words. Helpful in
  loud places. The **"Opens above …"** slider sets how loud you must be for the
  microphone to open. Too high and the start of words gets cut off.

**Speaker**

- **"Device"** – choose headphones or speakers. (Some browsers always play
  through the system default device.)

**Performance audio** (desktop app only)

- Shows microphone, speaker and settings of the fast audio engine.
- **"Device access"** (Windows): normally leave it on **"Automatic (lowest
  latency)"**. If sound stutters, choose **"Shared low latency (WASAPI)"**.
  With **"Exclusive"** no other program can use the headset at the same time.
- **"Measure latency"** measures the delay: hold the headset speaker to the
  microphone and click – the result appears as "Mouth-to-ear".

### 11.2 "Controls"

- **"Hold a party line to talk on it"** – on: hold a card = talk on that line.
  Off (default): tapping a card selects the line, you talk with "Hold to
  talk".
- **"Talk button first"** – swaps "Hold to talk" and "Reply to caller" in the
  bottom bar.
- **Keyboard shortcuts:**
  - **"Push to Talk (room)"** – hold to talk. Default: **space bar**.
  - **"Toggle Always On"** – open microphone on/off. Default: not set.
  - Change with **"Set"**, then press the key you want (Ctrl/Alt/Shift
    combinations work). **"Clear"** removes it.
  - While you type in a text field (e.g. chat), shortcuts are off.

### 11.3 "View"

- **"Only favorites"** – show only pinned lines and people.
- **"People in tabs by role"** – group people into one tab per role (handy
  with many people).
- **"Volume on each card"** – show the dB value on each card.

### 11.4 "Device"

- **"Keep audio running in the background"** – sound keeps running when the
  screen is off or another app is open. Leave it on.
- **"Keep the screen on"** – the device doesn't go to sleep.
- The version and device details are at the bottom – useful when you report a
  problem to the tech lead.

### 11.5 "Stream Deck"

See the next chapter.

## 12. Stream Deck

An **Elgato Stream Deck** is a keypad with a small screen on every key. With
Kesher you can put keys for lines, people and calls on it.

### 12.1 Connecting

- **With the desktop app:** just plug a Stream Deck **MK.2** (15 keys) into
  the PC – it works right away. Close the Elgato Stream Deck software first;
  only one program can use the deck.
- **With Bitfocus Companion** (other models, or if Companion runs anyway): the
  tech lead sets up Companion. The deck then shows a **4-digit code**. Enter it
  in the settings under **Stream Deck** in **"Code"** and click
  **"Pair deck"**.

The Stream Deck belongs to **your place**, not to you. It always controls
whoever is logged in at that device and keeps its key layout.

### 12.2 Setting up keys

Settings → **Stream Deck**:

1. Click a key in the grid.
2. Under **"What it does"** choose a kind first, then the function:

   | Kind | Function |
   | --- | --- |
   | **Party line** | **Talk** (hold = talk), **Listen on / off**, **Call** |
   | **Person** | **Talk** – hold = talk to this person only |
   | **Role** | **Talk** – hold = talk to everyone with this role |
   | **Group** | **Announce** – hold = announcement on all lines of the group |
   | **Calls** | **Reply** (answer the last caller), **Show incoming calls** (shows who calls) |
   | **Microphone** | **Open mic on / off**, **Louder / Quieter** |
   | **Pages** | Next/previous/first page, open a folder |
   | **Nothing** | The key stays empty |

3. Under **"How it looks"** optionally set a **name**, a second line and a
   **frame color**. (Red, green and yellow are reserved for talking, hearing
   and calls.)

More:

- **Swap keys:** drag a key onto another.
- **"Copy" / "Paste" / "Clear"** for single keys.
- **Pages:** add pages with **"+"**. A page can fill itself: under **"Keys"**
  choose **"All party lines"** or **"All roles"**.
- **Folders:** via "Open a folder or page" → "New folder…". Key 1 in a folder
  is always **"Back"**.
- **"Try keys here"** – try the keys on screen.
- **"Undo"** – undo recent changes.
- Changes are **saved automatically** ("All changes saved").
- Under **"More"**: **export/import** the layout or **"Reset layout"**.

### 12.3 What the keys show

| Key shows | Meaning |
| --- | --- |
| Red fill | Your microphone is on air |
| Red frame | Your selected talk line |
| Green bar at the bottom | You hear this line |
| Yellow, blinking | Someone is calling |

## 13. Raspberry Pi station

A station is a small computer with a headset at a fixed place – without a
screen. The tech lead sets it up (chapter 20).

- **Plug in the headset, done.** The station logs in by itself.
- If the station has a **talk button**: hold = talk (or, depending on the
  setting, microphone on/off).
- The **LED** shows the state:

  | LED | Meaning |
  | --- | --- |
  | slow blink | No server found |
  | double blink | Waiting for approval by the tech lead |
  | off | Ready, microphone closed |
  | on | You are talking |

## 14. Tips for live use

- **Test before the service:** log in, check the microphone with **"Hear
  yourself"**, talk once on your line and ask whether you're heard.
- **Press, then speak:** press the button, wait a moment, then talk –
  otherwise the first word gets lost.
- **Short and clear:** "Camera 2 to audio: pastor's mic is muted." – who, to
  whom, what.
- **Let go** when you are done. Red means everyone hears you.
- **During the sermon/host segments** only say what is necessary; use the chat
  for anything else.
- **Direct instead of a line** when it only concerns one person – the others
  are not disturbed.
- **Charge** phones and wireless headsets beforehand.

## 15. When something doesn't work

| Problem | Fix |
| --- | --- |
| **"Mic problem" / "No microphone found"** | Headset plugged in? Choose the right microphone in Settings → Sound. In the browser, allow the microphone (lock icon next to the address). |
| **Browser never asks for the microphone** | The address must start with **https://**. |
| **I hear nothing** | Headphones 🎧 active (green)? Line volume not all the way down? Right speaker in Settings → Sound? Device volume? |
| **Others don't hear me** | Right line selected (red frame)? Does the display turn red ("On air") when you talk? Check the level in Settings → Sound. Is the noise gate set too high? |
| **Others hear an echo** | Use a headset instead of speakers. |
| **Card greyed out / "No access"** | Your role may not use this line. Ask the tech lead. |
| **"Reconnecting..."** | Wait a moment; Kesher reconnects by itself. If it takes long, check the Wi-Fi. |
| **"Offline"** | You were logged out (e.g. role taken over). Log in again. |
| **"Keine Verbindung zum Backend"** (desktop app, "no connection to the server") | The server isn't running or the address is wrong. **"Erneut versuchen"** (try again) or **"Server-Adresse aendern"** (change server address). |
| **Sound stops when the phone is locked** | Add Kesher to the home screen; leave "Keep audio running in the background" on. |
| **Desktop app: sound stutters** | Settings → Sound → Device access: **"Shared low latency (WASAPI)"**. |
| **Stream Deck does nothing** | Close the Elgato software. With Companion: enter the code ("Pair deck"). |
| **Sound is delayed** | Use the desktop app instead of the browser; use a cable instead of Wi-Fi if possible. |

If nothing helps: ask the tech lead and give them the version number from
Settings → Device.

---

# Part B – Setting up and managing

This part is for the person who sets Kesher up and looks after it. You don't
need to program, but you need to be able to type a few commands.

## 16. Installing the server

Kesher needs **one server** on the network. All devices connect to it.

| Option | When |
| --- | --- |
| **Linux computer** (e.g. a mini PC with Ubuntu or Debian) | **Recommended** for permanent use, up to about 50 people |
| **Windows or Mac PC** | For rehearsals or small teams |

### Linux – one command

Open a terminal on the Linux computer and type:

```bash
curl -fsSL https://raw.githubusercontent.com/KesherCom/kesher/main/deploy/server/install.sh | sudo bash
```

It installs everything needed, starts Kesher and makes sure Kesher runs again
after every restart. At the end it shows the address, e.g.
`https://192.168.1.50:8443`.

Useful commands afterwards:

| Command | What it does |
| --- | --- |
| `kesher status` | Is Kesher running? At which address? |
| `sudo kesher update` | Update to the latest version |
| `sudo kesher restart` | Restart |
| `sudo kesher backup` | Back up the data |
| `sudo kesher new-certificate` | Needed when the server's IP address changed |
| `kesher logs` | Show the log (for problems) |

Tip: **don't update right before a big event.** Update the week before and
test.

### Windows PC

1. Download `kesher-server-windows-amd64.zip` from the download page and
   unzip it.
2. Start the program (details in [docs/deployment/server.md](../deployment/server.md)).
3. When Windows asks about the firewall, allow access on **private
   networks**.
4. The PC must **not go to sleep** during the event.

### Desktop app for the team

From the download page
([Releases](https://github.com/KesherCom/kesher/releases)):

- Windows: `kesher-desktop-windows-amd64-setup.exe`
- Mac with Apple chip (M1, M2 …): `kesher-desktop-macos-arm64.dmg`
- Mac with Intel chip: `kesher-desktop-macos-amd64.dmg`

More in [docs/releases/downloads.md](../releases/downloads.md).

## 17. First-run setup

The first time you open the server address in a browser you see
**"Welcome to kesher"**:

1. **"Admin PIN"** – choose a PIN for the admin area (at least 4 characters,
   no spaces) and repeat it in **"Repeat the PIN"**. **Remember it!**
2. **"Start with"**:
   - **"Example setup"** (recommended) – creates example roles (Audio, Video,
     Lighting, Broadcast, Camera, Pastor, Producer), party lines (FOH, Stage,
     Video Control, Livestream, Lighting Booth) and the broadcast channel
     "All Tech". You can rename or delete everything later.
   - **"Empty"** – nothing; you create roles and lines yourself before anyone
     can log in.
3. Click **"Finish setup"**. The admin area opens.

This page appears only once.

## 18. The admin area

**Opening it:** on the login page click **"Show admin"**, enter the PIN,
click **"Open admin console"**. Close it with the **lock** at the top.

There are four sections on the left:

| Section | Contents |
| --- | --- |
| **Live** | Who is online, what needs attention |
| **Setup** | Roles, party lines, who talks and hears where, people |
| **Devices** | Raspberry Pi stations, Stream Decks, Companion |
| **System** | Backup, admin PIN, Telegram, logs, chat history |

A number next to **Devices** means a station or Stream Deck is waiting for
approval.

### Live – during the event

- Tiles show: people online, stations online, Stream Decks, server state
  (**"OK"** or **"Check"** with a hint).
- **"Online now"** – everyone logged in. For each person:
  - **"Mute mic"** – turn this person's microphone off right now (e.g. when
    someone forgot an open mic). Their next press talks again.
  - **"Kick"** – log the person out on all devices.
- **"Party lines"** – how many listen on each line.
- **"Audio and network"** – technical values, only for troubleshooting.

## 19. Setting up roles and party lines

### Creating a party line

**Setup → "Party lines" → "Create party line"**:

- **ID** (short, no spaces, e.g. `stage`) and **name** (e.g. "Stage"). The ID
  can't be changed later.
- **"Priority"** – Low / Normal / High / Critical. Shown as a letter on the
  cards.
- **"Allowed senders"** – roles that may talk.
- **"Allowed receivers"** – roles that may listen.
- **"Forced listeners"** – roles that **always** listen (they can't switch it
  off).

Careful: **"Delete"** deletes without asking.

### Creating a role

**Setup → "Roles" → "Create role"**:

- **ID** and **name** (e.g. `camera` / "Camera").
- **"Default party line"** – the line people talk on after login.
- **"Default audio mode"** – **"PTT"** (push-to-talk, recommended) or
  **"Always on"**.
- **"Default to simple mobile view"** – the simple phone view (good for
  camera and stage).
- **"Only one person at a time"** – only one person may have this role; a
  second login takes it over (e.g. for the director).

### Who talks and hears where – the grid

**Setup → "Who talks and hears where"** is the easiest way to give rights.
Rows = roles, columns = party lines. Each click on a cell moves on:

**–** (no access) → **Hear** (may listen) → **Always** (always listens) →
**Talk + Hear** → **Talk + Always**

Changed cells are highlighted. Click **"Save changes"** at the end
(**"Discard"** throws the changes away).

**Typical steps for a new role:**

1. Create the role.
2. Set that role's cells in the grid.
3. **"Save changes"**.
4. Set the role's default line.

### Broadcast channels

**Setup → "Broadcast channels" → "Create channel"**: name, priority,
**"Included party lines"** (on which lines the announcement is heard) and
**"Allowed roles"** (who may use the channel).

### People

**Setup → "Users"**: people appear automatically when they log in. You can
delete people who are offline here.

A small extra: names entered under **"Birthday Users (Today)"** get a
birthday greeting when they log in.

## 20. Approving stations and Stream Decks

### Raspberry Pi station

You need: a Raspberry Pi 5 (recommended), 4 or 3, Raspberry Pi OS Lite
64-bit, a **USB headset** (the Pi's headphone jack has no microphone input)
and ideally a **network cable**. Installation is described in
[docs/hardware/raspberry-pi.md](../hardware/raspberry-pi.md).

**Approving:** as soon as the station is switched on and on the network, it
appears under **Devices → "Stations (Raspberry Pi)" → "Waiting for
approval"**:

1. **"Name in the user list"** – what the station should be called, e.g.
   `stage-left`.
2. **"Role"** – which role the station has.
3. **"Talk mode"** – **"Push to talk (button)"** or **"Always on (button
   mutes)"** (microphone open, the button mutes it).
4. **"Approve"**. The station connects within a few seconds.

**"Edit"** changes name, role and mode at any time; **"Remove"** removes the
station (it then has to be approved again).

### Stream Decks via Companion

For Stream Decks that run through **Bitfocus Companion**, see
[docs/COMPANION-SETUP.md](../COMPANION-SETUP.md) (German). In short: create one
Kesher connection per Stream Deck in Companion. The deck then shows a code and
appears under **Devices → "Stream Decks"**. Assign it to a place there with
**"Pair…"** – or the person at that place enters the code in their own
settings.

A Stream Deck MK.2 on a PC with the **desktop app** needs no approval – just
plug it in.

## 21. Backup, PIN and other settings

Everything under **System**:

- **"Showfile (backup and restore)"**
  - **"Export showfile"** – downloads the whole configuration (roles, lines,
    rights, Stream Deck layouts …) as a file. **Export before every bigger
    change!**
  - Import: load the file with **"Load JSON file"**, tick the parts you want,
    leave **"Create Backup Before Import"** ticked, click **"Import selected
    sections"**.
- **"Admin PIN"** – change the PIN: current PIN, new PIN twice,
  **"Update PIN"**.
- **"Telegram bot"** / **"Telegram allowlist"** – exchange messages between a
  Telegram group and a party line. Guide:
  [docs/TELEGRAM-BOT-SETUP.md](../TELEGRAM-BOT-SETUP.md).
- **"Logs"** – log for troubleshooting; save it with **"Download TXT"**.
- **"Chat history"** – **"Clear for new Show"** clears the chat for everyone,
  e.g. before the next service. Read confirmations can also be switched on and
  off there (**"ACK-Nachrichten aktivieren"**).

## 22. Network – what the tech lead needs to know

- **All devices on the same network** (wired/Wi-Fi) as the server. The
  desktop app and stations then find the server by themselves.
- **Browsers need https** (`https://<server>:8443`), otherwise there is no
  microphone. The certificate warning has to be accepted once on every device
  (chapter 4.1).
- **Fixed positions on a cable**, Wi-Fi only for mobile devices. Wi-Fi works
  but adds more, and varying, delay.
- The server should have a **fixed IP address** (set it in the router). If it
  changes anyway, run `sudo kesher new-certificate`.
- The installer opens these ports in the server's firewall. If another
  firewall is in between, they must be open:

  | Port | For |
  | --- | --- |
  | 8443 (TCP) | Browsers |
  | 8080 (TCP) | Desktop app and stations |
  | 8081 (UDP) | Sound of the desktop app and stations |
  | 8082 (UDP) | Sound of browsers |
  | 5353 (UDP) | Finding the server automatically |

| Problem | Fix |
| --- | --- |
| Connected but no sound | Open UDP 8081 and 8082 |
| App or station doesn't find the server | Same network? UDP 5353 open? Otherwise enter the address by hand |
| Sound only works on some networks | Set `KESHER_PUBLIC_IP`, then `sudo kesher new-certificate` (see [server.md](../deployment/server.md)) |
| Server doesn't start | Look at `kesher logs` |
| Admin PIN forgotten | On the server, set the line `ADMIN_PIN=…` in `/opt/kesher/.env` and run `sudo kesher restart` |

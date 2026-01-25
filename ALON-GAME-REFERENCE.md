# ALON's PumpRun - Game Reference

## Overview
A side-scrolling endless runner game featuring ALON, promoting the $ALON token on pump.fun. Players collect pills, avoid obstacles, and aim for high scores.

**Live URL:** https://alonpump.run

**Alternate URL:** https://cchops89.github.io/alon-pumprun-game/

**Repository:** https://github.com/cchops89/alon-pumprun-game

---

## Game Mechanics

### Controls
- **Desktop:** Click, Space, or Arrow Up to jump
- **Mobile:** Tap to jump
- **Double Jump:** Tap/click twice (while airborne)

### Scoring
- **Distance:** +1 point per frame (displayed as score/10)
- **Pill Collection:** +50 points per pill
- **Difficulty:** Speed increases every 500 points

### Physics
- Gravity: 0.8
- Jump Power: -15
- Base Game Speed: 6
- Speed Increment: +0.5 every 500 points

### Death Animation
When ALON collides with an obstacle:
- Player launches upward (dy: -18) and backward (dx: -3)
- Spins while falling (rotation: +0.15 per frame)
- Falls off bottom of screen
- Game over screen appears after animation completes

### Background Transition
At 690 points, the background transitions from normal to storm:
- **Trigger Score:** 690 displayed points (6900 internal)
- **Transition Type:** Crossfade (alpha blend)
- **Transition Speed:** ~50 frames (0.02 alpha per frame)
- **Safe Zone:** No obstacles spawn from 690-750 points
- **Storm Background:** Dark city skyline with lightning

---

## Characters

### ALON (Player)
- **Sprite:** `alon-sprite-sheet.png` (384x64, 6 frames)
- **Size:** 60x80 pixels
- **Animation:** 6-frame run cycle at 100ms per frame
- **Position:** x=100, ground level
- **Death:** Launches up/back, spins, falls off screen

### Narc (Flying Supporter)
- **Sprite:** `narc-sprite-sheet.png` (1200x600, single frame)
- **Size:** 240x120 pixels (2:1 aspect ratio)
- **Animation:** None (static jetpack image)
- **Behavior:** Flies across the sky from left to right
- **Position:** Random height between 80-280px from top
- **Layer:** Background (behind ground, obstacles, tokens, and player)
- **Speed:** 10px per frame
- **Spawn Rate:** Every 400 frames when not active

#### Narc Messages
- "You got this ALON!"
- "To the moon!"
- "WAGMI!"
- "Don't stop!"
- "Community strong!"
- "LFG!"

### Vlad (Background Character)
- **Sprite:** `vladsprite.png` (single frame)
- **Size:** 150px height, width scales to maintain aspect ratio
- **Animation:** None (static image)
- **Behavior:** Stands in background at random seam points
- **Position:** 20px above ground sprite, at background seam locations
- **Layer:** Background (after background, before ground)
- **Spawn Logic:** ~35% chance per seam (pseudo-random hash function)

---

## Render Order (Back to Front)

1. **Background** - Parallax sky/environment (normal or storm)
2. **Clouds** - Fallback only (if no background sprite)
3. **Vlad** - Standing at random seam points
4. **Narc** - Flying in distant sky
5. **Ground** - Scrolling terrain
6. **Obstacles** - BEAR, BONK, BAGS
7. **Tokens** - Collectible pills
8. **Player** - ALON (always on top)

---

## Obstacles

### BEAR
- **Sprite:** `bearsprite.png` (6 frames)
- **Size:** 135x135 pixels (50% larger than original)
- **Animation:** Static frame 5 with bounce effect
- **Speed:** Fixed at 6 (doesn't scale with difficulty)

### BONK
- **Sprite:** `bonksprite.png` (7 frames)
- **Size:** 60x60 pixels
- **Animation:** Static frame 0 with bounce effect
- **Speed:** Fixed at 6

### BAGS
- **Sprite:** `bagssprite.png` (5 frames)
- **Size:** 60x60 pixels
- **Animation:** Static frame 0 with bounce effect
- **Speed:** Fixed at 6

### Spawn Rate
- Base interval: 120 frames
- Decreases as gameSpeed increases: `120 - gameSpeed * 5`

---

## Collectibles

### Pills (Tokens)
- **Visual:** Animated rotating capsule (green/white)
- **Size:** 40x40 pixels
- **Spawn Rate:** Every 80 frames
- **Position:** Random height between 150-250 pixels above ground
- **Value:** +50 points

---

## Environment

### Background (Normal)
- **Sprite:** `background-sprite.png` (1536x1024)
- **Style:** Tropical paradise with candlestick charts
- **Scrolling:** Parallax at 0.3x game speed
- **Tiling:** Mirrored every other tile for seamless loop

### Background (Storm)
- **Sprite:** `narc-background-sprite.png`
- **Style:** Dark city skyline with lightning
- **Scrolling:** Parallax at 0.3x game speed
- **Tiling:** Mirrored every other tile for seamless loop
- **Unlock:** Appears at 690 points via crossfade transition

### Ground
- **Sprite:** `ground-sprite.png` (1712x158)
- **Height:** Canvas height - 100 pixels from bottom
- **Scrolling:** 1x game speed
- **Tiling:** Mirrored every other tile

### Clouds (Fallback)
- Only displayed if background sprite fails to load
- 3 clouds with random positions and speeds

---

## Audio (Web Audio API)

### Sound Effects
Sound effects play at full volume (gain: 0.3)

#### Jump Sound
- Type: Default oscillator
- Frequency: 400Hz → 600Hz (rising)
- Duration: 0.15 seconds

#### Collect Sound
- Type: Sine wave
- Notes: C5 (523Hz) → E5 (659Hz) → G5 (784Hz)
- Duration: 0.3 seconds

#### Game Over Sound
- Type: Sawtooth wave
- Frequency: 200Hz → 50Hz (falling)
- Duration: 0.5 seconds

### Music System
Music plays 10% quieter than sound effects. Toggle with mute button (bottom-right).

#### Menu Music - Dark Atmospheric Synth
- **Key:** C minor
- **BPM:** 85
- **Style:** Haunting, moody
- **Elements:**
  - Sawtooth melody (Eb5, D5, C5, G4, Ab4...)
  - Deep triangle bass (C3, Ab3, G3)
  - Sine pad chords (C minor: C4, Eb4, G4)
  - Minor arpeggio accents
- **Volume:** 0.45 gain

#### Game Music - Dark Driving Synth
- **Key:** A minor
- **BPM:** 128
- **Style:** Intense, driving
- **Elements:**
  - Sawtooth melody (A4, C5, E5, D5...)
  - Heavy pulsing sawtooth bass (A3, F3, G3, E3)
  - Sine kick drums (120Hz → 40Hz)
  - Sawtooth snare hits
  - Fast minor arpeggios
- **Volume:** 0.36 gain

---

## UI Elements

### HUD (In-Game)
- **Score:** Top-left corner
- **Pills:** Top-right corner
- **Style:** White text with black semi-transparent background

### Mute Button
- **Position:** Bottom-right corner (above bottom bar)
- **Icon:** Speaker emoji (🔊 / 🔇)
- **Style:** Circular button with green border

### Bottom Bar
- **Left:** Buy $ALON link with contract address
- **Right:** Creator credit (@thejpegjunkie)
- **Contract:** `8XtRWb4uAAJFMP4QQhoYYCWR6XXb7ybcCdiqPwz9s5WS`

### Start Screen
- Title with PumpFun pill logos
- Instructions for tap/click and double jump
- START GAME button

### Game Over Screen
- Final score display
- Pills collected count
- Play Again button

---

## Social Sharing / SEO

### Meta Tags
```html
<!-- Open Graph / Facebook -->
<meta property="og:type" content="website">
<meta property="og:url" content="https://alonpump.run/">
<meta property="og:title" content="ALON's PumpRun - To The Moon!">
<meta property="og:description" content="Help ALON dodge the bears and collect pills in this endless runner!">
<meta property="og:image" content="https://alonpump.run/og-image.png">

<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="ALON's PumpRun - To The Moon!">
<meta name="twitter:description" content="Help ALON dodge the bears and collect pills in this endless runner!">
<meta name="twitter:image" content="https://alonpump.run/og-image.png">
```

### Preview Image
- **File:** `og-image.png`
- **Size:** 1200x630 pixels (recommended)
- **Content:** ALON character with game background and title

### Platform Support
- Twitter/X posts
- Facebook
- LinkedIn
- Telegram (uses Open Graph)
- Discord

---

## File Structure

```
alon-pumprun-game/
├── index.html                # Main game file (HTML + CSS + JS)
├── index-test.html           # Test file with mobile portrait support
├── CNAME                     # Custom domain config (alonpump.run)
├── og-image.png              # Social sharing preview image (1200x600)
├── alon-sprite-sheet.png     # Player character (384x64, 6 frames)
├── narc-sprite-sheet.png     # Flying supporter (1200x600, single frame)
├── narc-background-sprite.png # Storm background (unlocked at 690 pts)
├── vladsprite.png            # Vlad background character
├── bonksprite.png            # BONK obstacle (7 frames)
├── bearsprite.png            # BEAR obstacle (6 frames)
├── bagssprite.png            # BAGS obstacle (5 frames)
├── background-sprite.png     # Parallax background (1536x1024)
├── ground-sprite.png         # Scrolling ground (1712x158)
├── pumpfun-logo.png          # Pill logo for UI
└── ALON-GAME-REFERENCE.md    # This file
```

---

## Responsive Design

### Desktop
- Canvas: 800x600 pixels
- Aspect ratio: 4:3

### Mobile Portrait (Test Version)
Available in `index-test.html`:
- Canvas: 800x1000 pixels
- Aspect ratio: 4:5
- Triggered when: width ≤ 800px and portrait orientation
- Ground position: Always 100px from bottom

### Mobile Scaling
- Game container uses `aspect-ratio: 800/600`
- Title and menus use `clamp()` for fluid typography
- Media queries for screens < 800px and landscape orientation

### Touch Support
- `touch-action: none` prevents scroll interference
- `touchstart` event with `preventDefault()`

---

## Deployment

### Custom Domain (alonpump.run)
DNS configured via Cloudflare:
- A records pointing to GitHub Pages IPs (DNS only, no proxy):
  - 185.199.108.153
  - 185.199.109.153
  - 185.199.110.153
  - 185.199.111.153
- CNAME for www → cchops89.github.io

### GitHub Pages
1. Push to `main` branch
2. Enable Pages in repo settings (Source: main, root)
3. Custom domain set to `alonpump.run`
4. HTTPS enforced

### Updates
1. Edit `index.html` locally
2. `git add index.html`
3. `git commit -m "Description"`
4. `git push`

---

## Future Enhancements (Ideas)

- [ ] High score persistence (localStorage)
- [ ] Leaderboard integration
- [ ] Power-ups (shield, magnet, slow-mo)
- [ ] Additional obstacle types
- [x] ~~Background music toggle~~ (Implemented)
- [x] ~~Dark synth music~~ (Implemented)
- [x] ~~Social sharing meta tags~~ (Implemented)
- [x] ~~Death animation~~ (Implemented)
- [x] ~~Flying Narc with jetpack~~ (Implemented)
- [x] ~~Storm background transition at 690 points~~ (Implemented)
- [x] ~~Vlad background character at random seams~~ (Implemented)
- [ ] Share score to Twitter/X
- [ ] Achievement system

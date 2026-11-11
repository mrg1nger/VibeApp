import type { MemoryCategory } from '@shared/types'

// The data for the memory search evaluation (search.test.ts): one made-up
// project, "Mossfall" (a browser dungeon game), with the facts its memory
// would hold after a few months, its code map, and questions whose right
// answers are known. Nothing here comes from a real project.
//
// Questions come two ways, as they do in the app:
//   request  what a person types (the pre-fetch sees this, word for word)
//   query    what an agent types into recall / where
// Many are worded differently from the answer on purpose: "the little map"
// for the minimap, "hosting" for the VPS. How many words a question shares
// with its answer is measured by the test, not judged here.

export interface SearchFact {
  id: string
  text: string
  category: MemoryCategory
  /** Saved for every project, not just this one. */
  global?: boolean
}

export interface SearchFile {
  path: string
  summary: string
}

export interface SearchQuestion {
  text: string
  from: 'request' | 'query'
  /** Fact ids or file paths; finding any one of them counts. */
  answers: string[]
}

export const FACTS: SearchFact[] = [
  // about
  { id: 'a-what', category: 'about', text: 'Mossfall is a browser dungeon-crawler: the player explores an overgrown ruin floor by floor, fights monsters and collects loot.' },
  { id: 'a-stack', category: 'about', text: 'Built with TypeScript and Vite; everything is drawn on an HTML canvas, with no game engine.' },
  { id: 'a-server', category: 'about', text: 'A small Express server stores high scores and cloud saves in SQLite.' },
  { id: 'a-phones', category: 'about', text: 'The game has to be playable on phones as well as desktop; touch controls are a must.' },
  { id: 'a-names', category: 'about', text: 'The player character is called Wren; the final boss is the Rootmother on floor 12.' },

  // setup
  { id: 's-dev', category: 'setup', text: 'Start the game locally with `npm run dev`; it opens on port 5173.' },
  { id: 's-server', category: 'setup', text: 'The score server starts with `npm run server` and listens on port 8787.' },
  { id: 's-tests', category: 'setup', text: 'Tests run with `npx vitest run`.' },
  { id: 's-build', category: 'setup', text: 'Production build: `npm run build` writes to dist/.' },
  { id: 's-deploy', category: 'setup', text: 'Deploy with `npm run ship`, which builds and copies dist/ to the VPS over rsync; the server address is read from DEPLOY_HOST.' },
  { id: 's-node', category: 'setup', text: 'Node 22 is required; the version is pinned in .nvmrc.' },
  { id: 's-sprites', category: 'setup', text: 'Sprite sheets are packed with `npm run sprites` from art/raw into public/sprites; run it after adding or changing any image.' },
  { id: 's-env', category: 'setup', text: 'Environment variables live in .env.local (not committed): SCORE_DB_PATH, SESSION_SECRET, DEPLOY_HOST.' },
  { id: 's-urls', category: 'setup', text: 'The live game is at mossfall.example.com; the staging copy is at staging.mossfall.example.com.' },
  { id: 's-tiled', category: 'setup', text: 'Hand-made level maps are edited in Tiled and exported as JSON to public/maps.' },

  // preference
  { id: 'p-british', category: 'preference', text: 'All in-game text is in British English ("colour", "armour").' },
  { id: 'p-deps', category: 'preference', text: 'Never add a new npm dependency without asking first.' },
  { id: 'p-300', category: 'preference', text: 'Keep every source file under 300 lines; split it when it grows past that.' },
  { id: 'p-commits', category: 'preference', text: 'The user prefers small commits, one change each, with plain-English messages.' },
  { id: 'p-sound', category: 'preference', text: "No sound may play before the player's first tap or click." },
  { id: 'p-ads', category: 'preference', text: 'The user wants no ads and no tracking scripts in the game, ever.' },
  { id: 'p-pixel', category: 'preference', text: 'Pixel-art style only: no smooth gradients or anti-aliased shapes.' },
  { id: 'p-plain', category: 'preference', text: "Explain changes without jargon; the user isn't a programmer." },
  { id: 'gl-commits', category: 'preference', global: true, text: 'In every project, commit messages are written in British English.' },
  { id: 'gl-dates', category: 'preference', global: true, text: 'In every project, dates are written like 10 November 2026, never 11/10/2026.' },
  { id: 'gl-windows', category: 'preference', global: true, text: 'The user works on Windows 11 with PowerShell; give commands that work there.' },

  // decision
  { id: 'd-saves', category: 'decision', text: "Saves go to the browser's localStorage first and sync to the server only when the player is signed in." },
  { id: 'd-loop', category: 'decision', text: 'Chose a fixed game loop of 60 updates per second, with drawing interpolated between updates, so the speed is the same on every screen.' },
  { id: 'd-seed', category: 'decision', text: 'Dungeon floors are generated from a seed with a room-and-corridor algorithm; the same seed always gives the same floor.' },
  { id: 'd-multiplayer', category: 'decision', text: 'Decided against multiplayer for version 1; revisit after launch.' },
  { id: 'd-pathfinding', category: 'decision', text: 'Monster pathfinding uses A* on the tile grid, recalculated at most every 300 ms per monster.' },
  { id: 'd-inventory', category: 'decision', text: 'The inventory is limited to 20 slots; stackable items stack up to 99.' },
  { id: 'd-damage', category: 'decision', text: 'Damage formula: attack × 2 − defence, never less than 1.' },
  { id: 'd-levels', category: 'decision', text: 'Player levels are capped at 30; the XP needed for a level is 50 × level².' },
  { id: 'd-magic', category: 'decision', text: 'Sign-in is by emailed magic link only; there are no passwords.' },
  { id: 'd-scores', category: 'decision', text: 'The high-score table shows the top 100 and is reset on the first of each month.' },
  { id: 'd-minimap', category: 'decision', text: "Dropped the minimap from the phone layout because it covered the action buttons; it's desktop-only." },
  { id: 'd-fonts', category: 'decision', text: 'Fonts: "Press Start 2P" for headings and "VT323" for body text, both bundled locally rather than loaded from Google.' },
  { id: 'd-shop', category: 'decision', text: 'Shop prices rise 8% per floor; selling gives back 40% of the purchase price.' },
  { id: 'd-difficulty', category: 'decision', text: 'Difficulty settings are Gentle, Standard and Cruel; Cruel has permanent death.' },
  { id: 'd-autosave', category: 'decision', text: 'Autosave happens on every staircase and every 2 minutes.' },
  { id: 'd-colourblind', category: 'decision', text: 'Colour-blind mode swaps the red/green status effects for blue/orange and adds icons.' },

  // gotcha
  { id: 'g-safari-audio', category: 'gotcha', text: 'Safari on iPhone pauses the audio context when the tab loses focus; it must be resumed on the next touch, or the game stays silent.' },
  { id: 'g-blurry', category: 'gotcha', text: 'The canvas looks blurry on high-density screens unless its size is multiplied by devicePixelRatio.' },
  { id: 'g-hmr', category: 'gotcha', text: "Vite's hot reload starts a second game loop unless the old one is stopped in import.meta.hot.dispose." },
  { id: 'g-quota', category: 'gotcha', text: 'localStorage holds about 5 MB; saves with more than about 40 explored floors hit QuotaExceededError, so explored-tile maps are run-length encoded.' },
  { id: 'g-tiled', category: 'gotcha', text: 'Tiled exports tile ids starting at 1, with 0 meaning empty; subtract 1 before looking up the sprite.' },
  { id: 'g-rsync', category: 'gotcha', text: 'The rsync deploy fails with "Permission denied (publickey)" when the ssh agent isn\'t running; run `ssh-add` first.' },
  { id: 'g-locked', category: 'gotcha', text: 'SQLite on the server returns "database is locked" under load unless WAL mode is on; it is switched on in server/db.ts.' },
  { id: 'g-arrows', category: 'gotcha', text: 'The arrow keys scroll the page in some browsers unless preventDefault is called for them.' },
  { id: 'g-spam', category: 'gotcha', text: 'Magic-link emails land in spam at Outlook addresses unless the SPF and DKIM records are set on the domain.' },
  { id: 'g-drift', category: 'gotcha', text: 'Floating-point drift made seeded dungeons differ between Chrome and Firefox; the generator now uses integer-only maths (mulberry32).' },
  { id: 'g-android', category: 'gotcha', text: 'On Android Chrome the on-screen keyboard resizes the viewport and squashes the canvas; the layout listens to visualViewport instead of window resize.' },
  { id: 'g-bleed', category: 'gotcha', text: 'Sprites bleed into each other at tile edges when scaled; the packer adds 2 px of padding around each sprite.' },
  { id: 'g-raf', category: 'gotcha', text: 'requestAnimationFrame stops in background tabs, so a returning player would get one huge time step; steps are clamped to 250 ms.' },
  { id: 'g-vitest-canvas', category: 'gotcha', text: "Vitest can't draw on a canvas; tests that touch rendering use the stand-in in tests/fakeCanvas.ts." },

  // other
  { id: 'o-tobias', category: 'other', text: "The user's nephew Tobias is play-testing; his feedback so far: the second boss (the Lichen Knight) is too hard." },
  { id: 'o-launch', category: 'other', text: 'Launch is planned for 14 March 2027, on itch.io first.' },
  { id: 'o-art', category: 'other', text: 'Artwork is made by a freelancer, Ines; new sprites arrive as PNGs in the shared "Mossfall art" Drive folder.' },
  { id: 'o-music', category: 'other', text: 'The music is licensed from a pack called "Hollow Chiptunes"; the licence requires a credit on the title screen.' },
  { id: 'o-potions', category: 'other', text: 'The potion that restores health is called Dewdraught; mana is restored by Emberwine.' },
  { id: 'o-bug-doors', category: 'other', text: 'Known bug, not fixed yet: monsters sometimes walk through locked doors.' },
  { id: 'o-vps', category: 'other', text: 'The VPS is a 1 GB machine at Hetzner; it costs about €4 a month.' },
  { id: 'o-daily', category: 'other', text: 'The user wants a "daily dungeon" mode later, where everyone gets the same seed each day.' },
  { id: 'o-ipad', category: 'other', text: 'A friend reported the game freezing for a second when entering floor 7 on an old iPad.' }
]

export const FILES: SearchFile[] = [
  { path: 'src/main.ts', summary: 'Entry point: creates the canvas, loads assets and starts the game loop.' },
  { path: 'src/game/loop.ts', summary: 'Fixed-timestep game loop: 60 updates a second, interpolated drawing, clamps long pauses.' },
  { path: 'src/game/state.ts', summary: 'The whole game state object (player, floor, monsters, items) and how a new game is created.' },
  { path: 'src/game/input.ts', summary: 'Keyboard handling: maps keys to actions and stops the arrow keys from scrolling the page.' },
  { path: 'src/game/touch.ts', summary: 'Touch controls: the on-screen d-pad and action buttons for phones.' },
  { path: 'src/game/camera.ts', summary: 'Keeps the view centred on the player and clamps it to the floor edges.' },
  { path: 'src/game/save.ts', summary: 'Saving and loading: writes the game state to localStorage, compresses explored maps, autosaves.' },
  { path: 'src/game/cloudSync.ts', summary: 'Uploads and downloads saves for signed-in players and settles conflicts by taking the newest.' },
  { path: 'src/game/settings.ts', summary: 'Player options (volume, difficulty, colour-blind mode) and where they are stored.' },
  { path: 'src/game/difficulty.ts', summary: 'The three difficulty levels and the numbers each one changes (monster health, loot, permanent death).' },
  { path: 'src/game/rng.ts', summary: 'Seeded random numbers (mulberry32) using integer maths only.' },
  { path: 'src/dungeon/generate.ts', summary: 'Builds a floor from a seed: places rooms, joins them with corridors, adds the stairs.' },
  { path: 'src/dungeon/rooms.ts', summary: 'Room shapes and the rules for where rooms may be placed without overlapping.' },
  { path: 'src/dungeon/tiles.ts', summary: 'Tile types (wall, floor, door, stairs, water) and which of them can be walked on.' },
  { path: 'src/dungeon/doors.ts', summary: 'Doors: open, closed and locked, and which key opens which.' },
  { path: 'src/dungeon/traps.ts', summary: 'Trap types (spikes, poison darts, pitfalls), how they are triggered and their damage.' },
  { path: 'src/dungeon/fog.ts', summary: 'Fog of war: tracks which tiles the player has seen and which are visible now.' },
  { path: 'src/dungeon/tiledImport.ts', summary: "Reads hand-made maps exported from Tiled and converts their tile ids to the game's own." },
  { path: 'src/dungeon/populate.ts', summary: 'Decides which monsters, chests and traps go on a floor, based on its depth.' },
  { path: 'src/entities/player.ts', summary: 'The player: movement, stats, levelling up and the XP thresholds.' },
  { path: 'src/entities/monster.ts', summary: 'Base monster behaviour: wander, notice the player, chase, attack.' },
  { path: 'src/entities/monsterTypes.ts', summary: 'The list of monsters with their health, attack, speed and the floors they appear on.' },
  { path: 'src/entities/bosses.ts', summary: 'Boss fights: the Lichen Knight and the Rootmother, with their attack patterns.' },
  { path: 'src/entities/pathfinding.ts', summary: 'A* route finding on the tile grid, with a limit on how often each monster recalculates.' },
  { path: 'src/entities/npc.ts', summary: 'Friendly characters: the shopkeeper and the hermit, with their dialogue lines.' },
  { path: 'src/combat/damage.ts', summary: 'Works out damage from attack and defence, critical hits and the minimum of 1.' },
  { path: 'src/combat/statusEffects.ts', summary: 'Poison, burn, freeze and stun: how long each lasts and what it does every turn.' },
  { path: 'src/combat/abilities.ts', summary: 'Player skills (dash, shield bash, fireball) with their mana cost and cooldowns.' },
  { path: 'src/items/items.ts', summary: 'Every item definition: weapons, armour, potions and keys, with their stats.' },
  { path: 'src/items/inventory.ts', summary: 'The backpack: 20 slots, stacking, picking up, dropping and using items.' },
  { path: 'src/items/loot.ts', summary: 'Loot tables: what chests and monsters drop and how rarity is rolled.' },
  { path: 'src/items/shop.ts', summary: 'Buying and selling: prices by floor and the sell-back rate.' },
  { path: 'src/items/equipment.ts', summary: "Wearing weapons and armour and adding their bonuses to the player's stats." },
  { path: 'src/items/crafting.ts', summary: 'Combining ingredients into potions at the cauldron; the recipe list.' },
  { path: 'src/render/renderer.ts', summary: 'Draws a frame: floor tiles, then items, monsters, the player and effects, then the interface.' },
  { path: 'src/render/sprites.ts', summary: "Loads the sprite sheets and looks up each sprite's rectangle by name." },
  { path: 'src/render/canvas.ts', summary: "Sets the canvas size for the screen's pixel density and keeps the pixels sharp." },
  { path: 'src/render/animation.ts', summary: 'Frame-by-frame sprite animations (walk, attack, hurt) and their timing.' },
  { path: 'src/render/particles.ts', summary: 'Small visual effects: sparks, dust, blood and spell trails.' },
  { path: 'src/render/lighting.ts', summary: 'Darkness and torch light: dims tiles by their distance from a light source.' },
  { path: 'src/render/palette.ts', summary: 'The colour palette and its colour-blind alternative.' },
  { path: 'src/render/screenShake.ts', summary: 'Shakes the view briefly on heavy hits and explosions.' },
  { path: 'src/ui/hud.ts', summary: 'The on-screen bars for health, mana and XP, and the current floor number.' },
  { path: 'src/ui/minimap.ts', summary: 'The small map in the corner (desktop only), drawn from the explored tiles.' },
  { path: 'src/ui/inventoryScreen.ts', summary: 'The backpack screen: a grid of items with tooltips and drag to equip.' },
  { path: 'src/ui/shopScreen.ts', summary: 'The shop window: lists goods with prices and handles the buy and sell clicks.' },
  { path: 'src/ui/titleScreen.ts', summary: 'The first screen: New Game, Continue, Options and the music credit.' },
  { path: 'src/ui/pauseMenu.ts', summary: 'The pause menu: resume, options, save and quit.' },
  { path: 'src/ui/optionsScreen.ts', summary: 'The options screen: sliders and toggles for sound, difficulty and accessibility.' },
  { path: 'src/ui/dialogue.ts', summary: 'Speech boxes for characters, typed out letter by letter, with a skip button.' },
  { path: 'src/ui/gameOver.ts', summary: "The death screen: shows the run's stats and submits the score." },
  { path: 'src/ui/leaderboard.ts', summary: 'The high-score screen: fetches and shows the top players of the month.' },
  { path: 'src/ui/signIn.ts', summary: 'The sign-in box: asks for an email and waits for the magic link to be clicked.' },
  { path: 'src/ui/toast.ts', summary: 'Short messages that pop up and fade ("Game saved", "Inventory full").' },
  { path: 'src/ui/layout.ts', summary: 'Arranges the interface for phone or desktop and reacts to the on-screen keyboard and to rotation.' },
  { path: 'src/ui/text.ts', summary: 'Draws pixel-font text on the canvas, with wrapping and outlines.' },
  { path: 'src/ui/tutorial.ts', summary: 'First-run hints that teach moving, attacking and opening the backpack.' },
  { path: 'src/audio/audio.ts', summary: 'Starts the audio context after the first tap and resumes it when the tab comes back.' },
  { path: 'src/audio/music.ts', summary: 'Background music: which track plays on which floor, and cross-fading between tracks.' },
  { path: 'src/audio/sfx.ts', summary: 'Sound effects: loads them and plays them with a slight pitch variation.' },
  { path: 'src/i18n/strings.ts', summary: 'Every piece of text shown to the player, in one place, in British English.' },
  { path: 'src/net/api.ts', summary: 'Calls to the server: sign in, send a score, fetch the leaderboard, sync a save; copes with being offline.' },
  { path: 'src/util/math.ts', summary: 'Small helpers: clamp, lerp, distance, a random integer in a range.' },
  { path: 'src/util/events.ts', summary: 'A tiny event bus, so parts of the game can react to things like "player died".' },
  { path: 'src/util/assets.ts', summary: 'Preloads images, sounds and maps and reports loading progress.' },
  { path: 'src/debug/overlay.ts', summary: 'A developer overlay (F3): frame rate, seed, player position, monster paths.' },
  { path: 'src/debug/cheats.ts', summary: 'Developer cheats: skip a floor, god mode, give an item; switched off in production builds.' },
  { path: 'src/styles.css', summary: 'Page styles: black background, canvas scaling without smoothing, the font faces.' },
  { path: 'server/index.ts', summary: 'Starts the Express server and sets up the routes, CORS and rate limiting.' },
  { path: 'server/db.ts', summary: 'Opens the SQLite database, turns on WAL mode and creates the tables if they are missing.' },
  { path: 'server/scores.ts', summary: 'Endpoints for submitting a score and reading the monthly top 100.' },
  { path: 'server/auth.ts', summary: 'Magic-link sign-in: creates one-time tokens, emails them and sets the session cookie.' },
  { path: 'server/saves.ts', summary: "Endpoints to store and fetch a player's cloud save." },
  { path: 'server/mailer.ts', summary: 'Sends emails through the SMTP provider.' },
  { path: 'server/antiCheat.ts', summary: 'Rejects impossible scores by checking them against the floor reached and the play time.' },
  { path: 'server/monthlyReset.ts', summary: 'Scheduled job that archives and clears the score table on the first of each month.' },
  { path: 'scripts/packSprites.mjs', summary: 'Packs the raw PNGs into sprite sheets with padding and writes the lookup JSON.' },
  { path: 'scripts/ship.mjs', summary: 'Deploy script: builds, then rsyncs dist/ to the server and restarts the score service.' },
  { path: 'scripts/checkStrings.mjs', summary: 'Fails the build if American spellings appear in the player-facing text.' },
  { path: 'tests/damage.test.ts', summary: 'Tests for the damage formula and critical hits.' },
  { path: 'tests/generate.test.ts', summary: 'Tests that the same seed gives the same floor and that every floor can be completed.' },
  { path: 'tests/inventory.test.ts', summary: 'Tests stacking, the slot limit and using items.' },
  { path: 'tests/save.test.ts', summary: 'Tests saving, loading and the compression of explored maps.' },
  { path: 'tests/fakeCanvas.ts', summary: 'A stand-in canvas for tests that records the drawing calls.' },
  { path: 'vite.config.ts', summary: 'Vite settings: the dev port, the build output folder, the path alias.' },
  { path: 'index.html', summary: 'The page: a full-screen canvas, the fonts and the loading bar.' },
  { path: 'public/manifest.webmanifest', summary: "Lets the game be installed to a phone's home screen: name, icons, colours." },
  { path: '.github/workflows/ci.yml', summary: 'Runs the tests and the build on every push.' },
  { path: 'README.md', summary: 'What the game is and how to run, test and deploy it.' }
]

/** Questions answered by a remembered fact. */
export const FACT_QUESTIONS: SearchQuestion[] = [
  { from: 'request', text: "The game runs faster on my brother's gaming monitor than on my laptop, why is that?", answers: ['d-loop'] },
  { from: 'request', text: 'After I switch to another app and come back on my iPhone the music is gone', answers: ['g-safari-audio'] },
  { from: 'request', text: "Everything looks fuzzy on my new phone, the pixels aren't crisp", answers: ['g-blurry'] },
  { from: 'request', text: "My progress vanished after I'd played for hours and got really deep", answers: ['g-quota'] },
  { from: 'request', text: 'Can you make the second boss a bit easier?', answers: ['o-tobias'] },
  { from: 'request', text: "I can't upload the new version, it says permission denied", answers: ['g-rsync'] },
  { from: 'request', text: 'People with hotmail say they never get the login message', answers: ['g-spam'] },
  { from: 'request', text: 'Can we let two people play together?', answers: ['d-multiplayer'] },
  { from: 'request', text: 'How much gold do you get back when you sell something?', answers: ['d-shop'] },
  { from: 'request', text: "Let's add a password option for logging in", answers: ['d-magic'] },
  { from: 'request', text: 'The little map is missing when I play on my phone', answers: ['d-minimap'] },
  { from: 'request', text: 'When I press the down arrow the whole page moves', answers: ['g-arrows'] },
  { from: 'request', text: "My friend who can't tell red from green says he can't see when he's poisoned", answers: ['d-colourblind'] },
  { from: 'request', text: 'When is the game coming out again?', answers: ['o-launch'] },
  { from: 'request', text: 'Who do I need to thank for the soundtrack?', answers: ['o-music'] },
  { from: 'request', text: 'Add the new goblin picture Ines sent', answers: ['o-art', 's-sprites'] },
  { from: 'request', text: 'The score server keeps falling over when lots of people finish at once', answers: ['g-locked'] },
  { from: 'request', text: 'How far can the hero level up?', answers: ['d-levels'] },
  { from: 'request', text: 'The game ran at double speed after I edited the code while it was open', answers: ['g-hmr'] },
  { from: 'request', text: 'On my Android when I type my email the game gets squished', answers: ['g-android'] },
  { from: 'request', text: 'A level I shared with a friend looked different on his computer even though we typed in the same code', answers: ['g-drift', 'd-seed'] },
  { from: 'request', text: 'The enemies are walking straight through doors that should be shut', answers: ['o-bug-doors'] },
  { from: 'request', text: 'How often does the game save by itself?', answers: ['d-autosave'] },
  { from: 'request', text: "What's the healing drink called?", answers: ['o-potions'] },
  { from: 'request', text: 'There are thin lines between the floor squares when I zoom in', answers: ['g-bleed'] },
  { from: 'request', text: 'How much are we paying for hosting?', answers: ['o-vps'] },
  { from: 'request', text: 'I left the game open in another tab and when I came back my character had jumped into a wall', answers: ['g-raf'] },
  { from: 'request', text: 'What happens when you die on the hardest setting?', answers: ['d-difficulty'] },
  { from: 'request', text: 'Could everyone get the same dungeon each day, like Wordle?', answers: ['o-daily'] },
  { from: 'request', text: 'How many things can you carry?', answers: ['d-inventory'] },

  { from: 'query', text: 'deploy command', answers: ['s-deploy'] },
  { from: 'query', text: 'how to run tests', answers: ['s-tests'] },
  { from: 'query', text: 'port for the local dev server', answers: ['s-dev'] },
  { from: 'query', text: 'QuotaExceededError', answers: ['g-quota'] },
  { from: 'query', text: 'devicePixelRatio', answers: ['g-blurry'] },
  { from: 'query', text: 'damage formula', answers: ['d-damage'] },
  { from: 'query', text: 'spelling convention for UI text', answers: ['p-british'] },
  { from: 'query', text: 'policy on adding libraries', answers: ['p-deps'] },
  { from: 'query', text: 'file length limit', answers: ['p-300'] },
  { from: 'query', text: 'authentication method', answers: ['d-magic'] },
  { from: 'query', text: 'persistence strategy for game progress', answers: ['d-saves'] },
  { from: 'query', text: 'procedural generation determinism', answers: ['d-seed', 'g-drift'] },
  { from: 'query', text: 'enemy AI movement algorithm', answers: ['d-pathfinding'] },
  { from: 'query', text: 'SQLITE_BUSY database is locked', answers: ['g-locked'] },
  { from: 'query', text: 'Tiled tile id offset', answers: ['g-tiled'] },
  { from: 'query', text: 'environment variables', answers: ['s-env'] },
  { from: 'query', text: 'production URL', answers: ['s-urls'] },
  { from: 'query', text: 'typography', answers: ['d-fonts'] },
  { from: 'query', text: 'leaderboard reset schedule', answers: ['d-scores'] },
  { from: 'query', text: 'testing canvas rendering in vitest', answers: ['g-vitest-canvas'] },
  { from: 'query', text: 'release date', answers: ['o-launch'] },
  { from: 'query', text: 'monetization analytics', answers: ['p-ads'] },
  { from: 'query', text: 'node version', answers: ['s-node'] },
  { from: 'query', text: 'XP curve', answers: ['d-levels'] },
  { from: 'query', text: 'mulberry32', answers: ['g-drift'] },
  { from: 'query', text: 'art style guidelines', answers: ['p-pixel'] },
  { from: 'query', text: 'date format', answers: ['gl-dates'] },
  { from: 'query', text: "user's operating system and shell", answers: ['gl-windows'] },
  { from: 'query', text: 'import.meta.hot', answers: ['g-hmr'] },
  { from: 'query', text: 'audio autoplay restrictions', answers: ['p-sound', 'g-safari-audio'] }
]

/** Questions answered by a file in the code map. */
export const FILE_QUESTIONS: SearchQuestion[] = [
  { from: 'request', text: 'The backpack should hold more stuff', answers: ['src/items/inventory.ts'] },
  { from: 'request', text: 'Make the bad guys smarter about getting around walls', answers: ['src/entities/pathfinding.ts', 'src/entities/monster.ts'] },
  { from: 'request', text: 'Potions are too expensive on the later floors', answers: ['src/items/shop.ts'] },
  { from: 'request', text: 'The health bar is too small on my phone', answers: ['src/ui/hud.ts'] },
  { from: 'request', text: 'I want a new kind of enemy, a giant snail', answers: ['src/entities/monsterTypes.ts'] },
  { from: 'request', text: 'The music should change when you reach the boss', answers: ['src/audio/music.ts'] },
  { from: 'request', text: 'Fix the typo on the first screen', answers: ['src/ui/titleScreen.ts', 'src/i18n/strings.ts'] },
  { from: 'request', text: 'The buttons you press with your thumbs are too close together', answers: ['src/game/touch.ts'] },
  { from: 'request', text: 'Chests should give better stuff the deeper you go', answers: ['src/items/loot.ts', 'src/dungeon/populate.ts'] },
  { from: 'request', text: 'Cheaters are posting scores nobody could really get', answers: ['server/antiCheat.ts'] },
  { from: 'request', text: 'The login email never arrives', answers: ['server/mailer.ts', 'server/auth.ts'] },
  { from: 'request', text: 'Make the dark areas a bit brighter', answers: ['src/render/lighting.ts'] },
  { from: 'request', text: 'The rooms are too cramped, make the dungeon more open', answers: ['src/dungeon/rooms.ts', 'src/dungeon/generate.ts'] },
  { from: 'request', text: "It's hard to tell which parts of the level I've already been to", answers: ['src/dungeon/fog.ts', 'src/ui/minimap.ts'] },
  { from: 'request', text: 'Add a fire arrow spell', answers: ['src/combat/abilities.ts'] },
  { from: 'request', text: 'Poison lasts way too long', answers: ['src/combat/statusEffects.ts'] },
  { from: 'request', text: 'The screen should rumble more when the boss stomps', answers: ['src/render/screenShake.ts'] },
  { from: 'request', text: 'Uploading the game to the website failed', answers: ['scripts/ship.mjs'] },
  { from: 'request', text: 'The old man in the cave should say something different after you beat the knight', answers: ['src/entities/npc.ts', 'src/ui/dialogue.ts'] },
  { from: 'request', text: 'Let players pick easy mode from the menu', answers: ['src/game/difficulty.ts', 'src/ui/optionsScreen.ts', 'src/game/settings.ts'] },
  { from: 'request', text: 'The walking looks jerky', answers: ['src/render/animation.ts'] },
  { from: 'request', text: "Where's the list of who's winning this month?", answers: ['src/ui/leaderboard.ts', 'server/scores.ts'] },
  { from: 'request', text: 'Add a way to brew an antidote', answers: ['src/items/crafting.ts'] },
  { from: 'request', text: 'The spikes hurt too much', answers: ['src/dungeon/traps.ts'] },
  { from: 'request', text: "New players don't understand how to open their bag", answers: ['src/ui/tutorial.ts'] },
  { from: 'request', text: 'The letters are hard to read, can they have a dark edge?', answers: ['src/ui/text.ts'] },
  { from: 'request', text: "I want the game to have its own icon on my phone's home screen", answers: ['public/manifest.webmanifest'] },
  { from: 'request', text: "The view doesn't follow the hero properly near the edge of the map", answers: ['src/game/camera.ts'] },
  { from: 'request', text: "Swords should make you hit harder when you're holding one", answers: ['src/items/equipment.ts', 'src/items/items.ts'] },
  { from: 'request', text: "What I did on my phone doesn't show up on my computer", answers: ['src/game/cloudSync.ts', 'server/saves.ts'] },

  { from: 'query', text: 'game loop', answers: ['src/game/loop.ts'] },
  { from: 'query', text: 'where is damage calculated', answers: ['src/combat/damage.ts'] },
  { from: 'query', text: 'sprite atlas loading', answers: ['src/render/sprites.ts', 'scripts/packSprites.mjs'] },
  { from: 'query', text: 'localStorage persistence', answers: ['src/game/save.ts'] },
  { from: 'query', text: 'rate limiting', answers: ['server/index.ts'] },
  { from: 'query', text: 'seeded PRNG', answers: ['src/game/rng.ts'] },
  { from: 'query', text: 'boss attack patterns', answers: ['src/entities/bosses.ts'] },
  { from: 'query', text: 'HiDPI canvas scaling', answers: ['src/render/canvas.ts'] },
  { from: 'query', text: 'localization strings', answers: ['src/i18n/strings.ts'] },
  { from: 'query', text: 'session cookie', answers: ['server/auth.ts'] },
  { from: 'query', text: 'keyboard input handler', answers: ['src/game/input.ts'] },
  { from: 'query', text: 'CI pipeline', answers: ['.github/workflows/ci.yml'] },
  { from: 'query', text: 'visualViewport resize handling', answers: ['src/ui/layout.ts'] },
  { from: 'query', text: 'level generation algorithm', answers: ['src/dungeon/generate.ts'] },
  { from: 'query', text: 'collision walkable tiles', answers: ['src/dungeon/tiles.ts'] },
  { from: 'query', text: 'fetch wrapper offline handling', answers: ['src/net/api.ts'] },
  { from: 'query', text: 'notification popup component', answers: ['src/ui/toast.ts'] },
  { from: 'query', text: 'cron job that clears scores', answers: ['server/monthlyReset.ts'] },
  { from: 'query', text: 'pub/sub', answers: ['src/util/events.ts'] },
  { from: 'query', text: 'FPS counter', answers: ['src/debug/overlay.ts'] },
  { from: 'query', text: 'mock canvas for tests', answers: ['tests/fakeCanvas.ts'] },
  { from: 'query', text: 'vite config', answers: ['vite.config.ts'] },
  { from: 'query', text: 'script that checks for US spellings', answers: ['scripts/checkStrings.mjs'] },
  { from: 'query', text: 'monster spawn tables per floor', answers: ['src/dungeon/populate.ts', 'src/entities/monsterTypes.ts'] },
  { from: 'query', text: 'sound effects playback', answers: ['src/audio/sfx.ts'] },
  { from: 'query', text: 'database schema creation', answers: ['server/db.ts'] },
  { from: 'query', text: 'level up XP thresholds', answers: ['src/entities/player.ts'] },
  { from: 'query', text: 'accessibility colours', answers: ['src/render/palette.ts', 'src/ui/optionsScreen.ts'] },
  { from: 'query', text: 'locked door keys', answers: ['src/dungeon/doors.ts'] },
  { from: 'query', text: 'SMTP', answers: ['server/mailer.ts'] }
]

/** Messages no fact or file should be attached to. */
export const OFF_TOPIC: string[] = [
  'thanks, that looks great',
  'ok go ahead',
  'yes do it',
  'what do you think we should work on next?',
  "hmm, not sure I like it. can you undo that?",
  'good morning! ready when you are',
  'can you explain that again more simply?',
  'commit that please'
]

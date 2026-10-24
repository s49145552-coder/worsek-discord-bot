const discord = require("discord.js");
const { AttachmentBuilder } = require("discord.js");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
} = require("@discordjs/voice");

// ==== Put your tokens directly here ====
const DISCORD_TOKEN = "MTU2MzY0MDQ5MTkwNjY5NTE5MA.Gmu0tw.4Hpm-tOU0FO0O4Ffng0Q9qdIe7eGJH-S_k0mdk";
const HENRIK_API_KEY = "HDEV-227d3005-f62d-4e82-8a55-6a57871971b1";

// ==== Client setup ====
const client = new discord.Client({
  intents: [
    discord.GatewayIntentBits.Guilds,
    discord.GatewayIntentBits.GuildMessages,
    discord.GatewayIntentBits.MessageContent,
    discord.GatewayIntentBits.GuildVoiceStates,
  ],
});

client.once(discord.Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Bot status: Do Not Disturb + "Watching .gg/worsek"
  client.user.setPresence({
    status: "dnd",
    activities: [
      { name: ".gg/worsek", type: discord.ActivityType.Watching },
    ],
  });

  await joinVoice();
});

// ==== Configuration ====
const REGION = "eu"; // eu, na, ap, kr, latam, br
const VOICE_CHANNEL_ID = "1561044890853318697"; // right-click the VC -> Copy Channel ID

// ==== Auto-join voice channel (self-muted + self-deafened) ====
async function joinVoice() {
  try {
    const channel = await client.channels.fetch(VOICE_CHANNEL_ID);
    if (!channel || !channel.isVoiceBased()) {
      console.error("VOICE_CHANNEL_ID is not a valid voice channel.");
      return;
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfMute: true,
      selfDeaf: true,
    });

    console.log(`Joined voice channel: ${channel.name}`);

    // If the bot gets disconnected, try to reconnect; if that fails, rejoin from scratch
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Discord is moving the bot to another channel, it will reconnect on its own
      } catch {
        connection.destroy();
        setTimeout(joinVoice, 5_000);
      }
    });
  } catch (err) {
    console.error("Could not join voice channel:", err);
  }
}

// ==== Rank icon helpers ====
// Official rank icons from valorant-api.com (tier 0-2 = unranked/unused -> no icon)
function tierIconUrl(tier) {
  if (!tier || tier < 3) return null;
  return `https://media.valorant-api.com/competitivetiers/03621f52-342b-cf4e-4f86-9350a49c6d04/${tier}/smallicon.png`;
}

async function safeLoadImage(url) {
  if (!url) return null;
  try {
    return await loadImage(url);
  } catch {
    return null;
  }
}

// ==== Agent portrait helpers ====
// Agent icons from valorant-api.com. The agent list is cached for an hour.
let agentIconMap = null;
let agentIconMapFetchedAt = 0;

// "KAY/O" -> "kayo", "Kay/o" -> "kayo" so names from both APIs match
function normalizeAgentName(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function getAgentIconUrls() {
  const oneHour = 60 * 60 * 1000;
  if (agentIconMap && Date.now() - agentIconMapFetchedAt < oneHour) {
    return agentIconMap;
  }
  try {
    const res = await fetch(
      "https://valorant-api.com/v1/agents?isPlayableCharacter=true"
    );
    const json = await res.json();
    const map = {};
    for (const a of json?.data ?? []) {
      map[normalizeAgentName(a.displayName)] = a.displayIcon;
    }
    agentIconMap = map;
    agentIconMapFetchedAt = Date.now();
  } catch {
    if (!agentIconMap) agentIconMap = {};
  }
  return agentIconMap;
}

// Returns { "Jett": Image | null, "Sage": Image | null, ... }
async function loadAgentImages(agentNames) {
  const urls = await getAgentIconUrls();
  const result = {};
  await Promise.all(
    (agentNames || []).map(async (agent) => {
      result[agent] = await safeLoadImage(urls[normalizeAgentName(agent)]);
    })
  );
  return result;
}

// ==== Command handler ====
// Usage in Discord chat: !tracker Name #1234
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!tracker")) return;

  const args = message.content.slice("!tracker".length).trim().split(/\s+/);

  if (args.length < 2) {
    return message.reply(
      "Please provide a name and tag, e.g. `!tracker Erem #1234`"
    );
  }

  // Last word is the tag (with or without #), everything before it is the name
  let tag = args.pop();
  tag = tag.replace("#", "");
  const name = args.join(" ");

  if (!name || !tag) {
    return message.reply(
      "Please provide a name and tag, e.g. `!tracker Erem #1234`"
    );
  }

  const loadingMsg = await message.reply("Loading Valorant stats...");

  try {
    const stats = await fetchValorantStats(name.trim(), tag.trim());

    // Load the rank icons before drawing (null if they can't be loaded)
    stats.rankImg = await safeLoadImage(stats.rankIconUrl);
    stats.peakImg = await safeLoadImage(stats.peakIconUrl);
    stats.agentImgs = await loadAgentImages(stats.mostPlayed);

    const imageBuffer = generateValorantCard(stats);
    const attachment = new AttachmentBuilder(imageBuffer, {
      name: "valorant-profile.png",
    });

    await loadingMsg.edit({ content: "", files: [attachment] });
  } catch (err) {
    console.error(err);
    await loadingMsg.edit(
      "Could not load stats. Check the name#tag, region, or your API key."
    );
  }
});

/**
 * Fetches rank, level, K/D, win rate, headshot% and most played agents
 * via the HenrikDev Valorant API.
 */
async function fetchValorantStats(name, tag) {
  const headers = { Authorization: HENRIK_API_KEY };

  // 1) Account info (level, puuid)
  const accountRes = await fetch(
    `https://api.henrikdev.xyz/valorant/v1/account/${encodeURIComponent(
      name
    )}/${encodeURIComponent(tag)}`,
    { headers }
  );
  const accountData = await accountRes.json();
  const level = accountData?.data?.account_level ?? "-";

  // 2) Rank + peak rank (MMR)
  const mmrRes = await fetch(
    `https://api.henrikdev.xyz/valorant/v2/mmr/${REGION}/${encodeURIComponent(
      name
    )}/${encodeURIComponent(tag)}`,
    { headers }
  );
  const mmrData = await mmrRes.json();
  const rank = mmrData?.data?.current_data?.currenttierpatched ?? "Unranked";
  const peak =
    mmrData?.data?.highest_rank?.patched_tier ??
    mmrData?.data?.peak_data?.tier?.name ??
    "-";

  // Tier numbers, used for the rank icons
  const currentTier = mmrData?.data?.current_data?.currenttier ?? 0;
  const peakTier = mmrData?.data?.highest_rank?.tier ?? 0;

  // 3) Recent matches -> K/D, win rate, headshot%, top agents
  const matchesRes = await fetch(
    `https://api.henrikdev.xyz/valorant/v3/matches/${REGION}/${encodeURIComponent(
      name
    )}/${encodeURIComponent(tag)}?size=10`,
    { headers }
  );
  const matchesData = await matchesRes.json();
  const matches = matchesData?.data ?? [];

  let kills = 0,
    deaths = 0,
    wins = 0,
    headshotCount = 0,
    totalShots = 0;
  const agentCounts = {};
  const form = []; // "W" / "L" for the most recent matches, newest first

  for (const match of matches) {
    const puuid = accountData?.data?.puuid;
    const playerStats = match.players?.all_players?.find(
      (p) => p.puuid === puuid
    );
    if (!playerStats) continue;

    kills += playerStats.stats.kills;
    deaths += playerStats.stats.deaths;
    headshotCount += playerStats.stats.headshots ?? 0;
    totalShots +=
      (playerStats.stats.headshots ?? 0) +
      (playerStats.stats.bodyshots ?? 0) +
      (playerStats.stats.legshots ?? 0);

    const agent = playerStats.character;
    agentCounts[agent] = (agentCounts[agent] || 0) + 1;

    const playerTeam = playerStats.team;
    const teamWon =
      match.teams?.[playerTeam.toLowerCase()]?.has_won ?? false;
    if (teamWon) wins += 1;
    if (form.length < 5) form.push(teamWon ? "W" : "L");
  }

  const kd = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);
  const winRate =
    matches.length > 0 ? Math.round((wins / matches.length) * 100) : 0;
  const headshotPct =
    totalShots > 0 ? Math.round((headshotCount / totalShots) * 100) : 0;
  const mostPlayed = Object.entries(agentCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([agent]) => agent);

  return {
    player: `${name}#${tag}`,
    rank,
    peak,
    rankIconUrl: tierIconUrl(currentTier),
    peakIconUrl: tierIconUrl(peakTier),
    level,
    kd,
    winRate,
    headshot: headshotPct,
    mostPlayed,
    matchesPlayed: matches.length,
    form,
  };
}

function getRankColor(rank) {
  const r = (rank || "").toLowerCase();
  if (r.includes("radiant")) return "#f5e6a8";
  if (r.includes("immortal")) return "#e04b6b";
  if (r.includes("ascendant")) return "#3ddc97";
  if (r.includes("diamond")) return "#c186ff";
  if (r.includes("platinum")) return "#4fd3e8";
  if (r.includes("gold")) return "#f2c94c";
  if (r.includes("silver")) return "#c7d0d8";
  if (r.includes("bronze")) return "#d68a4c";
  if (r.includes("iron")) return "#7a8288";
  return "#8b9aa8";
}

function getAgentColor(agent) {
  const colors = {
    Jett: "#8fd8ff",
    Sage: "#7fd4c1",
    Omen: "#8b7fd4",
    Reyna: "#c17fd4",
    Phoenix: "#ff9a5c",
    Sova: "#6fa8dc",
    Killjoy: "#e8d95c",
    Cypher: "#c8c8c8",
    Viper: "#7fce7a",
    Brimstone: "#d17a4a",
    Raze: "#f2a65c",
    Breach: "#e0834a",
    Skye: "#a3d477",
    Yoru: "#5c7ce8",
    Astra: "#a87fe8",
    "Kay/o": "#8fa3ad",
    Chamber: "#d4b56a",
    Neon: "#7ecbff",
    Fade: "#9a7fc9",
    Harbor: "#5cc9d1",
    Gekko: "#a3d15c",
    Deadlock: "#8ba3b0",
    Iso: "#c98fd1",
    Clove: "#e88fc9",
    Vyse: "#7a8fd1",
    Tejo: "#e0a55c",
    Waylay: "#5cd1c9",
  };
  return colors[agent] || "#ff6b78";
}

function getAgentRole(agent) {
  const roles = {
    Jett: "Duelist",
    Reyna: "Duelist",
    Phoenix: "Duelist",
    Raze: "Duelist",
    Yoru: "Duelist",
    Neon: "Duelist",
    Iso: "Duelist",
    Waylay: "Duelist",
    Sova: "Initiator",
    Breach: "Initiator",
    Skye: "Initiator",
    "Kay/o": "Initiator",
    Fade: "Initiator",
    Gekko: "Initiator",
    Tejo: "Initiator",
    Brimstone: "Controller",
    Omen: "Controller",
    Viper: "Controller",
    Astra: "Controller",
    Harbor: "Controller",
    Clove: "Controller",
    Sage: "Sentinel",
    Cypher: "Sentinel",
    Killjoy: "Sentinel",
    Chamber: "Sentinel",
    Deadlock: "Sentinel",
    Vyse: "Sentinel",
  };
  return roles[agent] || "Agent";
}

/**
 * Builds the Valorant profile card as a PNG buffer.
 * @param {Object} stats
 * @param {string} stats.player        e.g. "Erem#1234"
 * @param {string} stats.rank          e.g. "Diamond 2"
 * @param {string} stats.peak          e.g. "Immortal 1"
 * @param {Image|null} stats.rankImg   loaded rank icon (optional)
 * @param {Image|null} stats.peakImg   loaded peak rank icon (optional)
 * @param {number|string} stats.level  e.g. 187
 * @param {string|number} stats.kd     e.g. "1.24"
 * @param {string|number} stats.winRate    e.g. 57 (percent)
 * @param {string|number} stats.headshot   e.g. 24 (percent)
 * @param {string[]} stats.mostPlayed  e.g. ["Jett", "Sage", "Omen"]
 */
function generateValorantCard(stats) {
  // Internal layout is designed at this size...
  const width = 500;
  const height = 320;
  const pad = 24;

  // ...but the actual exported image is smaller. Everything below is scaled down.
  const outputWidth = 360;
  const outputHeight = Math.round((outputWidth / width) * height);

  const canvas = createCanvas(outputWidth, outputHeight);
  const ctx = canvas.getContext("2d");
  ctx.scale(outputWidth / width, outputHeight / height);

  // Rectangle with the top-left and bottom-right corners cut off (tactical/HUD look)
  function chamferRect(x, y, w, h, c) {
    ctx.beginPath();
    ctx.moveTo(x + c, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h - c);
    ctx.lineTo(x + w - c, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + c);
    ctx.closePath();
  }

  // Uppercase text with manual letter-spacing ("tracking"), left-aligned
  function drawTracked(text, x, y, spacing) {
    ctx.textAlign = "left";
    let curX = x;
    for (const ch of text) {
      ctx.fillText(ch, curX, y);
      curX += ctx.measureText(ch).width + spacing;
    }
  }

  const rankColor = getRankColor(stats.rank);
  const topAgentName =
    stats.mostPlayed && stats.mostPlayed.length > 0
      ? stats.mostPlayed[0]
      : null;
  const agentColor = topAgentName ? getAgentColor(topAgentName) : "#ff4655";

  // --- Outer frame ---
  chamferRect(0, 0, width, height, 24);
  ctx.save();
  ctx.clip();

  // Background: darker, flatter base for more contrast (less "washed out")
  const bgGradient = ctx.createLinearGradient(0, 0, width, height);
  bgGradient.addColorStop(0, "#030406");
  bgGradient.addColorStop(0.55, "#080a0f");
  bgGradient.addColorStop(1, "#0b0d13");
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // Subtle diagonal slashes, tinted with the top agent's color (kept low so the card stays crisp)
  ctx.save();
  ctx.globalAlpha = 0.045;
  ctx.fillStyle = agentColor;
  ctx.beginPath();
  ctx.moveTo(width * 0.58, -20);
  ctx.lineTo(width * 0.74, -20);
  ctx.lineTo(width * 0.38, height + 20);
  ctx.lineTo(width * 0.22, height + 20);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Vignette: darkens the edges so the center content pops
  const vignette = ctx.createRadialGradient(
    width / 2,
    height / 2,
    height * 0.25,
    width / 2,
    height / 2,
    height * 0.85
  );
  vignette.addColorStop(0, "transparent");
  vignette.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  // Small, tight glow behind the avatar only, tinted with the top agent's color
  const glow = ctx.createRadialGradient(58, 58, 0, 58, 58, 95);
  glow.addColorStop(0, agentColor + "38");
  glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  // Top ribbon banner, agent color fading into rank color
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(width, 0);
  ctx.lineTo(width, 10);
  ctx.lineTo(0, 16);
  ctx.closePath();
  const ribbonGradient = ctx.createLinearGradient(0, 0, width, 0);
  ribbonGradient.addColorStop(0, agentColor);
  ribbonGradient.addColorStop(1, rankColor);
  ctx.fillStyle = ribbonGradient;
  ctx.fill();

  // --- Header: square chamfered avatar, name, agent tag ---
  const avatarSize = 56;
  const avatarX = pad;
  const avatarY = 34;
  const nameForInitial = (stats.player ?? "?").split("#")[0];

  chamferRect(avatarX, avatarY, avatarSize, avatarSize, 12);
  const avatarGradient = ctx.createLinearGradient(
    avatarX,
    avatarY,
    avatarX + avatarSize,
    avatarY + avatarSize
  );
  avatarGradient.addColorStop(0, agentColor);
  avatarGradient.addColorStop(1, "#15181d");
  ctx.fillStyle = avatarGradient;
  ctx.fill();
  ctx.strokeStyle = agentColor;
  ctx.lineWidth = 2;
  ctx.stroke();

  const mainImg = topAgentName ? stats.agentImgs?.[topAgentName] : null;
  if (mainImg) {
    // Main agent portrait, clipped to the chamfered avatar shape
    ctx.save();
    chamferRect(avatarX, avatarY, avatarSize, avatarSize, 12);
    ctx.clip();
    ctx.drawImage(mainImg, avatarX, avatarY, avatarSize, avatarSize);
    ctx.restore();

    chamferRect(avatarX, avatarY, avatarSize, avatarSize, 12);
    ctx.strokeStyle = agentColor;
    ctx.lineWidth = 2;
    ctx.stroke();
  } else {
    // Fallback: first letter of the player name
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 26px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      nameForInitial.charAt(0).toUpperCase(),
      avatarX + avatarSize / 2,
      avatarY + avatarSize / 2 + 2
    );
    ctx.textBaseline = "alphabetic";
  }

  const nameX = avatarX + avatarSize + 16;
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 24px Arial";
  ctx.textAlign = "left";
  ctx.fillText((stats.player ?? "Unknown").toUpperCase(), nameX, avatarY + 24);

  ctx.font = "bold 10px Arial";
  ctx.fillStyle = topAgentName ? agentColor : "#7a8a97";
  drawTracked(
    topAgentName
      ? `MAIN: ${topAgentName.toUpperCase()} \u2022 ${getAgentRole(
          topAgentName
        ).toUpperCase()}`
      : "NO MAIN AGENT YET",
    nameX,
    avatarY + 44,
    1.4
  );

  // Level tag, top right, chamfered
  const levelText = `LV ${stats.level ?? "-"}`;
  ctx.font = "bold 12px Arial";
  const levelPad = 14;
  const levelW = ctx.measureText(levelText).width + levelPad * 2;
  const levelX = width - pad - levelW;
  const levelY = 30;
  chamferRect(levelX, levelY, levelW, 24, 8);
  ctx.fillStyle = "rgba(255,255,255,0.09)";
  ctx.fill();
  ctx.strokeStyle = agentColor + "aa";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.fillText(levelText, levelX + levelW / 2, levelY + 16);

  // --- Matches played + recent form row (fills the gap, adds real content) ---
  const metaY = 88;
  ctx.textAlign = "left";
  ctx.fillStyle = "#9aa8b4";
  ctx.font = "bold 10px Arial";
  const matchesText = `${stats.matchesPlayed ?? 0} MATCHES TRACKED`;
  ctx.fillText(matchesText, avatarX, metaY);

  const form = stats.form && stats.form.length > 0 ? stats.form : [];
  const formLabelX = avatarX + ctx.measureText(matchesText).width + 16;
  ctx.fillStyle = "#9aa8b4";
  ctx.font = "bold 10px Arial";
  ctx.fillText("FORM", formLabelX, metaY);

  let dotX = formLabelX + 34;
  for (let i = 0; i < 5; i++) {
    const result = form[i];
    ctx.beginPath();
    ctx.arc(dotX, metaY - 3, 5, 0, Math.PI * 2);
    if (result === "W") {
      ctx.fillStyle = "#3ddc97";
    } else if (result === "L") {
      ctx.fillStyle = "#e0546b";
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.12)";
    }
    ctx.fill();
    dotX += 14;
  }

  // --- Rank banner: full-width slanted parallelogram ---
  const rankY = 104;
  const rankH = 38;
  ctx.beginPath();
  ctx.moveTo(pad, rankY);
  ctx.lineTo(width - pad, rankY);
  ctx.lineTo(width - pad - 14, rankY + rankH);
  ctx.lineTo(Math.max(pad - 14, 0), rankY + rankH);
  ctx.closePath();
  const rankBgGradient = ctx.createLinearGradient(
    pad,
    rankY,
    width - pad,
    rankY
  );
  rankBgGradient.addColorStop(0, rankColor + "30");
  rankBgGradient.addColorStop(1, "rgba(255,255,255,0.02)");
  ctx.fillStyle = rankBgGradient;
  ctx.fill();
  ctx.strokeStyle = rankColor + "70";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Rank icon (left side of the banner)
  const iconSize = 32;
  const rankIconX = pad + 8;
  let rankTextX = pad + 4;
  if (stats.rankImg) {
    ctx.drawImage(stats.rankImg, rankIconX, rankY + 3, iconSize, iconSize);
    rankTextX = rankIconX + iconSize + 8;
  }

  ctx.fillStyle = "#aab8c4";
  ctx.font = "bold 9px Arial";
  drawTracked("CURRENT RANK", rankTextX, rankY + 14, 1.4);

  ctx.fillStyle = rankColor;
  ctx.font = "bold 19px Arial";
  ctx.textAlign = "left";
  ctx.fillText((stats.rank ?? "Unranked").toUpperCase(), rankTextX, rankY + 32);

  // Peak rank icon (right side of the banner)
  const peakText = `PEAK ${(stats.peak ?? "-").toString().toUpperCase()}`;
  const peakIconSize = 22;
  let peakTextRight = width - pad - 18;
  if (stats.peakImg) {
    const peakIconX = width - pad - 18 - peakIconSize;
    ctx.drawImage(
      stats.peakImg,
      peakIconX,
      rankY + 8,
      peakIconSize,
      peakIconSize
    );
    peakTextRight = peakIconX - 6;
  }
  ctx.font = "bold 11px Arial";
  ctx.fillStyle = "#aab8c4";
  ctx.textAlign = "right";
  ctx.fillText(peakText, peakTextRight, rankY + 23);

  // --- Stat tiles ---
  const stats3 = [
    { label: "K / D", value: stats.kd ?? "-" },
    { label: "WIN %", value: `${stats.winRate ?? "-"}` },
    { label: "HS %", value: `${stats.headshot ?? "-"}` },
  ];
  const tileGap = 10;
  const tileY = 154;
  const tileH = 64;
  const tileW = (width - pad * 2 - tileGap * 2) / 3;

  stats3.forEach((s, i) => {
    const x = pad + i * (tileW + tileGap);
    chamferRect(x, tileY, tileW, tileH, 10);
    const tileGradient = ctx.createLinearGradient(x, tileY, x, tileY + tileH);
    tileGradient.addColorStop(0, "rgba(255,255,255,0.08)");
    tileGradient.addColorStop(1, "rgba(255,255,255,0.02)");
    ctx.fillStyle = tileGradient;
    ctx.fill();
    ctx.strokeStyle = agentColor + "55";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = agentColor;
    ctx.fillRect(x, tileY, 3, tileH);

    ctx.textAlign = "center";
    ctx.fillStyle = "#9aa8b4";
    ctx.font = "bold 9px Arial";
    ctx.fillText(s.label, x + tileW / 2, tileY + 21);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 25px Arial";
    ctx.fillText(String(s.value), x + tileW / 2, tileY + 48);
  });

  // --- Most played agents, shown as compact profile cards ---
  const agentsY = 236;
  ctx.textAlign = "left";
  ctx.fillStyle = "#9aa8b4";
  ctx.font = "bold 9px Arial";
  drawTracked("AGENT PROFILES", pad, agentsY, 1.4);

  const agents =
    stats.mostPlayed && stats.mostPlayed.length > 0
      ? stats.mostPlayed.slice(0, 3)
      : [];

  const profileGap = 10;
  const profileY = agentsY + 12;
  const profileH = 60;
  const profileCount = agents.length > 0 ? agents.length : 3;
  const profileW =
    (width - pad * 2 - profileGap * (profileCount - 1)) / profileCount;

  for (let i = 0; i < profileCount; i++) {
    const agent = agents[i];
    const x = pad + i * (profileW + profileGap);
    const agentC = agent ? getAgentColor(agent) : "#2a323a";

    chamferRect(x, profileY, profileW, profileH, 10);
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fill();
    ctx.strokeStyle = agent ? agentC + "60" : "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.stroke();

    if (!agent) {
      ctx.fillStyle = "#4a5661";
      ctx.font = "10px Arial";
      ctx.textAlign = "center";
      ctx.fillText("NO DATA", x + profileW / 2, profileY + profileH / 2 + 3);
      continue;
    }

    // Avatar badge with initial
    const badgeR = 18;
    const badgeX = x + 12 + badgeR;
    const badgeY = profileY + profileH / 2;
    ctx.beginPath();
    ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2);
    const badgeGradient = ctx.createLinearGradient(
      badgeX - badgeR,
      badgeY - badgeR,
      badgeX + badgeR,
      badgeY + badgeR
    );
    badgeGradient.addColorStop(0, agentC);
    badgeGradient.addColorStop(1, "#15181d");
    ctx.fillStyle = badgeGradient;
    ctx.fill();
    ctx.strokeStyle = agentC;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const agentImg = stats.agentImgs?.[agent];
    if (agentImg) {
      // Agent portrait, clipped to the circular badge
      ctx.save();
      ctx.beginPath();
      ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(
        agentImg,
        badgeX - badgeR,
        badgeY - badgeR,
        badgeR * 2,
        badgeR * 2
      );
      ctx.restore();

      // Re-draw the ring on top of the portrait
      ctx.beginPath();
      ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2);
      ctx.strokeStyle = agentC;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      // Fallback: first letter of the agent name
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 14px Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(agent.charAt(0).toUpperCase(), badgeX, badgeY + 1);
      ctx.textBaseline = "alphabetic";
    }

    // Rank badge (1st / 2nd / 3rd main), top-left corner of the tile
    ctx.fillStyle = agentC;
    ctx.font = "bold 8px Arial";
    ctx.textAlign = "left";
    ctx.fillText(`#${i + 1}`, x + 6, profileY + 11);

    // Name + role
    const textX = badgeX + badgeR + 8;
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 12px Arial";
    ctx.textAlign = "left";
    ctx.fillText(agent, textX, profileY + profileH / 2 - 2);

    ctx.fillStyle = "#9aa8b4";
    ctx.font = "9px Arial";
    ctx.fillText(getAgentRole(agent), textX, profileY + profileH / 2 + 12);
  }

  ctx.restore();

  // --- Outer border, matching the chamfered frame ---
  chamferRect(0.5, 0.5, width - 1, height - 1, 24);
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // --- HUD corner brackets on the two square corners ---
  function bracket(x, y, dx, dy, len) {
    ctx.beginPath();
    ctx.moveTo(x, y + dy * len);
    ctx.lineTo(x, y);
    ctx.lineTo(x + dx * len, y);
    ctx.strokeStyle = agentColor;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  bracket(width - 6, 6, -1, 1, 18);
  bracket(6, height - 6, 1, -1, 18);

  return canvas.toBuffer("image/png");
}

// ==== Login ====
if (!DISCORD_TOKEN || DISCORD_TOKEN === "YOUR_DISCORD_TOKEN") {
  throw new Error(
    "Please set DISCORD_TOKEN at the top of this file before starting the bot."
  );
}

console.log("Starting login...");
client
  .login(DISCORD_TOKEN)
  .then(() => console.log("Login successful"))
  .catch((err) => console.error("Login failed:", err));
  // ============================================================================
// VALORANT NEWS FEED  -  paste this whole block into your index.js
//
// WHERE: below your client setup and above the "// ==== Login ====" section
// NEEDS: `discord`, `client` and `HENRIK_API_KEY` (you already have all three)
// BOT PERMISSIONS in the news channel: View Channel, Send Messages, Embed Links
// No extra npm packages and no extra intents required (Node 18+ for fetch).
// ============================================================================

const newsFs = require("node:fs");
const newsPath = require("node:path");

// ---- Settings --------------------------------------------------------------
const NEWS_CHANNEL_ID = "1554900966237675561"; // right-click channel -> Copy Channel ID
const NEWS_CHECK_INTERVAL_MIN = 10; // how often to look for new articles
const NEWS_MAX_POSTS_PER_CHECK = 5; // flood protection per check
const NEWS_POST_BACKLOG_ON_FIRST_RUN = true; // false = only post articles that appear AFTER the first start
const NEWS_SEEN_FILE = newsPath.join(__dirname, "news_seen.json"); // remembers posted articles

// ---- Sources (add / remove freely) ------------------------------------------
// type "henrik": official playvalorant.com news via your HenrikDev API key
// type "rss":    any RSS/Atom feed URL
const NEWS_SOURCES = [
  { type: "henrik", name: "Official VALORANT News", locale: "en-us", color: 0xff4655 },
  { type: "rss", name: "Dot Esports", url: "https://dotesports.com/valorant/feed", color: 0x1e90ff },
  { type: "rss", name: "Fragster", url: "https://www.fragster.com/valorant/feed/", color: 0x9b59b6 },
  { type: "rss", name: "GameRiv", url: "https://gameriv.com/valorant/feed/", color: 0x2ecc71 },
  // More ideas (untested, check that the URL returns XML in your browser first):
  // { type: "rss", name: "VLR.gg", url: "https://www.vlr.gg/rss", color: 0xe67e22 },
  // { type: "rss", name: "Gamer Journalist", url: "https://gamerjournalist.com/valorant/feed/", color: 0xf1c40f },
];

// ---- Small helpers -----------------------------------------------------------
function newsDecode(str) {
  return (str || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function newsStripHtml(html) {
  return newsDecode(
    newsDecode(html)
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/The post .* appeared first on .*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function newsGetTag(block, name) {
  const m = block.match(
    new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i")
  );
  if (!m) return "";
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
}

function newsFindImage(block) {
  const patterns = [
    /<media:content[^>]*url=["']([^"']+)["']/i,
    /<media:thumbnail[^>]*url=["']([^"']+)["']/i,
    /<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']image/i,
    /<enclosure[^>]*type=["']image[^>]*url=["']([^"']+)["']/i,
    /<img[^>]*src=["']([^"']+)["']/i,
  ];
  for (const hay of [block, newsDecode(block)]) {
    for (const p of hay === block ? patterns : patterns.slice(-1)) {
      const m = hay.match(p);
      if (m && /^https?:\/\//i.test(newsDecode(m[1]))) return newsDecode(m[1]);
    }
  }
  return null;
}

function newsNormalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return (u || "").trim();
  }
}

function newsToDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const newsSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Fetching ------------------------------------------------------------------
function newsParseRss(xml) {
  const blocks =
    xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ||
    xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ||
    [];

  return blocks.map((block) => {
    const hrefMatch = block.match(/<link[^>]*href=["']([^"']+)["']/i); // Atom
    const url = newsDecode(newsGetTag(block, "link") || (hrefMatch ? hrefMatch[1] : ""));
    const body =
      newsGetTag(block, "description") ||
      newsGetTag(block, "summary") ||
      newsGetTag(block, "content:encoded") ||
      newsGetTag(block, "content");
    const dateRaw =
      newsGetTag(block, "pubDate") ||
      newsGetTag(block, "published") ||
      newsGetTag(block, "updated") ||
      newsGetTag(block, "dc:date");

    return {
      title: newsStripHtml(newsGetTag(block, "title")),
      url: url.trim(),
      description: newsStripHtml(body),
      image: newsFindImage(block),
      date: newsToDate(dateRaw),
    };
  });
}

async function newsFetchRss(source) {
  const res = await fetch(source.url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ValorantNewsBot/1.0)",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return newsParseRss(await res.text());
}

async function newsFetchHenrik(source) {
  const res = await fetch(
    `https://api.henrikdev.xyz/valorant/v1/website/${source.locale || "en-us"}`,
    {
      headers: { Authorization: HENRIK_API_KEY },
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return (json?.data ?? []).map((a) => ({
    title: a.title || "",
    url: a.url || a.external_link || "",
    description: a.category ? `Category: ${a.category}` : "",
    image: a.banner_url || null,
    date: newsToDate(a.date),
  }));
}

// ---- "Already posted" memory ----------------------------------------------------
function newsLoadSeen() {
  try {
    const data = JSON.parse(newsFs.readFileSync(NEWS_SEEN_FILE, "utf8"));
    return { set: new Set(data.seen || []), firstRun: false };
  } catch {
    return { set: new Set(), firstRun: true };
  }
}

function newsSaveSeen(set) {
  try {
    const seen = Array.from(set).slice(-2000); // keep the file small
    newsFs.writeFileSync(NEWS_SEEN_FILE, JSON.stringify({ seen }, null, 2));
  } catch (err) {
    console.error("[news] Could not save seen list:", err.message);
  }
}

// ---- Main loop -------------------------------------------------------------------
let newsRunning = false;

async function newsCheck() {
  if (newsRunning) return;
  newsRunning = true;

  try {
    const seen = newsLoadSeen();
    const fresh = [];
    let anySourceWorked = false;

    for (const source of NEWS_SOURCES) {
      let items;
      try {
        items =
          source.type === "henrik"
            ? await newsFetchHenrik(source)
            : await newsFetchRss(source);
        anySourceWorked = true;
      } catch (err) {
        console.warn(`[news] ${source.name} failed: ${err.message}`);
        continue;
      }

      for (const item of items) {
        if (!item.title || !item.url) continue;
        const id = newsNormalizeUrl(item.url);
        if (seen.set.has(id)) continue;
        seen.set.add(id);
        fresh.push({ ...item, source });
      }
    }

    if (!anySourceWorked) return; // nothing reachable, try again next time

    // First start: remember what already exists, don't flood the channel
    if (seen.firstRun && !NEWS_POST_BACKLOG_ON_FIRST_RUN) {
      newsSaveSeen(seen.set);
      console.log(`[news] First run: marked ${fresh.length} existing articles as seen.`);
      return;
    }

    if (fresh.length === 0) {
      newsSaveSeen(seen.set);
      return;
    }

    // Newest N articles, posted oldest -> newest
    fresh.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
    const toPost = fresh.slice(0, NEWS_MAX_POSTS_PER_CHECK).reverse();

    const channel = await client.channels.fetch(NEWS_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      console.error("[news] NEWS_CHANNEL_ID is not a valid text channel.");
      return; // don't save, so the articles are retried later
    }

    for (const item of toPost) {
      try {
        const embed = new discord.EmbedBuilder()
          .setColor(item.source.color ?? 0xff4655)
          .setTitle(item.title.slice(0, 256))
          .setURL(item.url)
          .setFooter({ text: item.source.name });

        if (item.description) {
          const text = item.description.length > 280
            ? item.description.slice(0, 277) + "..."
            : item.description;
          embed.setDescription(text);
        }
        if (item.image) embed.setImage(item.image);
        if (item.date) embed.setTimestamp(item.date);

        await channel.send({ embeds: [embed] });
        await newsSleep(1500);
      } catch (err) {
        console.error(`[news] Could not post "${item.title}":`, err.message);
      }
    }

    newsSaveSeen(seen.set);
    console.log(`[news] Posted ${toPost.length} article(s).`);
  } catch (err) {
    console.error("[news] Check failed:", err);
  } finally {
    newsRunning = false;
  }
}

// ---- Start when the bot is ready ------------------------------------------------
client.once(discord.Events.ClientReady, () => {
  if (NEWS_CHANNEL_ID === "YOUR_NEWS_CHANNEL_ID") {
    console.warn("[news] Set NEWS_CHANNEL_ID to enable the news feed.");
    return;
  }
  newsCheck();
  setInterval(newsCheck, NEWS_CHECK_INTERVAL_MIN * 60 * 1000);
});
// ============================================================================
// STRIKE SYSTEM + OWNER-ONLY SAY  -  paste this whole block into your index.js
//
// WHERE: below your client setup and above the "// ==== Login ====" section
// NEEDS: `discord` and `client` (you already have both) + the intents you
//        already use (Guilds, GuildMessages, MessageContent, GuildMembers)
//
// FILL IN: STRIKE_CHANNEL_ID, STRIKE_ALLOWED_ROLE_IDS, SAY_OWNER_ID
//
// COMMANDS
//   !strike @user reason   -> +1 strike, message in the strike channel,
//                             timeout at max strikes (only the allowed role)
//   !revoke @user          -> -1 strike, replies "REVOKED" to the strike message
//   !say [#channel] text   -> bot writes the text (ONLY YOU, SAY_OWNER_ID)
//
// BOT PERMISSIONS: View Channel, Send Messages, Read Message History,
//                  Moderate Members (timeout), Manage Messages (deletes your !say).
//                  The bot's role must be ABOVE the roles it should time out.
// ============================================================================

const strikeFs = require("node:fs");
const strikePath = require("node:path");

// ---- Settings --------------------------------------------------------------
const STRIKE_CHANNEL_ID = "1563496675249754172"; // channel where strike messages are posted
const STRIKE_MAX = 3; // strikes until the timeout
const STRIKE_TIMEOUT_HOURS = 24; // timeout length at max strikes
const STRIKE_REMOVE_TIMEOUT_ON_REVOKE = true; // revoking from 3/3 also lifts the timeout
const STRIKE_ALLOWED_ROLE_IDS = ["1559482317741883444"]; // ONLY these roles (and the server owner) can use !strike / !revoke
const STRIKE_FILE = strikePath.join(__dirname, "strikes.json");

// ---- Storage ---------------------------------------------------------------
let strikeData = {};
try {
  strikeData = JSON.parse(strikeFs.readFileSync(STRIKE_FILE, "utf8"));
} catch {
  /* no saved strikes yet */
}

function strikeSave() {
  try {
    strikeFs.writeFileSync(STRIKE_FILE, JSON.stringify(strikeData, null, 2));
  } catch (err) {
    console.error("[strike] Could not save strikes:", err.message);
  }
}

function strikeEntry(guildId, userId) {
  strikeData[guildId] ??= {};
  strikeData[guildId][userId] ??= { count: 0, messages: [] };
  return strikeData[guildId][userId];
}

// ---- Helpers ---------------------------------------------------------------
// Finds the target from a mention (or a plain user ID) and returns the reason text.
async function strikeResolveTarget(message, rest) {
  const mentioned = message.mentions.users?.first();
  if (mentioned) {
    const member =
      message.mentions.members?.first() ??
      (await message.guild.members.fetch(mentioned.id).catch(() => null));
    return {
      id: mentioned.id,
      user: mentioned,
      member,
      reason: rest.replace(/<@!?\d+>/, "").trim(),
    };
  }

  const idMatch = rest.match(/^(\d{17,20})\s*([\s\S]*)$/);
  if (idMatch) {
    const member = await message.guild.members.fetch(idMatch[1]).catch(() => null);
    return {
      id: idMatch[1],
      user: member?.user ?? null,
      member,
      reason: idMatch[2].trim(),
    };
  }

  return null;
}

function strikeCanUse(member) {
  if (!member) return false;
  return (
    member.id === member.guild.ownerId ||
    STRIKE_ALLOWED_ROLE_IDS.some((id) => member.roles.cache.has(id))
  );
}

// ---- Command handler -------------------------------------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const isStrike = /^!strike(\s|$)/i.test(message.content);
  const isRevoke = /^!revoke(\s|$)/i.test(message.content);
  if (!isStrike && !isRevoke) return;

  const noPing = { parse: [], repliedUser: false };

  if (!strikeCanUse(message.member)) {
    return message.reply({
      content: "You don't have permission to use this command.",
      allowedMentions: noPing,
    });
  }

  if (STRIKE_CHANNEL_ID === "YOUR_STRIKE_CHANNEL_ID") {
    return message.reply({
      content: "The strike channel is not configured yet (STRIKE_CHANNEL_ID).",
      allowedMentions: noPing,
    });
  }

  const strikeChannel = await client.channels.fetch(STRIKE_CHANNEL_ID).catch(() => null);
  if (!strikeChannel || !strikeChannel.isTextBased()) {
    return message.reply({
      content: "I can't find the strike channel. Check STRIKE_CHANNEL_ID and my permissions.",
      allowedMentions: noPing,
    });
  }

  const rest = message.content.replace(/^!(strike|revoke)\s*/i, "");
  const target = await strikeResolveTarget(message, rest);

  if (!target) {
    return message.reply({
      content: isStrike
        ? "Usage: `!strike @user reason`"
        : "Usage: `!revoke @user`",
      allowedMentions: noPing,
    });
  }

  try {
    // ======================= !strike =======================
    if (isStrike) {
      if (target.user?.bot) {
        return message.reply({ content: "You can't strike a bot.", allowedMentions: noPing });
      }
      if (target.id === message.author.id) {
        return message.reply({ content: "You can't strike yourself.", allowedMentions: noPing });
      }
      // The moderator must be above the target (the server owner is always allowed)
      if (
        target.member &&
        message.guild.ownerId !== message.author.id &&
        message.member.roles.highest.comparePositionTo(target.member.roles.highest) <= 0
      ) {
        return message.reply({
          content: "You can't strike someone with the same or a higher role than you.",
          allowedMentions: noPing,
        });
      }

      const entry = strikeEntry(message.guild.id, target.id);
      entry.count = Math.min(entry.count + 1, STRIKE_MAX);
      const reason = (target.reason || "No reason provided").slice(0, 300);
      strikeSave();

      let text = `❌ - <@${target.id}> has been **STRIKED ${entry.count}/${STRIKE_MAX}** due to **${reason}** - ❌`;

      // Max strikes reached -> timeout
      if (entry.count >= STRIKE_MAX) {
        if (target.member?.moderatable) {
          await target.member.timeout(
            STRIKE_TIMEOUT_HOURS * 60 * 60 * 1000,
            `Reached ${STRIKE_MAX}/${STRIKE_MAX} strikes`
          );
          text += `\n⏳ <@${target.id}> has been timed out for ${STRIKE_TIMEOUT_HOURS} hour(s).`;
        } else {
          text += "\n⚠️ Could not apply the timeout (missing permission or the user's role is above mine).";
        }
      }

      const sent = await strikeChannel.send({
        content: text,
        allowedMentions: { parse: [], users: [target.id] }, // pings only the striked user
      });

      entry.messages.push(sent.id);
      entry.messages = entry.messages.slice(-STRIKE_MAX);
      strikeSave();

      await message.react("✅").catch(() => {});
      return;
    }

    // ======================= !revoke =======================
    const entry = strikeData[message.guild.id]?.[target.id];
    if (!entry || entry.count <= 0) {
      return message.reply({
        content: `<@${target.id}> has no strikes.`,
        allowedMentions: noPing,
      });
    }

    const wasMax = entry.count >= STRIKE_MAX;
    entry.count -= 1;
    const lastMessageId = entry.messages.pop();
    strikeSave();

    // Reply "REVOKED" to the original strike message (fallback: a normal message)
    const original = lastMessageId
      ? await strikeChannel.messages.fetch(lastMessageId).catch(() => null)
      : null;
    if (original) {
      await original.reply({ content: "REVOKED", allowedMentions: noPing });
    } else {
      await strikeChannel.send({
        content: `✅ - <@${target.id}> had a strike **REVOKED** - ✅`,
        allowedMentions: noPing,
      });
    }

    // Lift the timeout if the user dropped below max strikes
    let extra = "";
    if (
      STRIKE_REMOVE_TIMEOUT_ON_REVOKE &&
      wasMax &&
      target.member?.isCommunicationDisabled?.()
    ) {
      await target.member
        .timeout(null, "Strike revoked")
        .then(() => (extra = " The timeout was removed."))
        .catch(() => {});
    }

    return message.reply({
      content: `Strike revoked. <@${target.id}> is now at ${entry.count}/${STRIKE_MAX}.${extra}`,
      allowedMentions: noPing,
    });
  } catch (err) {
    console.error("[strike] Error:", err);
    return message
      .reply({ content: "Something went wrong. Check the console.", allowedMentions: noPing })
      .catch(() => {});
  }
});


// ============================================================================
// OWNER-ONLY SAY
// ============================================================================

const SAY_ALLOWED_IDS = ["1287748245241729026", "497757753243205642"];
const SAY_ALLOW_EVERYONE_PING = false; // true = @everyone / @here in your text will really ping

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!/^!say(\s|$)/i.test(message.content)) return;
  if (!SAY_ALLOWED_IDS.includes(message.author.id)) return; // everyone else: no reaction at all

  

  let text = message.content.replace(/^!say\s*/i, "");
  let channel = message.channel;
  let targetChosen = false;

  // Optional channel at the start: #channel mention or a plain channel ID
  const m = text.match(/^(?:<#(\d{17,20})>|(\d{17,20}))\s*([\s\S]*)$/);
  if (m) {
    const found = await client.channels.fetch(m[1] || m[2]).catch(() => null);
    if (!found || !found.isTextBased()) {
      return message.reply("I can't find that channel, or I can't see it.").catch(() => {});
    }
    channel = found;
    text = m[3];
    targetChosen = true;
  }

  // In DMs a target channel is required (otherwise the bot would just talk to itself)
  if (!message.guild && !targetChosen) {
    return message.reply("In DMs use: `!say #channel your message` (or a channel ID).").catch(() => {});
  }

  const files = [...message.attachments.values()].map((a) => a.url);
  if (!text.trim() && files.length === 0) {
    return message
      .reply("Usage: `!say your message` or `!say #channel your message`")
      .catch(() => {});
  }

  // If your !say is a reply to a message (same channel), the bot replies to it too
  const replyId =
    message.reference?.messageId && channel.id === message.channel.id
      ? message.reference.messageId
      : null;

  try {
    await channel.send({
      content: text.trim() || undefined,
      files,
      allowedMentions: {
        parse: SAY_ALLOW_EVERYONE_PING ? ["users", "roles", "everyone"] : ["users", "roles"],
      },
      reply: replyId ? { messageReference: replyId, failIfNotExists: false } : undefined,
    });

    if (message.guild) await message.delete().catch(() => {});
    else await message.react("✅").catch(() => {});
  } catch (err) {
    console.error("[say] Could not send:", err.message);
    message
      .reply(`Could not send the message: ${err.message}`.slice(0, 1900))
      .catch(() => {});
  }
});
client.once(discord.Events.ClientReady, async () => {
  try {
    // global command (no guild ID) -> this is what gives the badge
    await client.application.commands.create({
      name: "ping",
      description: "Check if the bot is online",
    });
  } catch (err) {
    console.error("Could not register /ping:", err);
  }
});

client.on(discord.Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "ping") {
    await interaction.reply({ content: `Pong! ${client.ws.ping}ms`, flags: 64 });
  }
});
// ============================================================================
// LFG AUTO-REPLY  -  paste this whole block into your index.js
//
// WHERE: below your client setup and above the "// ==== Login ====" section
// NEEDS: `discord` and `client` (you already have both) + the Message Content
//        intent you already use
// BOT PERMISSIONS (in the channels where it should answer): View Channel,
//        Send Messages, Read Message History
//
// When someone writes things like "lfg", "lfd", "lf duo", "looking for a team",
// "need a 5th" or "anyone wanna play", the bot replies and points to your
// looking-for-group channel.
// ============================================================================

// ---- Settings --------------------------------------------------------------
const LFG_CHANNEL_ID = "1553122342148907180"; // the channel where people should search for teammates
const LFG_REPLY = "Looking for teammates? Head over to {channel} to find players! "; // {channel} = the channel mention
const LFG_USER_COOLDOWN_SEC = 10; // the same person only gets one reply per 5 minutes
const LFG_CHANNEL_COOLDOWN_SEC = 60; // and each channel only one reply per minute
const LFG_DELETE_REPLY_AFTER_SEC = 0; // 0 = keep the reply, e.g. 60 = delete it after a minute
const LFG_IGNORE_CHANNEL_IDS = []; // extra channels where the bot should stay quiet
const LFG_MATCH_ANY_LOOKING_FOR = false; // true = EVERY "looking for ..." triggers it (more false alarms)

// ---- What counts as a match (edit freely) -----------------------------------
const LFG_PLAYERS =
  "(?:group|team|duo|trio|squad|party|players?|teammates?|mates|people|stack|scrims?|friends?|someone to play|anyone to play)";

const LFG_PATTERNS = [
  /\blf[gdm]\b/i, // lfg, lfd, lfm
  new RegExp(`\\blf\\s?(?:\\d|duo|trio|team|group|squad|players?)\\b`, "i"), // lf duo, lf 2, lf team
  new RegExp(
    `\\blooking\\s+for\\s+(?:a\\s+|an\\s+|some\\s+|more\\s+|the\\s+)?(?:\\d+\\s+)?${LFG_PLAYERS}`,
    "i"
  ), // looking for a team / more players / a duo
  new RegExp(
    `\\bneed\\s+(?:a\\s+|an\\s+|some\\s+|more\\s+)?(?:\\d+(?:st|nd|rd|th)?\\s+)?(?:duo|trio|team|squad|players?|teammates?|mates|\\d(?:st|nd|rd|th))\\b`,
    "i"
  ), // need a duo / need a 5th
  /\banyone\s+(?:wanna|want\s+to|down\s+to|up\s+to|wants\s+to)\s+(?:play|queue|run|duo)\b/i, // anyone wanna play
];
if (LFG_MATCH_ANY_LOOKING_FOR) LFG_PATTERNS.push(/\blooking\s+for\b/i);

function lfgMatches(text) {
  return LFG_PATTERNS.some((p) => p.test(text));
}

// ---- Handler ---------------------------------------------------------------
const lfgUserLast = new Map(); // userId -> timestamp
const lfgChannelLast = new Map(); // channelId -> timestamp

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  if (LFG_CHANNEL_ID === "YOUR_LFG_CHANNEL_ID") return; // not configured yet
  if (message.channel.id === LFG_CHANNEL_ID) return; // already in the right place
  if (LFG_IGNORE_CHANNEL_IDS.includes(message.channel.id)) return;

  const text = message.content;
  if (!text || text.startsWith("!") || text.startsWith("/")) return; // ignore commands
  if (!lfgMatches(text)) return;

  // Cooldowns, so the bot never spams
  const now = Date.now();
  if (now - (lfgUserLast.get(message.author.id) || 0) < LFG_USER_COOLDOWN_SEC * 1000) return;
  if (now - (lfgChannelLast.get(message.channel.id) || 0) < LFG_CHANNEL_COOLDOWN_SEC * 1000) return;
  lfgUserLast.set(message.author.id, now);
  lfgChannelLast.set(message.channel.id, now);

  try {
    const sent = await message.reply({
      content: LFG_REPLY.replace("{channel}", `<#${LFG_CHANNEL_ID}>`),
      allowedMentions: { repliedUser: false },
    });

    if (LFG_DELETE_REPLY_AFTER_SEC > 0) {
      setTimeout(() => sent.delete().catch(() => {}), LFG_DELETE_REPLY_AFTER_SEC * 1000);
    }
  } catch (err) {
    console.error("[lfg] Could not reply:", err.message);
  }
});
// // ============================================================================
// ROBLOX GROUP TOOLS + BLACKLISTS  -  paste this whole block into your index.js
//
// WHERE: below your client setup and above the "// ==== Login ====" section
// NEEDS: `discord` and `client` (you already have both), Node 18+ (fetch)
//
// COMMANDS (staff only, see ROBLOX_STAFF_* below)
//   !accept RobloxName [force]        accept a join request into your group
//   !kick RobloxName [reason]         remove a member from your group
//   !groupcheck RobloxName            list the user's groups that are blacklisted
//   !scan @discorduser                list blacklisted Discord servers the user is in
//   !blacklist group  add 123 456     blacklist Roblox groups by ID (several allowed)
//   !blacklist group  remove 123      remove one
//   !blacklist group  list
//   !blacklist server add 123...      blacklist Discord servers by ID
//   !blacklist server remove 123...
//   !blacklist server list
//   (use "id:12345" instead of a name if you only have the Roblox user ID)
//
// SETUP: see the settings below. !accept needs a Roblox Open Cloud API key,
//        !kick needs the (optional) bot-account cookie, the rest needs nothing.
// ============================================================================

const robloxFs = require("node:fs");
const robloxPath = require("node:path");

// ---- Settings --------------------------------------------------------------
const ROBLOX_GROUP_ID = "61519939"; // the group the bot manages

// Open Cloud API key with Groups -> group:read + group:write for your group
// (create.roblox.com/dashboard/credentials). Needed for !accept.
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY || "BS+gRaqq3ECijDll61PFc0A1SXQasdV6RzzEn46WmFUpkfO/ZXlKaGJHY2lPaUpTVXpJMU5pSXNJbXRwWkNJNkluTnBaeTB5TURJeExUQTNMVEV6VkRFNE9qVXhPalE1V2lJc0luUjVjQ0k2SWtwWFZDSjkuZXlKaGRXUWlPaUpTYjJKc2IzaEpiblJsY201aGJDSXNJbWx6Y3lJNklrTnNiM1ZrUVhWMGFHVnVkR2xqWVhScGIyNVRaWEoyYVdObElpd2lZbUZ6WlVGd2FVdGxlU0k2SWtKVEsyZFNZWEZ4TTBWRGFXcEViR3cyTVZCR1l6QkJNVk5ZVVdGelpGWTJVbnA2Ulc0ME5sZHRSbFZ3YTJaUEx5SXNJbTkzYm1WeVNXUWlPaUkzTnpNNE56azVNRGcwSWl3aVpYaHdJam94TnpreU16STVNemd6TENKcFlYUWlPakUzT1RJek1qVTNPRE1zSW01aVppSTZNVGM1TWpNeU5UYzRNMzAuZGVIVFRjMDBteG1OUHZ2WGwzckZ4aGk2WDJBdklOa214eDY0dTFobFowRXc4UHRkTkJuelBEYzczSXJZZW9Pb2U3M2EtLWtuZ1JxS2NoNlE5RUU0MFhrTE5pelZwbEQtcXpNblRzY1RBUWk0ZVZiUkFlRUZTcUFaRmxUSUFJMmotUElqMWZ2dkJnUUJYYnA4djFycTlwY3VLSi1CZm40S1Y1aHl4WHNKRXpfaGNwSWRlTk5OeDBuZU9PbE55cEF3X0p0Vl83eDdXTnFtdC1PYWV5Q1Z4REpYc3FfSmZKXzgzbDdqa1ItdEtxWmNMQURzTHZtbUtmakZKRnh6dW1DcXN2Zmlyc0kzVzlGTzl4SEVqUTh3Y0dvb25hZnNZS1NubFZ5OUs3QkhRREVmY3YxNXoyeUNNQmZsdGRkOGNUaXNESGZKRW5SOWV1RUtDa01fT2RrVHp3";

// OPTIONAL, only for !kick: the .ROBLOSECURITY cookie of a DEDICATED Roblox bot
// account (never your main account!). Roblox has no API-key way to kick yet.
// Leave empty to disable !kick.
const ROBLOX_COOKIE = process.env.ROBLOX_COOKIE || "";

// Who may use these commands. Use Discord role IDs and/or user IDs (each in quotes!).
// If both lists are empty, nobody can use the commands.
const ROBLOX_STAFF_ROLE_IDS = ["1559307664800878602"]; // Discord role IDs, each in quotes
const ROBLOX_STAFF_USER_IDS = ["1287748245241729026", "550375460974886913", "295939417883934720"]; // Discord user IDs, each in quotes

const ROBLOX_LOG_CHANNEL_ID = ""; // optional: channel where accepts/kicks are logged
const ROBLOX_BLOCK_ACCEPT_IF_BLACKLISTED = true; // !accept refuses blacklisted users unless you add "force"
const ROBLOX_BLACKLIST_FILE = robloxPath.join(__dirname, "roblox_blacklist.json");

// ---- Blacklist storage -----------------------------------------------------
let robloxBlacklist = { groups: {}, servers: {} };
try {
  const saved = JSON.parse(robloxFs.readFileSync(ROBLOX_BLACKLIST_FILE, "utf8"));
  robloxBlacklist = { groups: saved.groups || {}, servers: saved.servers || {} };
} catch {
  /* no blacklist saved yet */
}

function robloxSaveBlacklist() {
  try {
    robloxFs.writeFileSync(ROBLOX_BLACKLIST_FILE, JSON.stringify(robloxBlacklist, null, 2));
  } catch (err) {
    console.error("[roblox] Could not save blacklist:", err.message);
  }
}

// ---- Roblox helpers --------------------------------------------------------
const ROBLOX_UA = "Mozilla/5.0 (compatible; GroupToolsBot/1.0)";

async function robloxJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { "User-Agent": ROBLOX_UA, ...(options.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  return { res, data };
}

const ROBLOX_RATE_LIMIT_MSG = "Roblox is rate limiting me right now. Try again in a minute.";

// "Name" or "id:12345" -> { id, name } (or null if not found)
async function robloxGetUser(input) {
  const idMatch = input.match(/^id:(\d{1,15})$/i);
  if (idMatch) {
    const { res, data } = await robloxJson(`https://users.roblox.com/v1/users/${idMatch[1]}`);
    if (res.status === 429) throw new Error(ROBLOX_RATE_LIMIT_MSG);
    return res.ok && data?.id ? { id: String(data.id), name: data.name } : null;
  }

  if (!/^[A-Za-z0-9_]{3,20}$/.test(input)) return null;
  const { res, data } = await robloxJson("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [input], excludeBannedUsers: false }),
  });
  if (res.status === 429) throw new Error(ROBLOX_RATE_LIMIT_MSG);
  const user = data?.data?.[0];
  return user ? { id: String(user.id), name: user.name } : null;
}

// All groups a user is in (what Roblox shows publicly)
async function robloxGetUserGroups(userId) {
  const urls = [
    `https://groups.roblox.com/v2/users/${userId}/groups/roles`,
    `https://groups.roblox.com/v1/users/${userId}/groups/roles`,
  ];
  for (const url of urls) {
    const { res, data } = await robloxJson(url);
    if (res.status === 429) throw new Error(ROBLOX_RATE_LIMIT_MSG);
    if (res.ok && Array.isArray(data?.data)) {
      return data.data.map((e) => ({
        id: String(e.group.id),
        name: e.group.name,
        role: e.role?.name,
      }));
    }
  }
  throw new Error("I couldn't load that user's groups from Roblox.");
}

async function robloxCheckUser(userId) {
  const groups = await robloxGetUserGroups(userId);
  const flagged = groups.filter((g) => robloxBlacklist.groups[g.id]);
  return { groups, flagged };
}

// Accept a join request (Open Cloud, API key)
async function robloxAcceptRequest(userId) {
  const res = await fetch(
    `https://apis.roblox.com/cloud/v2/groups/${ROBLOX_GROUP_ID}/join-requests/${userId}:accept`,
    {
      method: "POST",
      headers: { "x-api-key": ROBLOX_API_KEY, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15000),
    }
  );
  return res;
}

// Kick a member (legacy endpoint, needs the bot account cookie + CSRF token)
let robloxCsrf = "";
async function robloxExile(userId) {
  const url = `https://groups.roblox.com/v1/groups/${ROBLOX_GROUP_ID}/users/${userId}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        Cookie: `.ROBLOSECURITY=${ROBLOX_COOKIE}`,
        "X-CSRF-TOKEN": robloxCsrf,
        "Content-Type": "application/json",
        "User-Agent": ROBLOX_UA,
      },
      signal: AbortSignal.timeout(15000),
    });
    const newToken = res.headers.get("x-csrf-token");
    if (res.status === 403 && newToken && attempt === 0) {
      robloxCsrf = newToken; // Roblox hands out a fresh token on the first try
      continue;
    }
    return res;
  }
}

async function robloxReadError(res) {
  try {
    const data = await res.json();
    return data?.errors?.[0]?.message || data?.message || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

// ---- Discord helpers -------------------------------------------------------
function robloxIsStaff(member) {
  if (!member) return false;
  return (
    ROBLOX_STAFF_USER_IDS.includes(member.id) ||
    ROBLOX_STAFF_ROLE_IDS.some((id) => member.roles.cache.has(id))
  );
}

async function robloxLog(text) {
  if (!ROBLOX_LOG_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(ROBLOX_LOG_CHANNEL_ID);
    if (channel?.isTextBased()) {
      await channel.send({ content: text.slice(0, 1900), allowedMentions: { parse: [] } });
    }
  } catch (err) {
    console.warn("[roblox] Could not write to log channel:", err.message);
  }
}

function robloxListLines(map, emptyText) {
  const entries = Object.entries(map);
  if (entries.length === 0) return emptyText;
  let out = "";
  for (const [id, v] of entries) {
    const line = `• **${v.name || "Unknown"}** - \`${id}\`\n`;
    if (out.length + line.length > 3800) return out + "...and more";
    out += line;
  }
  return out;
}

const ROBLOX_PROFILE = (id) => `https://www.roblox.com/users/${id}/profile`;

// ---- Command handler -------------------------------------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const m = message.content.match(/^!(accept|kick|groupcheck|scan|blacklist)(?:\s+([\s\S]*))?$/i);
  if (!m) return;

  const cmd = m[1].toLowerCase();
  const args = (m[2] || "").trim().split(/\s+/).filter(Boolean);
  const say = (content) =>
    message.reply({ content, allowedMentions: { parse: [], repliedUser: false } });

  if (!robloxIsStaff(message.member)) {
    return say("You don't have permission to use this command.");
  }

  const groupConfigured = /^\d+$/.test(ROBLOX_GROUP_ID); // a real group ID is just digits

  try {
    message.channel.sendTyping?.().catch(() => {});

    // ======================= !accept =======================
    if (cmd === "accept") {
      if (!args[0]) return say("Usage: `!accept RobloxName` (add `force` to skip the blacklist check)");
      if (!groupConfigured || !ROBLOX_API_KEY || ROBLOX_API_KEY.startsWith("YOUR_")) {
        return say("Set `ROBLOX_GROUP_ID` and `ROBLOX_API_KEY` in the code first.");
      }

      const force = args[1]?.toLowerCase() === "force";
      const user = await robloxGetUser(args[0]);
      if (!user) return say("I can't find that Roblox user.");

      if (ROBLOX_BLOCK_ACCEPT_IF_BLACKLISTED && !force) {
        const { flagged } = await robloxCheckUser(user.id);
        if (flagged.length > 0) {
          const names = flagged.map((g) => `${g.name} (${g.id})`).join(", ");
          return say(
            `🚫 **${user.name}** is in blacklisted group(s): ${names}\nNot accepted. Use \`!accept ${user.name} force\` to accept anyway.`
          );
        }
      }

      const res = await robloxAcceptRequest(user.id);
      if (res.ok) {
        await robloxLog(`✅ ${message.author.tag} accepted **${user.name}** (${user.id}) into the group.`);
        return say(`✅ **${user.name}** was accepted into the group.`);
      }
      if (res.status === 404) return say(`**${user.name}** has no pending join request.`);
      if (res.status === 401 || res.status === 403) {
        return say("Roblox refused it. Check the API key (needs group:write for this group) and that its owner may accept join requests.");
      }
      if (res.status === 429) return say(ROBLOX_RATE_LIMIT_MSG);
      return say(`Roblox error: ${await robloxReadError(res)}`);
    }

    // ======================= !kick =========================
    if (cmd === "kick") {
      if (!args[0]) return say("Usage: `!kick RobloxName [reason]`");
      if (!groupConfigured) return say("Set `ROBLOX_GROUP_ID` in the code first.");
      if (!ROBLOX_COOKIE) {
        return say("`!kick` is not set up (no bot account cookie). See `ROBLOX_COOKIE` in the code.");
      }

      const reason = args.slice(1).join(" ") || "No reason provided";
      const user = await robloxGetUser(args[0]);
      if (!user) return say("I can't find that Roblox user.");

      const res = await robloxExile(user.id);
      if (res.ok) {
        await robloxLog(`👢 ${message.author.tag} kicked **${user.name}** (${user.id}). Reason: ${reason}`);
        return say(`👢 **${user.name}** was removed from the group. Reason: ${reason}`);
      }
      if (res.status === 401) return say("The bot account's cookie is invalid or expired. Get a new one.");
      if (res.status === 403) return say("Roblox refused it. The bot account needs the 'Remove members' permission and a higher rank than the target.");
      if (res.status === 429) return say(ROBLOX_RATE_LIMIT_MSG);
      return say(`Roblox error: ${await robloxReadError(res)}`);
    }

    // ======================= !groupcheck ===================
    if (cmd === "groupcheck") {
      if (!args[0]) return say("Usage: `!groupcheck RobloxName`");
      if (Object.keys(robloxBlacklist.groups).length === 0) {
        return say("There are no blacklisted groups yet. Add some with `!blacklist group add GROUP_ID`.");
      }

      const user = await robloxGetUser(args[0]);
      if (!user) return say("I can't find that Roblox user.");

      const { groups, flagged } = await robloxCheckUser(user.id);
      const embed = new discord.EmbedBuilder()
        .setColor(flagged.length ? 0xe74c3c : 0x2ecc71)
        .setTitle(`Group check: ${user.name}`)
        .setURL(ROBLOX_PROFILE(user.id))
        .setFooter({ text: `Roblox ID ${user.id} - ${groups.length} group(s) checked` });

      if (flagged.length) {
        let desc = `🚫 **${flagged.length} blacklisted group(s) found:**\n`;
        for (const g of flagged) desc += `• **${g.name}** (\`${g.id}\`)${g.role ? ` - role: ${g.role}` : ""}\n`;
        embed.setDescription(desc.slice(0, 4000));
      } else {
        embed.setDescription("✅ Not in any blacklisted group.");
      }
      return message.reply({ embeds: [embed], allowedMentions: { parse: [], repliedUser: false } });
    }

    // ======================= !scan =========================
    if (cmd === "scan") {
      const target =
        message.mentions.users.first() ??
        (args[0] && /^\d{17,20}$/.test(args[0])
          ? await client.users.fetch(args[0]).catch(() => null)
          : null);
      if (!target) return say("Usage: `!scan @user` (or a Discord user ID)");

      const serverIds = Object.keys(robloxBlacklist.servers);
      if (serverIds.length === 0) {
        return say("There are no blacklisted servers yet. Add some with `!blacklist server add SERVER_ID`.");
      }

      const found = [];
      let unchecked = 0;
      for (const id of serverIds) {
        const guild = client.guilds.cache.get(id);
        if (!guild) {
          unchecked++;
          continue;
        }
        const member = await guild.members.fetch(target.id).catch(() => null);
        if (member) found.push({ name: guild.name, id, joined: member.joinedTimestamp });
      }

      const embed = new discord.EmbedBuilder()
        .setColor(found.length ? 0xe74c3c : 0x2ecc71)
        .setTitle(`Scan: ${target.tag ?? target.username ?? target.id}`)
        .setFooter({
          text: `Checked ${serverIds.length - unchecked} of ${serverIds.length} blacklisted server(s)` +
            (unchecked ? ` - I'm not a member of ${unchecked}, so I can't see them` : ""),
        });

      if (found.length) {
        let desc = `🚫 **In ${found.length} blacklisted server(s):**\n`;
        for (const f of found) {
          desc += `• **${f.name}** (\`${f.id}\`)${f.joined ? ` - joined <t:${Math.floor(f.joined / 1000)}:R>` : ""}\n`;
        }
        embed.setDescription(desc.slice(0, 4000));
      } else {
        embed.setDescription("✅ Not found in any blacklisted server I can check.");
      }
      return message.reply({ embeds: [embed], allowedMentions: { parse: [], repliedUser: false } });
    }

    // ======================= !blacklist ====================
    if (cmd === "blacklist") {
      const type = args[0]?.toLowerCase();
      const action = args[1]?.toLowerCase();
      const ids = args.slice(2);
      const usage =
        "Usage: `!blacklist group|server add|remove|list [IDs]`\nExample: `!blacklist group add 12345678 23456789`";

      if (!["group", "server"].includes(type) || !["add", "remove", "list"].includes(action)) {
        return say(usage);
      }
      const isGroup = type === "group";
      const store = isGroup ? robloxBlacklist.groups : robloxBlacklist.servers;
      const idPattern = isGroup ? /^\d{1,12}$/ : /^\d{17,20}$/;

      if (action === "list") {
        const embed = new discord.EmbedBuilder()
          .setColor(0x95a5a6)
          .setTitle(`Blacklisted ${isGroup ? "Roblox groups" : "Discord servers"} (${Object.keys(store).length})`)
          .setDescription(robloxListLines(store, "Nothing blacklisted yet."));
        return message.reply({ embeds: [embed], allowedMentions: { parse: [], repliedUser: false } });
      }

      if (ids.length === 0) return say(usage);

      const lines = [];
      for (const id of ids.slice(0, 20)) {
        if (!idPattern.test(id)) {
          lines.push(`❌ \`${id}\` is not a valid ${isGroup ? "group" : "server"} ID`);
          continue;
        }

        if (action === "remove") {
          if (store[id]) {
            lines.push(`🗑️ Removed **${store[id].name || id}**`);
            delete store[id];
          } else {
            lines.push(`⚠️ \`${id}\` was not on the list`);
          }
          continue;
        }

        // add
        if (store[id]) {
          lines.push(`⚠️ **${store[id].name || id}** is already blacklisted`);
          continue;
        }

        let name = "Unknown";
        if (isGroup) {
          const { res, data } = await robloxJson(`https://groups.roblox.com/v1/groups/${id}`);
          if (res.status === 400 || res.status === 404) {
            lines.push(`❌ Group \`${id}\` does not exist`);
            continue;
          }
          if (res.ok && data?.name) name = data.name;
        } else {
          const guild = client.guilds.cache.get(id);
          if (guild) name = guild.name;
        }

        store[id] = { name, addedBy: message.author.id, addedAt: Date.now() };
        lines.push(
          !isGroup && name === "Unknown"
            ? `✅ Added server \`${id}\` (I'm not in it, so \`!scan\` can't check it until I join)`
            : `✅ Added **${name}** (\`${id}\`)`
        );
      }

      robloxSaveBlacklist();
      if (ids.length > 20) lines.push("Only the first 20 IDs were processed.");
      return say(lines.join("\n").slice(0, 1900));
    }
  } catch (err) {
    console.error("[roblox] Error:", err);
    return say(`⚠️ ${err.message || "Something went wrong."}`.slice(0, 1900)).catch(() => {});
  }
});

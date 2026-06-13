const { Client, GatewayIntentBits, EmbedBuilder, ActivityType, AuditLogEvent, PermissionFlagsBits } = require("discord.js");
const fs = require("fs");
 
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildWebhooks,
  ],
});
 
const TOKEN = process.env.TOKEN;
const OWNER_ID = "1509675730022437016";
 
// ── Raid Points ───────────────────────────────────────────
const POINTS_FILE = "./raidpoints.json";
function loadPoints() {
  if (!fs.existsSync(POINTS_FILE)) return {};
  return JSON.parse(fs.readFileSync(POINTS_FILE, "utf8"));
}
function savePoints(data) {
  fs.writeFileSync(POINTS_FILE, JSON.stringify(data, null, 2));
}
 
// ── Anti Raid/Nuke Tracker ────────────────────────────────
const joinTracker = new Map();      // guildId → [timestamps]
const actionTracker = new Map();    // userId → { delChannel, delRole, ban, kick, webhook }
const bannedByBot = new Set();      // verhindert doppelte DMs
 
function getActions(userId) {
  if (!actionTracker.has(userId)) {
    actionTracker.set(userId, { delChannel: 0, createChannel: 0, delRole: 0, createRole: 0, ban: 0, kick: 0, webhook: 0, lastReset: Date.now() });
  }
  const data = actionTracker.get(userId);
  // Reset nach 10 Sekunden
  if (Date.now() - data.lastReset > 10000) {
    actionTracker.set(userId, { delChannel: 0, createChannel: 0, delRole: 0, createRole: 0, ban: 0, kick: 0, webhook: 0, lastReset: Date.now() });
  }
  return actionTracker.get(userId);
}
 
async function punish(guild, userId, reason) {
  if (bannedByBot.has(userId)) return;
  bannedByBot.add(userId);
 
  // Nicht den Owner bannen
  if (userId === OWNER_ID || userId === guild.ownerId) return;
 
  try {
    await guild.members.ban(userId, { reason: `[Anti-Nuke] ${reason}` });
    console.log(`[Anti-Nuke] Banned ${userId} for: ${reason}`);
  } catch (e) {
    console.log(`[Anti-Nuke] Could not ban ${userId}: ${e.message}`);
  }
 
  // DM an Owner
  try {
    const owner = await client.users.fetch(OWNER_ID);
    const embed = new EmbedBuilder()
      .setTitle("🚨 Anti-Raid/Nuke Alert")
      .setColor(0xe74c3c)
      .addFields(
        { name: "Server", value: guild.name },
        { name: "User ID", value: userId },
        { name: "Reason", value: reason },
        { name: "Action", value: "✅ User has been banned" },
      )
      .setTimestamp();
    await owner.send({ embeds: [embed] });
  } catch (e) {
    console.log("[Anti-Nuke] Could not DM owner:", e.message);
  }
}
 
async function getAuditUser(guild, action) {
  try {
    const logs = await guild.fetchAuditLogs({ limit: 1, type: action });
    const entry = logs.entries.first();
    if (!entry) return null;
    if (Date.now() - entry.createdTimestamp > 5000) return null;
    return entry.executor?.id || null;
  } catch {
    return null;
  }
}
 
// ── Voice Status ──────────────────────────────────────────
const MY_GROUP_ID = 1100488023;
const BLACKLISTED_GROUPS = [
  { id: 809253103, name: "YWL" },
  { id: 552901266, name: "Sovereign" },
  { id: 391533223, name: "TERROR" },
  { id: 273443110, name: "KOSW" },
  { id: 15687639, name: "Hexxed" },
  { id: 301480504, name: "Divinek" },
  { id: 96286487, name: "Admirek" },
  { id: 740130810, name: "Stabb" },
  { id: 1021445108, name: "Disaster" },
  { id: 478836785, name: "Slepce" },
  { id: 370588965, name: "Franchisek" },
   { id: 169475628, name: "Snowfall" },
    { id:10475727, name: "Yazu" },
    { id:35914267, name: "Glory" },
];
const PREFIX = "!";
 
function getTotalVoiceMembers() {
  let total = 0;
  for (const guild of client.guilds.cache.values()) {
    for (const vc of guild.channels.cache.filter(c => c.type === 2).values()) {
      total += vc.members.filter(m => !m.user.bot).size;
    }
  }
  return total;
}
 
async function updateStatus() {
  const count = getTotalVoiceMembers();
  await client.user.setActivity(`${count} active users in vcs`, { type: ActivityType.Playing });
}
 
// ── Events ────────────────────────────────────────────────
 
client.once("ready", () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
  updateStatus();
  setInterval(updateStatus, 30000);
});
 
client.on("voiceStateUpdate", () => updateStatus());
 
// Raid: Viele Joins in kurzer Zeit
client.on("guildMemberAdd", async (member) => {
  const guild = member.guild;
 
  // Neue Accounts (unter 7 Tage alt)
  const accountAge = Date.now() - member.user.createdTimestamp;
  const sevenDays = 2 * 24 * 60 * 60 * 1000;
  if (accountAge < sevenDays) {
    await punish(guild, member.id, `New account joined (account age: ${Math.floor(accountAge / 86400000)} days)`);
    return;
  }
 
  // Viele Joins in kurzer Zeit
  if (!joinTracker.has(guild.id)) joinTracker.set(guild.id, []);
  const joins = joinTracker.get(guild.id);
  joins.push(Date.now());
  const recent = joins.filter(t => Date.now() - t < 10000);
  joinTracker.set(guild.id, recent);
 
  if (recent.length >= 5) {
    await punish(guild, member.id, `Mass join detected (${recent.length} joins in 10 seconds)`);
  }
});
 
// Nuke: Channel gelöscht
client.on("channelDelete", async (channel) => {
  const guild = channel.guild;
  if (!guild) return;
  const userId = await getAuditUser(guild, AuditLogEvent.ChannelDelete);
  if (!userId || userId === OWNER_ID || userId === guild.ownerId || userId === client.user.id) return;
  const actions = getActions(userId);
  actions.delChannel++;
  if (actions.delChannel >= 3) {
    await punish(guild, userId, `Mass channel deletion (${actions.delChannel} channels deleted rapidly)`);
  }
});
 
// Nuke: Channel erstellt
client.on("channelCreate", async (channel) => {
  const guild = channel.guild;
  if (!guild) return;
  const userId = await getAuditUser(guild, AuditLogEvent.ChannelCreate);
  if (!userId || userId === OWNER_ID || userId === guild.ownerId || userId === client.user.id) return;
  const actions = getActions(userId);
  actions.createChannel++;
  if (actions.createChannel >= 5) {
    await punish(guild, userId, `Mass channel creation (${actions.createChannel} channels created rapidly)`);
  }
});
 
// Nuke: Rolle gelöscht
client.on("roleDelete", async (role) => {
  const guild = role.guild;
  const userId = await getAuditUser(guild, AuditLogEvent.RoleDelete);
  if (!userId || userId === OWNER_ID || userId === guild.ownerId || userId === client.user.id) return;
  const actions = getActions(userId);
  actions.delRole++;
  if (actions.delRole >= 3) {
    await punish(guild, userId, `Mass role deletion (${actions.delRole} roles deleted rapidly)`);
  }
});
 
// Nuke: Rolle erstellt
client.on("roleCreate", async (role) => {
  const guild = role.guild;
  const userId = await getAuditUser(guild, AuditLogEvent.RoleCreate);
  if (!userId || userId === OWNER_ID || userId === guild.ownerId || userId === client.user.id) return;
  const actions = getActions(userId);
  actions.createRole++;
  if (actions.createRole >= 5) {
    await punish(guild, userId, `Mass role creation (${actions.createRole} roles created rapidly)`);
  }
});
 
// Nuke: Massenban
client.on("guildBanAdd", async (ban) => {
  const guild = ban.guild;
  const userId = await getAuditUser(guild, AuditLogEvent.MemberBanAdd);
  if (!userId || userId === OWNER_ID || userId === guild.ownerId || userId === client.user.id) return;
  const actions = getActions(userId);
  actions.ban++;
  if (actions.ban >= 3) {
    await punish(guild, userId, `Mass ban detected (${actions.ban} bans in 10 seconds)`);
  }
});
 
// Nuke: Massenkick
client.on("guildMemberRemove", async (member) => {
  const guild = member.guild;
  const userId = await getAuditUser(guild, AuditLogEvent.MemberKick);
  if (!userId || userId === OWNER_ID || userId === guild.ownerId || userId === client.user.id) return;
  const actions = getActions(userId);
  actions.kick++;
  if (actions.kick >= 3) {
    await punish(guild, userId, `Mass kick detected (${actions.kick} kicks in 10 seconds)`);
  }
});
 
// Webhook erstellt
client.on("webhooksUpdate", async (channel) => {
  const guild = channel.guild;
  if (!guild) return;
  const userId = await getAuditUser(guild, AuditLogEvent.WebhookCreate);
  if (!userId || userId === OWNER_ID || userId === guild.ownerId || userId === client.user.id) return;
  const actions = getActions(userId);
  actions.webhook++;
  if (actions.webhook >= 2) {
    await punish(guild, userId, `Suspicious webhook creation (${actions.webhook} webhooks created rapidly)`);
  }
});
 
// ── Commands ──────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;
 
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
 
  // !DM RAID
  if (command === "dm" && args[0]?.toUpperCase() === "RAID") {
    if (!message.member.permissions.has("Administrator")) {
      return message.reply("❗ You don't have permission to use this command!");
    }
    const raidRole = message.guild.roles.cache.get("1512569586829103204");
    if (!raidRole) return message.reply("❗ Role not found on this server!");
    const raidMessage = "THERES A RAID GOING ON IN discord.gg/worsek RIGHT NOW CHECK IT UP GO GO GO GO";
    let sent = 0, failed = 0;
    await message.reply("📨 Sending DMs...");
    for (const [, member] of raidRole.members) {
      try { await member.send(raidMessage); sent++; } catch { failed++; }
    }
    return message.channel.send(`✅ Done! **${sent}** DMs sent, **${failed}** failed.`);
  }
 
  // !addpoints @User <amount>
  if (command === "addpoints") {
    if (!message.member.permissions.has("Administrator")) {
      return message.reply("❗ You don't have permission to use this command!");
    }
    const target = message.mentions.members.first();
    const amount = parseInt(args[1]);
    if (!target) return message.reply("❗ Please mention a user! Example: `!addpoints @User 10`");
    if (isNaN(amount) || amount <= 0) return message.reply("❗ Please provide a valid number!");
    const points = loadPoints();
    points[target.id] = (points[target.id] || 0) + amount;
    savePoints(points);
    return message.reply(`✅ Added **${amount}** raid points to **${target.user.username}**! They now have **${points[target.id]}** points.`);
  }
 
  // !points @User
  if (command === "points") {
    const target = message.mentions.members.first() || message.member;
    const points = loadPoints();
    const userPoints = points[target.id] || 0;
    const embed = new EmbedBuilder()
      .setTitle("🏆 Raid Points")
      .setColor(0xf39c12)
      .setDescription(`**${target.user.username}** has **${userPoints}** raid points.`)
      .setThumbnail(target.user.displayAvatarURL())
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }
 
  // !groupcheck
  if (command !== "groupcheck") return;
  const username = args[0];
  if (!username) return message.reply("❗ Please provide a Roblox username! Example: `!groupcheck Username`");
 
  try {
    const userRes = await fetch(`https://users.roblox.com/v1/usernames/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
    });
    const userData = await userRes.json();
    if (!userData.data || userData.data.length === 0) return message.reply(`❗ Roblox user **${username}** was not found.`);
 
    const userId = userData.data[0].id;
    const displayName = userData.data[0].name;
 
    const groupsRes = await fetch(`https://groups.roblox.com/v2/users/${userId}/groups/roles`);
    const groupsData = await groupsRes.json();
    const groups = groupsData.data || [];
 
    let groupLines = [], hasBlacklisted = false, inMyGroup = false;
    for (const entry of groups) {
      const g = entry.group;
      const isBlacklisted = BLACKLISTED_GROUPS.some((bl) => bl.id === g.id);
      const isMyGroup = g.id === MY_GROUP_ID;
      if (isMyGroup) { inMyGroup = true; groupLines.push(`✅ **${g.name}** *(your group)*`); }
      else if (isBlacklisted) { hasBlacklisted = true; groupLines.push(`❌ **${g.name}** *(must be left)*`); }
      else { groupLines.push(`• ${g.name}`); }
    }
    if (groupLines.length === 0) groupLines.push("*No groups found*");
 
    const avatarRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png`);
    const avatarData = await avatarRes.json();
    const avatarUrl = avatarData.data?.[0]?.imageUrl || null;
 
    let statusText;
    if (inMyGroup && !hasBlacklisted) statusText = "✅ Can be verified";
    else if (hasBlacklisted) statusText = "❌ Must leave blacklisted groups first";
    else statusText = "⚠️ Not in your group yet";
 
    const embed = new EmbedBuilder()
      .setTitle("Group Checker")
      .setColor(hasBlacklisted ? 0xe74c3c : inMyGroup ? 0x2ecc71 : 0xf39c12)
      .setDescription(`**[${displayName}](https://www.roblox.com/users/${userId}/profile)**\nGroups found:`)
      .addFields(
        { name: "Groups", value: groupLines.join("\n").slice(0, 1024) },
        { name: "Status", value: statusText }
      )
      .setFooter({ text: "Page (1/1)" })
      .setTimestamp();
    if (avatarUrl) embed.setThumbnail(avatarUrl);
    await message.reply({ embeds: [embed] });
  } catch (err) {
    console.error(err);
    message.reply("❗ An error occurred. Please try again.");
  }
});
 
client.login(TOKEN);

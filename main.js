const { Client, GatewayIntentBits, EmbedBuilder, ActivityType } = require("discord.js");
 
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});
 
const TOKEN = process.env.TOKEN;
 
// ✅ Your own group (always gets a green checkmark)
const MY_GROUP_ID = 1100488023;
 
// ❌ Blacklisted groups (these must be left to get verified)
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
];
 
const PREFIX = "!";
 
// ── Voice Status ──────────────────────────────────────────
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
  await client.user.setActivity(`${count} active users in vcs`, {
    type: ActivityType.Playing,
  });
  console.log(`[VoiceStatus] Updated: ${count} active users in vcs`);
}
// ─────────────────────────────────────────────────────────
 
client.once("ready", () => {
  console.log(`✅ Bot is online as ${client.user.tag}`);
  updateStatus();
  setInterval(updateStatus, 30000);
});
 
client.on("voiceStateUpdate", () => updateStatus());
 
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;
 
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
 
  if (command !== "groupcheck") return;
 
  const username = args[0];
  if (!username) {
    return message.reply("❗ Please provide a Roblox username! Example: `!groupcheck Username`");
  }
 
  try {
    const userRes = await fetch(
      `https://users.roblox.com/v1/usernames/users`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
      }
    );
    const userData = await userRes.json();
 
    if (!userData.data || userData.data.length === 0) {
      return message.reply(`❗ Roblox user **${username}** was not found.`);
    }
 
    const userId = userData.data[0].id;
    const displayName = userData.data[0].name;
 
    const groupsRes = await fetch(
      `https://groups.roblox.com/v2/users/${userId}/groups/roles`
    );
    const groupsData = await groupsRes.json();
    const groups = groupsData.data || [];
 
    let groupLines = [];
    let hasBlacklisted = false;
    let inMyGroup = false;
 
    for (const entry of groups) {
      const g = entry.group;
      const isBlacklisted = BLACKLISTED_GROUPS.some((bl) => bl.id === g.id);
      const isMyGroup = g.id === MY_GROUP_ID;
 
      if (isMyGroup) {
        inMyGroup = true;
        groupLines.push(`✅ **${g.name}** *(your group)*`);
      } else if (isBlacklisted) {
        hasBlacklisted = true;
        groupLines.push(`❌ **${g.name}** *(must be left)*`);
      } else {
        groupLines.push(`• ${g.name}`);
      }
    }
 
    if (groupLines.length === 0) {
      groupLines.push("*No groups found*");
    }
 
    const avatarRes = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png`
    );
    const avatarData = await avatarRes.json();
    const avatarUrl = avatarData.data?.[0]?.imageUrl || null;
 
    let statusText;
    if (inMyGroup && !hasBlacklisted) {
      statusText = "✅ Can be verified";
    } else if (hasBlacklisted) {
      statusText = "❌ Must leave blacklisted groups first";
    } else {
      statusText = "⚠️ Not in your group yet";
    }
 
    const embed = new EmbedBuilder()
      .setTitle(`Group Checker`)
      .setColor(hasBlacklisted ? 0xe74c3c : inMyGroup ? 0x2ecc71 : 0xf39c12)
      .setDescription(
        `**[${displayName}](https://www.roblox.com/users/${userId}/profile)**\nGroups found:`
      )
      .addFields(
        { name: "Groups", value: groupLines.join("\n").slice(0, 1024) },
        { name: "Status", value: statusText }
      )
      .setFooter({ text: `Page (1/1)` })
      .setTimestamp();
 
    if (avatarUrl) embed.setThumbnail(avatarUrl);
 
    await message.reply({ embeds: [embed] });
  } catch (err) {
    console.error(err);
    message.reply("❗ An error occurred. Please try again.");
  }
});
 
client.login(TOKEN);
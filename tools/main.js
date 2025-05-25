const fs = require('fs');
const path = require('path');

const userFile = path.join(__dirname, '..', 'data', 'users.json');

function loadUserData() {
  if (!fs.existsSync(userFile)) return {};
  return JSON.parse(fs.readFileSync(userFile, 'utf-8'));
}

function saveUserData(data) {
  fs.writeFileSync(userFile, JSON.stringify(data, null, 2));
}

async function ensureFollowed(ctx, channel) {
  try {
    const res = await ctx.telegram.getChatMember(channel, ctx.from.id);

    const allowedStatuses = ['member', 'administrator', 'creator'];
    return allowedStatuses.includes(res.status);
  } catch (err) {
    console.error("Follow check failed:", err.message);
    return false;
  }
}

module.exports = { loadUserData, saveUserData, ensureFollowed };

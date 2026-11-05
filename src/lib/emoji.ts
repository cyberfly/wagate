/** A compact emoji set by category, for the composer and reactions. */
const sets: [string, string][] = [
  ["Smileys", "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖"],
  ["Gestures", "👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🫶 👀 🧠 🫡 🤷 🙋 🙇 🤦"],
  ["Hearts", "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ✨ ⭐ 🌟 💫 🔥 💯 ✅ ❌ ❗ ❓ ⚠️ 🎉 🎊 🎁 🏆 🥇"],
  ["Nature & food", "🌞 🌙 ⛅ 🌧️ ⚡ ❄️ 🌈 🌸 🌹 🌻 🌴 🍀 🐶 🐱 🐼 🦁 🐔 🐟 🦋 🍎 🍌 🍉 🍇 🍓 🥭 🥥 🍞 🍔 🍟 🍕 🍜 🍛 🍣 🍰 🎂 🍫 ☕ 🍵 🧋 🥤"],
  ["Activities & objects", "⚽ 🏀 🏸 🎮 🎯 🎵 🎶 🎤 🎧 📷 🎥 📱 💻 ⌨️ 🖥️ 📞 ⏰ 📅 📌 📎 ✏️ 📝 📚 📖 💡 🔑 🔒 💰 💳 🛒 🎓 💼 🚗 ✈️ 🏠 🕌 🏢 🗓️ 📈 📊"],
];
export const emojiCategories = sets.map(([name, list]) => ({ name, emoji: list.split(" ") }));

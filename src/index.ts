import 'dotenv/config';

import { startBot } from './telegram/bot.js';
import { startServer } from './server/http.js';

async function main() {
  // 启动 Telegram 机器人与 HTTP 服务，保持二者同进程运行。
  // await startBot();
  // await startServer();
  // 先起 HTTP，保证 /health 可用
  try {
    await startServer(); // 内部需绑定 '0.0.0.0' 并打印端口日志
  } catch (e) {
    console.error('HTTP start failed:', e);
  }

  // 再起 bot；即使失败也不要退出整个进程（不要 process.exit）
  try {
    await startBot();
  } catch (e) {
    console.error('Bot start failed:', e);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

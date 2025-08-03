import { chromium, BrowserContext } from 'playwright';

async function main() {
  const STORAGE_PATH = process.env.PW_STORAGE_STATE_PATH || 'scripts/x/storageState.json';

  const browser = await chromium.launch({ headless: false });
  const context: BrowserContext = await browser.newContext();
  const page = await context.newPage();

  console.log('X(旧Twitter)のログインページを開きます...');
  await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded' });

  console.log('ブラウザで手動ログインしてください。ログイン完了後、ホームタイムラインが表示されたら、このターミナルにフォーカスして Enter を押してください。');
  await waitForEnter('ログインが完了したら Enter を押す → ');

  // 現在のストレージ状態を保存
  await context.storageState({ path: STORAGE_PATH });
  console.log(`ログイン状態を保存しました: ${STORAGE_PATH}`);

  await browser.close();
}

function waitForEnter(promptMsg: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(promptMsg);
    process.stdin.setEncoding('utf8');
    const onData = () => {
      process.stdin.off('data', onData);
      resolve();
    };
    process.stdin.on('data', onData);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
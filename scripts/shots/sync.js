// 设备与同步 after syncing with the iPhone (the shell is mocked by _bridge.js).
await go('#/sync');
for (let i = 0; i < 100 && !document.querySelector('[data-sync=go][data-peer=ip]'); i++) await new Promise((r) => setTimeout(r, 50));
document.querySelector('[data-sync=go][data-peer=ip]').click();

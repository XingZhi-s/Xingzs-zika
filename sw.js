/* 星之匙 Service Worker
   只做两件事：1) 由页面调用 registration.showNotification 弹系统通知（安卓 Chrome 唯一可靠方式）
               2) 点击通知时聚焦已有窗口并让页面打开对应聊天
   刻意不注册 fetch 事件、不做任何缓存：避免旧缓存挡住后续更新，也不影响完全离线使用。 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const cid = data.cid || '';
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = list.find(c => 'focus' in c) || list[0];
    if (target) {
      await target.focus();
      if (cid) target.postMessage({ type: 'zika-open-chat', cid });
      return;
    }
    // 页面已全部关闭：打开应用；带 chat 参数时启动后直接进入对应聊天
    const url = new URL('index.html' + (cid ? ('?chat=' + encodeURIComponent(cid)) : ''), self.registration.scope).href;
    await self.clients.openWindow(url);
  })());
});

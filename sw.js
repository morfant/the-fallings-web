// 서비스 워커 — Web Push 수신 전용 (2026-08-17).
// fetch 핸들러를 두지 않는다: 페이지·에셋 캐시에 일절 관여하지 않음 (캐시 사고 방지).
// 등록은 subscribe.html(알림 켜기)에서. 푸시 페이로드는 notify_subscribers.mjs가 보낸
// JSON {title, body, url} — url은 그 죽음의 딥링크(#/record/<pid>).

self.addEventListener("push", (event) => {
    let d = {};
    try { d = event.data ? event.data.json() : {}; } catch { /* 형식이 어긋나도 알림은 띄운다 */ }
    event.waitUntil(self.registration.showNotification(d.title || "떨어지고, 끼이고, 깔린", {
        body: d.body || "",
        icon: "img/apple-touch-icon.png",
        badge: "img/favicon.png",
        data: { url: d.url || "./" },
    }));
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || "./";
    event.waitUntil((async () => {
        const wins = await clients.matchAll({ type: "window", includeUncontrolled: true });
        // 이미 열린 창이 있으면 그 창을 딥링크로 이동시켜 재사용 (standalone 앱 포함)
        for (const w of wins) {
            if (new URL(w.url).origin === self.location.origin && "navigate" in w) {
                await w.navigate(url);
                return w.focus();
            }
        }
        return clients.openWindow(url);
    })());
});

// 서비스 워커 — Web Push 수신 전용 (2026-08-17).
// fetch 핸들러를 두지 않는다: 페이지·에셋 캐시에 일절 관여하지 않음 (캐시 사고 방지).
// 등록은 subscribe.html(알림 켜기)에서. 푸시 페이로드는 notify_subscribers.mjs가 보낸
// JSON {title, body, url} — url은 그 죽음의 딥링크(#/record/<pid>).

// 새 버전이 기다리지 않고 바로 활성화되고, 열려 있는 페이지도 즉시 제어한다 —
// 제어 중이어야 notificationclick에서 WindowClient.navigate가 허용된다.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(clients.claim()));

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
    const raw = (event.notification.data && event.notification.data.url) || "./";
    event.waitUntil((async () => {
        const target = new URL(raw, self.location.origin).href;
        const wins = await clients.matchAll({ type: "window", includeUncontrolled: true });
        const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
        if (win) {
            try { await win.focus(); } catch { /* 포커스 실패는 무시하고 계속 */ }
            // 1차: 창을 직접 이동 (전체 리로드 — 딥링크 도착 경험 경로를 탄다).
            // iOS 등에서 비제어 창이면 거부된다 (2026-08-17 실기기: 눌러도 무반응이던 원인).
            try { if (win.navigate) { await win.navigate(target); return; } } catch { /* 아래 폴백 */ }
            // 2차: 페이지에 딥링크를 전달 — index(sketch.js)·subscribe.html의 리스너가 연다
            try { win.postMessage({ type: "open-url", url: target }); return; } catch { /* 아래 폴백 */ }
        }
        await clients.openWindow(target);
    })());
});

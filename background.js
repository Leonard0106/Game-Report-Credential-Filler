// 暫存帳密用 chrome.storage.session（瀏覽器關閉即清除）。
// key 結構：creds_<hostname>
const TTL_MS = 5 * 60 * 1000; // 5 分鐘後視為過期

function hostnameOf(url) {
    try {
        return new URL(url).hostname;
    } catch (e) {
        return null;
    }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'STORE_CREDS') {
        const { targetUrl } = msg.payload || {};
        const host = hostnameOf(targetUrl);
        if (!host) {
            sendResponse({ ok: false, error: 'invalid url' });
            return true;
        }
        const key = 'creds_' + host;
        chrome.storage.session.set({
            [key]: { ...msg.payload, storedAt: Date.now() }
        }, () => sendResponse({ ok: true, host }));
        return true; // async
    }

    if (msg.type === 'GET_CREDS_FOR') {
        const url = (sender && sender.tab && sender.tab.url) || msg.url;
        const host = hostnameOf(url);
        if (!host) {
            sendResponse(null);
            return true;
        }
        const key = 'creds_' + host;
        chrome.storage.session.get(key, (result) => {
            const entry = result[key];
            if (!entry) { sendResponse(null); return; }
            if (Date.now() - entry.storedAt > TTL_MS) {
                chrome.storage.session.remove(key);
                sendResponse(null);
                return;
            }
            sendResponse(entry);
        });
        return true; // async
    }

    if (msg.type === 'CONSUME_CREDS_FOR') {
        // 用完即焚（避免表單有錯誤時重新整理會被二次自動填）
        const url = (sender && sender.tab && sender.tab.url) || msg.url;
        const host = hostnameOf(url);
        if (!host) { sendResponse({ ok: false }); return true; }
        chrome.storage.session.remove('creds_' + host, () => sendResponse({ ok: true }));
        return true;
    }

    if (msg.type === 'LIST_STORED_HOSTS') {
        chrome.storage.session.get(null, (all) => {
            const now = Date.now();
            const hosts = Object.keys(all)
                .filter(k => k.startsWith('creds_'))
                .map(k => ({
                    host: k.substring(6),
                    storedAt: all[k].storedAt,
                    expiresIn: Math.max(0, TTL_MS - (now - all[k].storedAt))
                }));
            sendResponse(hosts);
        });
        return true;
    }
});

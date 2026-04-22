(function () {
    'use strict';

    // 讓網頁端能偵測擴充是否安裝
    try {
        document.documentElement.dataset.grExtension = '1';
    } catch (e) { /* noop */ }

    // ===== 1) 從 game-report 頁面收 postMessage，轉給 background 暫存 =====
    window.addEventListener('message', function (event) {
        if (event.source !== window) return;
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.source !== 'gr-provider-accounts') return;
        if (msg.type !== 'GR_PREPARE_LOGIN') return;

        chrome.runtime.sendMessage({ type: 'STORE_CREDS', payload: msg.payload }, function (res) {
            // console.debug('[gr-ext] stored creds for', res && res.host);
        });
    });

    // ===== 2) 對所有頁面：若 background 裡有本站的暫存帳密，就自動填入 =====
    let filled = false;
    let retries = 0;
    const MAX_RETRIES = 10;

    function setNativeValue(el, value) {
        // 觸發 React/Vue 的 value setter，讓框架偵測到變更
        const tagProto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(tagProto, 'value');
        const setter = desc && desc.set;
        if (setter) {
            setter.call(el, value);
        } else {
            el.value = value;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function isVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        const st = window.getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none';
    }

    function findLoginFields() {
        const passwords = Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible);
        if (passwords.length === 0) return null;
        const pwd = passwords[0];

        // 抓可見的 text/email/空 input 當候選帳號欄（排除密碼本身）
        const all = Array.from(document.querySelectorAll('input')).filter(isVisible);
        const textTypes = new Set(['', 'text', 'email', 'tel', 'search']);

        // 帳號欄：在密碼欄之前最近一個符合的 text 類輸入
        const pwdIdx = all.indexOf(pwd);
        let userInput = null;
        for (let i = pwdIdx - 1; i >= 0; i--) {
            const t = (all[i].type || '').toLowerCase();
            if (textTypes.has(t)) { userInput = all[i]; break; }
        }
        // 找不到往後找
        if (!userInput) {
            for (let i = pwdIdx + 1; i < all.length; i++) {
                const t = (all[i].type || '').toLowerCase();
                if (textTypes.has(t)) { userInput = all[i]; break; }
            }
        }

        // 登錄代號欄：name/id/placeholder 含關鍵字的 text 輸入
        const CODE_RE = /代號|代码|商戶|商户|公司|merchant|company|corp|agent|site ?code|partner|vendor/i;
        let codeInput = null;
        for (const el of all) {
            if (el === userInput || el === pwd) continue;
            const t = (el.type || '').toLowerCase();
            if (!textTypes.has(t)) continue;
            const sig = (el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '');
            if (CODE_RE.test(sig)) { codeInput = el; break; }
        }

        return { userInput, pwd, codeInput };
    }

    function showToast(msg, isError) {
        const div = document.createElement('div');
        div.textContent = (isError ? '⚠ ' : '🔐 ') + msg;
        div.style.cssText = [
            'position:fixed',
            'bottom:20px',
            'right:20px',
            'background:' + (isError ? '#b91c1c' : '#1e293b'),
            'color:white',
            'padding:10px 16px',
            'border-radius:6px',
            'z-index:2147483647',
            'font-size:14px',
            'font-family:-apple-system,Segoe UI,Noto Sans TC,sans-serif',
            'box-shadow:0 4px 12px rgba(0,0,0,0.25)'
        ].join(';');
        document.documentElement.appendChild(div);
        setTimeout(function () { div.remove(); }, 3200);
    }

    function attemptFill() {
        if (filled) return;
        chrome.runtime.sendMessage({ type: 'GET_CREDS_FOR', url: location.href }, function (creds) {
            if (!creds) return;

            const fields = findLoginFields();
            if (!fields) {
                // 還沒有 password 欄（SPA 可能還在載），稍後重試
                if (retries++ < MAX_RETRIES) setTimeout(attemptFill, 500);
                return;
            }

            const { userInput, pwd, codeInput } = fields;

            if (userInput && creds.username) setNativeValue(userInput, creds.username);
            if (pwd && creds.password) setNativeValue(pwd, creds.password);
            if (codeInput && creds.login_code) setNativeValue(codeInput, creds.login_code);

            filled = true;

            // 用完即丟，避免表單出錯重整後被二次填入造成困擾
            chrome.runtime.sendMessage({ type: 'CONSUME_CREDS_FOR', url: location.href });

            const missed = [];
            if (!userInput && creds.username) missed.push('帳號');
            if (codeInput === null && creds.login_code) missed.push('登錄代號');
            if (missed.length) {
                showToast('已自動填入密碼，找不到：' + missed.join('、') + '，請手動貼上');
            } else {
                showToast('已自動填入，請確認後點登入');
            }
        });
    }

    function start() {
        attemptFill();
        // 針對 SPA / 非同步出現的表單：監聽 DOM 變化
        const mo = new MutationObserver(function () {
            if (!filled) attemptFill();
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
        // 安全保險：30 秒後停止觀察
        setTimeout(function () { mo.disconnect(); }, 30000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();

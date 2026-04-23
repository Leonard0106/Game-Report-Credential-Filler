(function () {
    'use strict';

    // 允許發送帳密給擴充的來源（game-report 後台 origin）。
    const GR_ALLOWED_ORIGINS = [
        'https://report.91url.cc',
    ];

    function isAllowedOrigin(origin) {
        return GR_ALLOWED_ORIGINS.indexOf(origin) !== -1;
    }

    // 只在 game-report 自己的頁面上標記擴充已安裝，避免在無關網站留指紋
    if (isAllowedOrigin(location.origin)) {
        try {
            document.documentElement.dataset.grExtension = '1';
        } catch (e) { /* noop */ }
    }

    // ===== 1) 從 game-report 頁面收 postMessage，轉給 background 暫存 =====
    window.addEventListener('message', function (event) {
        if (event.source !== window) return;
        if (!isAllowedOrigin(event.origin)) return;
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.source !== 'gr-provider-accounts') return;
        if (msg.type !== 'GR_PREPARE_LOGIN') return;

        chrome.runtime.sendMessage({ type: 'STORE_CREDS', payload: msg.payload });
    });

    // ===== 2) TOTP（Google 2FA）生成：純前端 Web Crypto + base32 =====
    function base32Decode(input) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        const cleaned = String(input).replace(/[\s=]/g, '').toUpperCase();
        if (!cleaned) throw new Error('TOTP 密鑰為空');
        let bits = 0, value = 0;
        const out = [];
        for (const ch of cleaned) {
            const v = alphabet.indexOf(ch);
            if (v < 0) throw new Error('TOTP 密鑰含非法字元：' + ch);
            value = (value << 5) | v;
            bits += 5;
            if (bits >= 8) {
                out.push((value >>> (bits - 8)) & 0xff);
                bits -= 8;
            }
        }
        return new Uint8Array(out);
    }

    async function generateTOTP(secret, digits, step) {
        digits = digits || 6;
        step = step || 30;
        const key = base32Decode(secret);
        const counter = Math.floor(Date.now() / 1000 / step);
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        // 8-byte big-endian counter
        view.setUint32(0, Math.floor(counter / 0x100000000));
        view.setUint32(4, counter >>> 0);

        const cryptoKey = await crypto.subtle.importKey(
            'raw', key,
            { name: 'HMAC', hash: 'SHA-1' },
            false, ['sign']
        );
        const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, buf));
        const offset = sig[sig.length - 1] & 0x0f;
        const code = (
            ((sig[offset] & 0x7f) << 24) |
            (sig[offset + 1] << 16) |
            (sig[offset + 2] << 8) |
            sig[offset + 3]
        ) % Math.pow(10, digits);
        return code.toString().padStart(digits, '0');
    }

    // ===== 3) 對所有頁面：若 background 裡有本站的暫存帳密，就自動填入 =====
    let retries = 0;
    const MAX_RETRIES = 10;
    const filledFields = { user: false, pwd: false, code: false, totp: false };

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

    function fieldSignature(el) {
        return (el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '') +
            ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('autocomplete') || '');
    }

    const CODE_RE = /代號|代号|代理|子代|上層|上级|商戶|商户|公司|merchant|company|corp|agent|site ?code|partner|vendor/i;
    const TOTP_RE = /2fa|otp|totp|驗證碼|验证码|動態碼|动态码|動態密碼|动态密码|一次性|one.?time.?code|authenticator|auth.?code|security.?code|谷歌.?驗|google.?auth/i;

    function findLoginFields() {
        const all = Array.from(document.querySelectorAll('input')).filter(isVisible);
        const textTypes = new Set(['', 'text', 'email', 'tel', 'search', 'number']);

        // 密碼欄（可能不存在：獨立 2FA 頁）
        const passwords = Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible);
        const pwd = passwords[0] || null;

        // 帳號欄：在密碼欄之前最近一個符合的 text 類輸入；無密碼時 null
        let userInput = null;
        if (pwd) {
            const pwdIdx = all.indexOf(pwd);
            for (let i = pwdIdx - 1; i >= 0; i--) {
                const t = (all[i].type || '').toLowerCase();
                if (textTypes.has(t)) { userInput = all[i]; break; }
            }
            if (!userInput) {
                for (let i = pwdIdx + 1; i < all.length; i++) {
                    const t = (all[i].type || '').toLowerCase();
                    if (textTypes.has(t)) { userInput = all[i]; break; }
                }
            }
        }

        // TOTP 欄：autocomplete=one-time-code 優先，其次關鍵字匹配
        let totpInput = null;
        for (const el of all) {
            if (el === pwd) continue;
            const t = (el.type || '').toLowerCase();
            if (!textTypes.has(t)) continue;
            if ((el.getAttribute('autocomplete') || '').toLowerCase() === 'one-time-code') {
                totpInput = el; break;
            }
        }
        if (!totpInput) {
            for (const el of all) {
                if (el === pwd || el === userInput) continue;
                const t = (el.type || '').toLowerCase();
                if (!textTypes.has(t)) continue;
                if (TOTP_RE.test(fieldSignature(el))) { totpInput = el; break; }
            }
        }

        // 登錄代號欄：name/id/placeholder 含關鍵字的 text 輸入（排除已識別的欄位）
        let codeInput = null;
        for (const el of all) {
            if (el === userInput || el === pwd || el === totpInput) continue;
            const t = (el.type || '').toLowerCase();
            if (!textTypes.has(t)) continue;
            if (CODE_RE.test(fieldSignature(el))) { codeInput = el; break; }
        }

        return { userInput, pwd, codeInput, totpInput };
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

    function consumeCreds() {
        chrome.runtime.sendMessage({ type: 'CONSUME_CREDS_FOR', url: location.href });
    }

    function attemptFill() {
        // 若全部該填的都填了就停
        chrome.runtime.sendMessage({ type: 'GET_CREDS_FOR', url: location.href }, function (creds) {
            if (!creds) return;

            const fields = findLoginFields();
            if (!fields || (!fields.pwd && !fields.totpInput)) {
                // 還沒有任何可辨識的登入欄位，稍後重試
                if (retries++ < MAX_RETRIES) setTimeout(attemptFill, 500);
                return;
            }

            const { userInput, pwd, codeInput, totpInput } = fields;
            const hasTotp = !!creds.totp_secret;
            const filledHere = [];

            if (!filledFields.user && userInput && !userInput.value && creds.username) {
                setNativeValue(userInput, creds.username);
                filledFields.user = true;
                filledHere.push('帳號');
            }
            if (!filledFields.pwd && pwd && !pwd.value && creds.password) {
                setNativeValue(pwd, creds.password);
                filledFields.pwd = true;
                filledHere.push('密碼');
            }
            if (!filledFields.code && codeInput && !codeInput.value && creds.login_code) {
                setNativeValue(codeInput, creds.login_code);
                filledFields.code = true;
                filledHere.push('登錄代號');
            }

            if (!filledFields.totp && totpInput && !totpInput.value && hasTotp) {
                filledFields.totp = true; // 先標記避免重入
                generateTOTP(creds.totp_secret).then(function (code) {
                    setNativeValue(totpInput, code);
                    showToast('已自動填入 2FA（' + code + '），請盡快點登入');
                    // TOTP 填完代表最後一步，用完即焚
                    consumeCreds();
                }).catch(function (err) {
                    filledFields.totp = false; // 還原以利下次重試
                    console.warn('[GR] TOTP 計算失敗', err);
                    showToast('2FA 計算失敗：' + (err && err.message || err), true);
                });
                return; // 非同步流程，交給 then/catch 決定後續
            }

            if (filledHere.length === 0) return;

            // 同步路徑的 toast + consume 判斷：
            // - 有 TOTP 密鑰但本頁沒找到 TOTP 欄 → 保留暫存，等 2FA 獨立頁
            // - 沒有 TOTP 密鑰 → 填完就消耗
            const stillWaitingTotp = hasTotp && !totpInput;
            if (stillWaitingTotp) {
                showToast('已填入 ' + filledHere.join('、') + '，登入後會自動填 2FA');
            } else {
                showToast('已自動填入 ' + filledHere.join('、') + '，請確認後點登入');
                consumeCreds();
            }
        });
    }

    function start() {
        attemptFill();
        // 針對 SPA / 非同步出現的表單：監聽 DOM 變化
        const mo = new MutationObserver(function () {
            attemptFill();
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
        // 安全保險：60 秒後停止觀察（比原本 30 秒長，涵蓋跨頁 2FA 情境）
        setTimeout(function () { mo.disconnect(); }, 60000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
